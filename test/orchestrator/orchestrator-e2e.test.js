/**
 * Orchestrator E2E tests — 실제 fork + 관리 API + 인스턴스 접속 검증
 *
 * 커버하는 시나리오:
 *  OE1.  오케스트레이터 시작 — instances.json 읽고 관리 API 응답
 *  OE2.  인스턴스 fork — autoStart 인스턴스가 실제로 서버 프로세스로 기동
 *  OE3.  인스턴스 헬스 — GET /api/instance 엔드포인트 정상 응답
 *  OE4.  관리 API 목록 — GET /api/instances → 모든 인스턴스 상태 반환
 *  OE5.  인스턴스 중지/시작 — stop → 프로세스 종료, start → 재기동
 *  OE6.  인스턴스 restart — restart 후 서버 정상 응답
 *  OE7.  인스턴스별 독립 세션 — 두 인스턴스에 각각 chat → 독립 응답
 *  OE8.  인스턴스별 설정 분리 — 서로 다른 LLM model 설정 확인
 *  OE9.  disabled 인스턴스 — enabled: false인 인스턴스는 fork 안 됨
 *  OE10. WS 접속 — 인스턴스에 직접 WebSocket 연결 + init 메시지 수신
 */

import http from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebSocket } from 'ws'
import { startOrchestrator } from '@presence/orchestrator'
import { createUserStore } from '@presence/infra/infra/auth-user-store.js'
import { ensureSecret } from '@presence/infra/infra/auth-token.js'
import { assert, summary } from '../lib/assert.js'

// ---------------------------------------------------------------------------
// 공통 헬퍼
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise(r => setTimeout(r, ms))

const createMockLLM = (handler) => {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      calls.push(parsed)
      const response = handler(parsed, calls.length)
      const content = typeof response === 'string' ? response : JSON.stringify(response)
      if (parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content } }] }))
      }
    })
  })
  return {
    calls,
    start: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise(r => server.close(r)),
  }
}

const request = (port, method, path, body, { token } = {}) =>
  new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const headers = {
      'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    }
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }) }
        catch { resolve({ status: res.statusCode, body: buf }) }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })

// 테스트용 로그인 헬퍼 — 인스턴스 포트에서 accessToken 획득
const login = async (port) => {
  const res = await request(port, 'POST', '/api/auth/login', { username: 'testuser', password: 'testpass123' })
  return res.body.accessToken
}

const waitForPort = async (port, { maxMs = 15_000, intervalMs = 300 } = {}) => {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    try {
      const res = await request(port, 'GET', '/api/instance')
      if (res.status === 200) return true
    } catch {}
    await delay(intervalMs)
  }
  return false
}

const connectWS = (port, { token } = {}) =>
  new Promise((resolve, reject) => {
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {}
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
    const messages = []
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())))
    ws.on('open', () => resolve({ ws, messages }))
    ws.on('error', reject)
  })

/**
 * 테스트용 presence 설정 디렉터리 생성
 * - server.json: 공통 설정 (mock LLM 사용)
 * - instances.json: 인스턴스 정의
 * - instances/{id}.json: 인스턴스별 override
 */
const createTestPresenceDir = async (llmPort, { instances, instanceOverrides = {} } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'presence-orch-'))

  // server.json
  writeFileSync(join(dir, 'server.json'), JSON.stringify({
    llm: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: 'test-base', apiKey: 'k', responseFormat: 'json_object', maxRetries: 0, timeoutMs: 5000 },
    embed: { provider: 'openai', baseUrl: null, apiKey: null, model: null, dimensions: 256 },
    locale: 'ko', maxIterations: 5,
    mcp: [],
    scheduler: { enabled: false, pollIntervalMs: 60000, todoReview: { enabled: false, cron: '0 9 * * *' } },
    delegatePolling: { intervalMs: 60000 },
    prompt: { maxContextTokens: 8000, reservedOutputTokens: 1000, maxContextChars: null, reservedOutputChars: null },
  }))

  // instances.json
  writeFileSync(join(dir, 'instances.json'), JSON.stringify({
    orchestrator: { port: 0, host: '127.0.0.1' },
    instances,
  }))

  // instances/*.json + users + secret
  mkdirSync(join(dir, 'instances'), { recursive: true })
  const userSetupPromises = []
  for (const inst of instances) {
    const override = instanceOverrides[inst.id] || {}
    override.memory = override.memory || { path: join(dir, `data-${inst.id}`) }
    writeFileSync(join(dir, 'instances', `${inst.id}.json`), JSON.stringify(override))

    // 각 인스턴스에 테스트 사용자 등록 (인증 필수)
    ensureSecret(inst.id, { basePath: dir })
    const store = createUserStore(inst.id, { basePath: dir })
    userSetupPromises.push(store.addUser('testuser', 'testpass123'))
  }
  await Promise.all(userSetupPromises)

  return dir
}

