/**
 * Server E2E tests — 실제 startServer() + Mock LLM으로 경계 조건 검증
 *
 * 커버하는 시나리오:
 *  SE1.  서버 도구 실행 — plan + EXEC + RESPOND → 실제 도구 결과 반환
 *  SE2.  LLM 실패 → 서버 에러 응답 + state 복구 (idle로 돌아옴)
 *  SE3.  WS join 메시지 — 특정 세션 init 수신
 *  SE4.  슬래시 /tools — 등록된 도구 목록 반환
 *  SE5.  defaultMemoryPath — 명시적 memory.path 없이 서버 기동 (EEXIST 회귀 방지)
 *  SE6.  CLI bootstrap — job 툴(schedule_job, list_jobs, read_todos) 가시성
 *  SE7.  CLI 연속 턴 — handleInput 연속 호출 후 state 일관성
 *  SE8.  서버 POST /api/approve — approve 채널 no-op (진행 중 턴 없음)
 *  SE9.  서버 세션 approve/cancel — 세션별 라우트 정상 동작
 *  SE10. 동시 요청 — 두 세션에 병렬 chat → 각각 독립적으로 완료
 *  SE11. POST /api/sessions + /api/sessions/:id/chat — slash command 격리
 *  SE12. 서버 WS 상태 브릿지 — turn 증가 시 WS push 수신
 */

import http from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { WebSocket } from 'ws'
import { startServer } from '@presence/server'
import { bootstrap } from '@presence/tui'
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

const createBaseConfig = (llmPort, memPath) => ({
  llm: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: 'test', apiKey: 'k', responseFormat: 'json_object', maxRetries: 0, timeoutMs: 5000 },
  embed: { provider: 'openai', baseUrl: null, apiKey: null, model: null, dimensions: 256 },
  locale: 'ko', maxIterations: 5,
  memory: memPath ? { path: memPath } : undefined,
  mcp: [],
  scheduler: { enabled: false, pollIntervalMs: 60000, todoReview: { enabled: false, cron: '0 9 * * *' } },
  delegatePolling: { intervalMs: 60000 },
  prompt: { maxContextTokens: 8000, reservedOutputTokens: 1000, maxContextChars: null, reservedOutputChars: null },
})

const request = (port, method, path, body) =>
  new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const opts = {
      hostname: '127.0.0.1', port, method, path,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }
    const req = http.request(opts, (res) => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf), ct: res.headers['content-type'] }) }
        catch { resolve({ status: res.statusCode, body: buf, ct: res.headers['content-type'] }) }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })

const connectWS = (port) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages = []
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())))
    ws.on('open', () => resolve({ ws, messages }))
  })

// ---------------------------------------------------------------------------

async function run() {
  console.log('Server E2E tests')

  // =========================================================================
  // SE1. 서버 도구 실행 — plan + EXEC + RESPOND → 실제 도구 결과 반환
  // =========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'se1-'))
    const testFile = join(tmpDir, 'hello.txt')
    writeFileSync(testFile, '파일 내용입니다')

    const mockLLM = createMockLLM((_req, n) => {
      if (n === 1) {
        return JSON.stringify({
          type: 'plan',
          steps: [
            { op: 'EXEC', args: { tool: 'file_read', tool_args: { path: testFile } } },
            { op: 'RESPOND', args: { ref: 1 } },
          ],
        })
      }
      return JSON.stringify({ type: 'direct_response', message: 'fallback' })
    })
    const llmPort = await mockLLM.start()
    const config = { ...createBaseConfig(llmPort, join(tmpDir, 'memory')), tools: { allowedDirs: [tmpDir] } }
    const { server, shutdown } = await startServer(config, { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    try {
      const res = await request(port, 'POST', '/api/chat', { input: '파일 읽어줘' })
      assert(res.status === 200, 'SE1: status 200')
      assert(res.body.type === 'agent', 'SE1: type agent')
      assert(typeof res.body.content === 'string' && res.body.content.includes('파일 내용'), 'SE1: tool result in response')

      const stateRes = await request(port, 'GET', '/api/state')
      assert(stateRes.body.turnState?.tag === 'idle', 'SE1: back to idle after tool execution')
      assert(stateRes.body.lastTurn?.tag === 'success', 'SE1: lastTurn success')
    } finally {
      await shutdown()
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // SE2. LLM 실패 → 서버 응답 반환 + state 복구
  //      프로덕션 인터프리터는 파싱 실패 시 에러 메시지를 agent 응답으로 내보냄.
  //      500을 던지거나 type:error로 반환하거나 둘 다 허용.
  // =========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'se2-'))
    const mockLLM = createMockLLM(() => '<<<invalid json>>>')
    const llmPort = await mockLLM.start()
    const { server, shutdown } = await startServer(createBaseConfig(llmPort, join(tmpDir, 'memory')), { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    try {
      const res = await request(port, 'POST', '/api/chat', { input: '실패 테스트' })
      // LLM 파싱 실패: 응답은 오거나(200 agent/error) 500
      assert(res.status === 200 || res.status === 500, 'SE2: response received on LLM failure')

      // 실패 후 상태 복구 확인
      const stateRes = await request(port, 'GET', '/api/state')
      assert(stateRes.body.turnState?.tag === 'idle', 'SE2: state recovered to idle')
      assert(stateRes.body.turn === 1, 'SE2: turn incremented even on failure')
    } finally {
      await shutdown()
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // SE3. WS join 메시지 — 특정 세션 init 수신
  // =========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'se3-'))
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: '응답' }))
    const llmPort = await mockLLM.start()
    const { server, shutdown, sessionManager } = await startServer(createBaseConfig(llmPort, join(tmpDir, 'memory')), { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    try {
      // 새 세션 생성
      const newSession = await request(port, 'POST', '/api/sessions', { type: 'user' })
      const sessionId = newSession.body.id

      const { ws, messages } = await connectWS(port)
      await delay(100)

      // init 메시지 수신 (user-default)
      assert(messages[0]?.type === 'init', 'SE3: initial init message received')

      // join 메시지 전송 → 특정 세션 init 수신
      ws.send(JSON.stringify({ type: 'join', session_id: sessionId }))
      await delay(100)

      const joinInit = messages.find(m => m.type === 'init' && m.session_id === sessionId)
      assert(joinInit != null, 'SE3: join → session-specific init received')
      assert(joinInit.state?.turnState?.tag === 'idle', 'SE3: joined session is idle')

      ws.close()
      await request(port, 'DELETE', `/api/sessions/${sessionId}`)
    } finally {
      await shutdown()
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // SE4. 슬래시 /tools — 등록된 도구 목록 반환
  // =========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'se4-'))
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: '응답' }))
    const llmPort = await mockLLM.start()
    const { server, shutdown } = await startServer(createBaseConfig(llmPort, join(tmpDir, 'memory')), { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    try {
      const res = await request(port, 'POST', '/api/chat', { input: '/tools' })
      assert(res.status === 200, 'SE4: /tools returns 200')
      assert(res.body.type === 'system', 'SE4: /tools type system')
      // file_read 등 local tools가 목록에 있어야 함
      assert(typeof res.body.content === 'string' && res.body.content.length > 0, 'SE4: /tools content non-empty')
    } finally {
      await shutdown()
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // SE5. defaultMemoryPath — 명시적 memory.path 없이 서버 기동 (EEXIST 회귀 방지)
  //      이전 버그: defaultMemoryPath()가 파일 경로 반환 → mkdirSync EEXIST
  // =========================================================================
  {
    // HOME을 임시 디렉토리로 바꿔서 실제 ~/.presence 오염 방지
    const fakeHome = mkdtempSync(join(tmpdir(), 'se5-home-'))
    const origHome = process.env.HOME
    process.env.HOME = fakeHome

    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: '응답' }))
    const llmPort = await mockLLM.start()

    // memory.path 없는 config — defaultMemoryPath() 경로 사용
    const config = {
      llm: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: 'test', apiKey: 'k', responseFormat: 'json_object', maxRetries: 0, timeoutMs: 5000 },
      embed: { provider: 'openai', baseUrl: null, apiKey: null, model: null, dimensions: 256 },
      locale: 'ko', maxIterations: 5,
      memory: {},  // path 없음 → defaultMemoryPath() 사용
      mcp: [],
      scheduler: { enabled: false, pollIntervalMs: 60000, todoReview: { enabled: false, cron: '0 9 * * *' } },
      delegatePolling: { intervalMs: 60000 },
      prompt: { maxContextTokens: 8000, reservedOutputTokens: 1000, maxContextChars: null, reservedOutputChars: null },
    }

    let started = false
    let shutdown = null
    try {
      const result = await startServer(config, { port: 0 })
      started = true
      shutdown = result.shutdown

      const port = result.server.address().port
      const stateRes = await request(port, 'GET', '/api/state')
      assert(stateRes.status === 200, 'SE5: server starts without explicit memory.path')
      assert(stateRes.body.turnState?.tag === 'idle', 'SE5: state available after start')
    } catch (e) {
      assert(false, `SE5: server start failed — ${e.message}`)
    } finally {
      process.env.HOME = origHome
      if (shutdown) await shutdown()
      await mockLLM.close()
      rmSync(fakeHome, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // SE6. CLI bootstrap — job 툴(schedule_job, list_jobs, read_todos) 가시성
  //      USER 세션에서 job 툴이 등록되어 있어야 함
  // =========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'se6-'))
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: '응답' }))
    const llmPort = await mockLLM.start()

    try {
      const app = await bootstrap(createBaseConfig(llmPort, join(tmpDir, 'memory')), { persistenceCwd: tmpDir })

      const toolNames = app.tools.map(t => t.name)
      assert(toolNames.includes('schedule_job'), 'SE6: schedule_job in CLI tools')
      assert(toolNames.includes('list_jobs'), 'SE6: list_jobs in CLI tools')
      assert(toolNames.includes('read_todos'), 'SE6: read_todos in CLI tools')
      assert(toolNames.includes('file_read'), 'SE6: file_read in CLI tools')

      await app.shutdown()
    } finally {
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // SE7. CLI 연속 턴 — handleInput 연속 호출 후 state 일관성
  // =========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'se7-'))
    let n = 0
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: `응답 ${++n}` }))
    const llmPort = await mockLLM.start()

    try {
      const app = await bootstrap(createBaseConfig(llmPort, join(tmpDir, 'memory')), { persistenceCwd: tmpDir })

      const r1 = await app.handleInput('첫 번째')
      const r2 = await app.handleInput('두 번째')
      const r3 = await app.handleInput('세 번째')

      assert(r1 === '응답 1', 'SE7: first response correct')
      assert(r2 === '응답 2', 'SE7: second response correct')
      assert(r3 === '응답 3', 'SE7: third response correct')
      assert(app.state.get('turn') === 3, 'SE7: turn count correct')
      assert(app.state.get('turnState')?.tag === 'idle', 'SE7: idle after 3 turns')

      const history = app.state.get('context.conversationHistory') || []
      assert(history.length === 3, 'SE7: 3 history entries')

      await app.shutdown()
    } finally {
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // SE8. 서버 POST /api/approve — 진행 중 턴 없을 때 no-op (에러 없음)
  // =========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'se8-'))
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: '응답' }))
    const llmPort = await mockLLM.start()
    const { server, shutdown } = await startServer(createBaseConfig(llmPort, join(tmpDir, 'memory')), { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    try {
      // 진행 중 턴 없을 때 approve 전송 → no-op, 에러 없음
      const res = await request(port, 'POST', '/api/approve', { approved: true })
      assert(res.status === 200, 'SE8: approve no-op returns 200')
      assert(res.body?.ok === true, 'SE8: approve no-op returns ok')

      const res2 = await request(port, 'POST', '/api/approve', { approved: false })
      assert(res2.status === 200, 'SE8: deny no-op returns 200')
    } finally {
      await shutdown()
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // SE9. 세션별 approve/cancel 라우트 정상 동작
  // =========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'se9-'))
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: '응답' }))
    const llmPort = await mockLLM.start()
    const { server, shutdown } = await startServer(createBaseConfig(llmPort, join(tmpDir, 'memory')), { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    try {
      const newSession = await request(port, 'POST', '/api/sessions', { type: 'user' })
      const sessionId = newSession.body.id

      const approveRes = await request(port, 'POST', `/api/sessions/${sessionId}/approve`, { approved: true })
      assert(approveRes.status === 200, 'SE9: session approve 200')
      assert(approveRes.body?.ok === true, 'SE9: session approve ok')

      const cancelRes = await request(port, 'POST', `/api/sessions/${sessionId}/cancel`)
      assert(cancelRes.status === 200, 'SE9: session cancel 200')
      assert(cancelRes.body?.ok === true, 'SE9: session cancel ok')

      // 존재하지 않는 세션
      const notFound = await request(port, 'POST', '/api/sessions/nonexistent/approve', { approved: true })
      assert(notFound.status === 404, 'SE9: nonexistent session approve 404')

      await request(port, 'DELETE', `/api/sessions/${sessionId}`)
    } finally {
      await shutdown()
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // SE10. 동시 요청 — 두 세션에 병렬 chat → 각각 독립적으로 완료
  // =========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'se10-'))
    let callCount = 0
    const mockLLM = createMockLLM(() => {
      const n = ++callCount
      return JSON.stringify({ type: 'direct_response', message: `응답 ${n}` })
    })
    const llmPort = await mockLLM.start()
    const { server, shutdown } = await startServer(createBaseConfig(llmPort, join(tmpDir, 'memory')), { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    try {
      const s1 = await request(port, 'POST', '/api/sessions', { type: 'user' })
      const s2 = await request(port, 'POST', '/api/sessions', { type: 'user' })
      const id1 = s1.body.id
      const id2 = s2.body.id

      // 두 세션에 병렬 요청
      const [r1, r2] = await Promise.all([
        request(port, 'POST', `/api/sessions/${id1}/chat`, { input: '세션1 질문' }),
        request(port, 'POST', `/api/sessions/${id2}/chat`, { input: '세션2 질문' }),
      ])

      assert(r1.status === 200, 'SE10: session 1 chat 200')
      assert(r2.status === 200, 'SE10: session 2 chat 200')
      assert(r1.body.type === 'agent', 'SE10: session 1 type agent')
      assert(r2.body.type === 'agent', 'SE10: session 2 type agent')

      // 두 세션의 turn이 각각 초기값 + 1 (응답 수신 후 state 반영 대기)
      // Note: persistenceCwd 미지정 세션은 기본 CWD에서 상태 복원 가능하므로 증분 체크
      await delay(100)
      const st1 = await request(port, 'GET', `/api/sessions/${id1}/state`)
      const st2 = await request(port, 'GET', `/api/sessions/${id2}/state`)
      assert(typeof st1.body.turn === 'number' && st1.body.turn >= 1, 'SE10: session 1 turn incremented')
      assert(typeof st2.body.turn === 'number' && st2.body.turn >= 1, 'SE10: session 2 turn incremented')

      // 기본 세션(user-default) 영향 없음
      const defaultState = await request(port, 'GET', '/api/state')
      assert(defaultState.body.turn === 0, 'SE10: default session unaffected')

      await Promise.all([
        request(port, 'DELETE', `/api/sessions/${id1}`),
        request(port, 'DELETE', `/api/sessions/${id2}`),
      ])
    } finally {
      await shutdown()
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // SE11. POST /api/sessions + 세션별 슬래시 명령 격리
  //       세션 A에서 /clear해도 세션 B 히스토리 영향 없음
  // =========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'se11-'))
    let n = 0
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: `응답 ${++n}` }))
    const llmPort = await mockLLM.start()
    const { server, shutdown } = await startServer(createBaseConfig(llmPort, join(tmpDir, 'memory')), { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    try {
      const sA = await request(port, 'POST', '/api/sessions', { type: 'user' })
      const sB = await request(port, 'POST', '/api/sessions', { type: 'user' })
      const idA = sA.body.id
      const idB = sB.body.id

      // 두 세션에 각각 1턴
      await request(port, 'POST', `/api/sessions/${idA}/chat`, { input: '세션A 질문' })
      await request(port, 'POST', `/api/sessions/${idB}/chat`, { input: '세션B 질문' })

      const stBBefore = await request(port, 'GET', `/api/sessions/${idB}/state`)
      const histBBefore = stBBefore.body.context?.conversationHistory?.length || 0

      // 세션 A에서 /clear
      const clearRes = await request(port, 'POST', `/api/sessions/${idA}/chat`, { input: '/clear' })
      assert(clearRes.body.type === 'system', 'SE11: /clear returns system message')

      const stAAfter = await request(port, 'GET', `/api/sessions/${idA}/state`)
      assert((stAAfter.body.context?.conversationHistory?.length || 0) === 0, 'SE11: session A history cleared')

      const stBAfter = await request(port, 'GET', `/api/sessions/${idB}/state`)
      const histBAfter = stBAfter.body.context?.conversationHistory?.length || 0
      assert(histBAfter === histBBefore, 'SE11: session B history unaffected by session A /clear')

      await Promise.all([
        request(port, 'DELETE', `/api/sessions/${idA}`),
        request(port, 'DELETE', `/api/sessions/${idB}`),
      ])
    } finally {
      await shutdown()
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // SE12. WS 상태 브릿지 — 턴 완료 시 turn 변경 WS push 수신
  // =========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'se12-'))
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: '응답' }))
    const llmPort = await mockLLM.start()
    const { server, shutdown } = await startServer(createBaseConfig(llmPort, join(tmpDir, 'memory')), { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    try {
      const { ws, messages } = await connectWS(port)
      await delay(100)
      const initCount = messages.length

      await request(port, 'POST', '/api/chat', { input: 'WS 브릿지 테스트' })
      await delay(300)

      const after = messages.slice(initCount)
      const turnMsg = after.find(m => m.type === 'state' && m.path === 'turn')
      assert(turnMsg != null, 'SE12: turn change pushed via WS')
      assert(turnMsg.value === 1, 'SE12: turn value is 1')
      assert(turnMsg.session_id === 'user-default', 'SE12: session_id in WS message')

      ws.close()
    } finally {
      await shutdown()
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  summary()
}

run()