// ---------------------------------------------------------------------------

async function run() {
  console.log('Orchestrator E2E tests')

  // 포트 할당을 위한 임시 서버 (OS 할당 포트 사용)
  const getFreePorts = async (count) => {
    const ports = []
    for (let i = 0; i < count; i++) {
      const s = http.createServer()
      await new Promise(r => s.listen(0, '127.0.0.1', r))
      ports.push(s.address().port)
      await new Promise(r => s.close(r))
    }
    return ports
  }

  // =========================================================================
  // OE1. 오케스트레이터 시작 — instances.json 읽고 관리 API 응답
  // =========================================================================
  {
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: '응답' }))
    const llmPort = await mockLLM.start()
    const [instPort] = await getFreePorts(1)

    const presenceDir = await createTestPresenceDir(llmPort, {
      instances: [{ id: 'test-a', port: instPort, host: '127.0.0.1', enabled: true, autoStart: true }],
    })

    try {
      const { server, shutdown } = await startOrchestrator({ presenceDir })
      const orchPort = server.address().port

      const res = await request(orchPort, 'GET', '/api/instances')
      assert(res.status === 200, 'OE1: GET /api/instances returns 200')
      assert(Array.isArray(res.body), 'OE1: response is array')
      assert(res.body.length === 1, 'OE1: one instance listed')
      assert(res.body[0].id === 'test-a', 'OE1: instance id correct')

      await shutdown()
    } finally {
      await mockLLM.close()
      rmSync(presenceDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // OE2 + OE3. 인스턴스 fork + 헬스 엔드포인트
  // =========================================================================
  {
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: '응답' }))
    const llmPort = await mockLLM.start()
    const [instPort] = await getFreePorts(1)

    const presenceDir = await createTestPresenceDir(llmPort, {
      instances: [{ id: 'test-b', port: instPort, host: '127.0.0.1', enabled: true, autoStart: true }],
    })

    try {
      const { shutdown } = await startOrchestrator({ presenceDir })

      const ready = await waitForPort(instPort)
      assert(ready, 'OE2: instance process started and reachable')

      const health = await request(instPort, 'GET', '/api/instance')
      assert(health.status === 200, 'OE3: /api/instance returns 200')
      assert(health.body.id === 'test-b', 'OE3: instance id in health response')
      assert(health.body.status === 'running', 'OE3: status is running')
      assert(typeof health.body.uptime === 'number', 'OE3: uptime is number')

      await shutdown()
    } finally {
      await mockLLM.close()
      rmSync(presenceDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // OE4. 관리 API 목록 — 여러 인스턴스 상태
  // =========================================================================
  {
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: '응답' }))
    const llmPort = await mockLLM.start()
    const [portA, portB] = await getFreePorts(2)

    const presenceDir = await createTestPresenceDir(llmPort, {
      instances: [
        { id: 'inst-a', port: portA, host: '127.0.0.1', enabled: true, autoStart: true },
        { id: 'inst-b', port: portB, host: '127.0.0.1', enabled: true, autoStart: true },
      ],
    })

    try {
      const { server, shutdown } = await startOrchestrator({ presenceDir })
      const orchPort = server.address().port

      // 두 인스턴스 모두 시작될 때까지 대기
      const [readyA, readyB] = await Promise.all([waitForPort(portA), waitForPort(portB)])
      assert(readyA, 'OE4: instance A reachable')
      assert(readyB, 'OE4: instance B reachable')

      const res = await request(orchPort, 'GET', '/api/instances')
      assert(res.body.length === 2, 'OE4: two instances listed')
      const ids = res.body.map(i => i.id).sort()
      assert(ids[0] === 'inst-a' && ids[1] === 'inst-b', 'OE4: both instance ids present')

      await shutdown()
    } finally {
      await mockLLM.close()
      rmSync(presenceDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // OE5. 인스턴스 중지/시작
  // =========================================================================
  {
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: '응답' }))
    const llmPort = await mockLLM.start()
    const [instPort] = await getFreePorts(1)

    const presenceDir = await createTestPresenceDir(llmPort, {
      instances: [{ id: 'test-c', port: instPort, host: '127.0.0.1', enabled: true, autoStart: true }],
    })

    try {
      const { server, shutdown } = await startOrchestrator({ presenceDir })
      const orchPort = server.address().port

      await waitForPort(instPort)

      // 중지
      const stopRes = await request(orchPort, 'POST', '/api/instances/test-c/stop')
      assert(stopRes.status === 200, 'OE5: stop returns 200')
      await delay(1000)

      // 중지 후 접속 불가
      let reachable = false
      try {
        const r = await request(instPort, 'GET', '/api/instance')
        reachable = r.status === 200
      } catch { reachable = false }
      assert(!reachable, 'OE5: instance unreachable after stop')

      // 재시작
      const startRes = await request(orchPort, 'POST', '/api/instances/test-c/start')
      assert(startRes.status === 200, 'OE5: start returns 200')

      const readyAgain = await waitForPort(instPort)
      assert(readyAgain, 'OE5: instance reachable after start')

      await shutdown()
    } finally {
      await mockLLM.close()
      rmSync(presenceDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // OE6. 인스턴스 restart
  // =========================================================================
  {
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: '응답' }))
    const llmPort = await mockLLM.start()
    const [instPort] = await getFreePorts(1)

    const presenceDir = await createTestPresenceDir(llmPort, {
      instances: [{ id: 'test-d', port: instPort, host: '127.0.0.1', enabled: true, autoStart: true }],
    })

    try {
      const { server, shutdown } = await startOrchestrator({ presenceDir })
      const orchPort = server.address().port

      await waitForPort(instPort)

      const restartRes = await request(orchPort, 'POST', '/api/instances/test-d/restart')
      assert(restartRes.status === 200, 'OE6: restart returns 200')

      const ready = await waitForPort(instPort)
      assert(ready, 'OE6: instance reachable after restart')

      await shutdown()
    } finally {
      await mockLLM.close()
      rmSync(presenceDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // OE7. 인스턴스별 독립 세션 — 두 인스턴스에 각각 chat
  // =========================================================================
  {
    let callCount = 0
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: `응답 ${++callCount}` }))
    const llmPort = await mockLLM.start()
    const [portA, portB] = await getFreePorts(2)

    const presenceDir = await createTestPresenceDir(llmPort, {
      instances: [
        { id: 'chat-a', port: portA, host: '127.0.0.1', enabled: true, autoStart: true },
        { id: 'chat-b', port: portB, host: '127.0.0.1', enabled: true, autoStart: true },
      ],
    })

    try {
      const { shutdown } = await startOrchestrator({ presenceDir })
      await Promise.all([waitForPort(portA), waitForPort(portB)])

      const [tokenA, tokenB] = await Promise.all([login(portA), login(portB)])

      const [resA, resB] = await Promise.all([
        request(portA, 'POST', '/api/chat', { input: '인스턴스 A 질문' }, { token: tokenA }),
        request(portB, 'POST', '/api/chat', { input: '인스턴스 B 질문' }, { token: tokenB }),
      ])

      assert(resA.status === 200, 'OE7: instance A chat 200')
      assert(resB.status === 200, 'OE7: instance B chat 200')
      assert(resA.body.type === 'agent', 'OE7: instance A type agent')
      assert(resB.body.type === 'agent', 'OE7: instance B type agent')

      // 각 인스턴스의 state는 독립 (state 반영 대기)
      await delay(300)
      const [stateA, stateB] = await Promise.all([
        request(portA, 'GET', '/api/state', null, { token: tokenA }),
        request(portB, 'GET', '/api/state', null, { token: tokenB }),
      ])
      assert(stateA.body.turn >= 1, 'OE7: instance A turn >= 1')
      assert(stateB.body.turn >= 1, 'OE7: instance B turn >= 1')

      await shutdown()
    } finally {
      await mockLLM.close()
      rmSync(presenceDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // OE8. 인스턴스별 설정 분리 — 서로 다른 model 확인
  // =========================================================================
  {
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: '응답' }))
    const llmPort = await mockLLM.start()
    const [portA, portB] = await getFreePorts(2)

    const presenceDir = await createTestPresenceDir(llmPort, {
      instances: [
        { id: 'cfg-a', port: portA, host: '127.0.0.1', enabled: true, autoStart: true },
        { id: 'cfg-b', port: portB, host: '127.0.0.1', enabled: true, autoStart: true },
      ],
      instanceOverrides: {
        'cfg-a': { llm: { model: 'model-alpha' } },
        'cfg-b': { llm: { model: 'model-beta' } },
      },
    })

    try {
      const { shutdown } = await startOrchestrator({ presenceDir })
      await Promise.all([waitForPort(portA), waitForPort(portB)])

      const [tokenA, tokenB] = await Promise.all([login(portA), login(portB)])
      const [cfgA, cfgB] = await Promise.all([
        request(portA, 'GET', '/api/config', null, { token: tokenA }),
        request(portB, 'GET', '/api/config', null, { token: tokenB }),
      ])

      assert(cfgA.body.llm?.model === 'model-alpha', 'OE8: instance A has model-alpha')
      assert(cfgB.body.llm?.model === 'model-beta', 'OE8: instance B has model-beta')

      await shutdown()
    } finally {
      await mockLLM.close()
      rmSync(presenceDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // OE9. disabled 인스턴스 — fork 안 됨
  // =========================================================================
  {
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: '응답' }))
    const llmPort = await mockLLM.start()
    const [portA, portB] = await getFreePorts(2)

    const presenceDir = await createTestPresenceDir(llmPort, {
      instances: [
        { id: 'enabled-one', port: portA, host: '127.0.0.1', enabled: true, autoStart: true },
        { id: 'disabled-one', port: portB, host: '127.0.0.1', enabled: false, autoStart: true },
      ],
    })

    try {
      const { server, shutdown } = await startOrchestrator({ presenceDir })
      const orchPort = server.address().port

      await waitForPort(portA)
      await delay(2000) // disabled에 충분한 시간 부여

      // enabled 인스턴스는 응답
      const healthA = await request(portA, 'GET', '/api/instance')
      assert(healthA.status === 200, 'OE9: enabled instance reachable')

      // disabled 인스턴스는 미기동
      let reachable = false
      try {
        const r = await request(portB, 'GET', '/api/instance')
        reachable = r.status === 200
      } catch { reachable = false }
      assert(!reachable, 'OE9: disabled instance not started')

      // 관리 API에서도 disabled는 목록에 없음 (fork 안 했으므로)
      const list = await request(orchPort, 'GET', '/api/instances')
      assert(list.body.length === 1, 'OE9: only enabled instance in list')

      await shutdown()
    } finally {
      await mockLLM.close()
      rmSync(presenceDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // OE10. WS 접속 — 인스턴스에 직접 WebSocket 연결
  // =========================================================================
  {
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: '응답' }))
    const llmPort = await mockLLM.start()
    const [instPort] = await getFreePorts(1)

    const presenceDir = await createTestPresenceDir(llmPort, {
      instances: [{ id: 'ws-test', port: instPort, host: '127.0.0.1', enabled: true, autoStart: true }],
    })

    try {
      const { shutdown } = await startOrchestrator({ presenceDir })
      await waitForPort(instPort)

      const token = await login(instPort)
      const { ws, messages } = await connectWS(instPort, { token })
      await delay(200)

      assert(messages.length > 0, 'OE10: received init message via WS')
      assert(messages[0].type === 'init', 'OE10: first message is init')
      assert(messages[0].session_id === 'user-default', 'OE10: init for user-default session')

      ws.close()
      await shutdown()
    } finally {
      await mockLLM.close()
      rmSync(presenceDir, { recursive: true, force: true })
    }
  }

  summary()
}

run()
