/**
 * Mock Server — mock LLM + PRESENCE_DIR 격리 + 인증 + 서버 부팅 통합 헬퍼
 *
 * auth-e2e.test.js의 setupAuthServer 패턴을 공용화.
 * 모든 mock e2e 테스트가 이 헬퍼로 서버를 부팅한다.
 */

import http from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebSocket } from 'ws'
import { startServer } from '@presence/server'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import { ensureSecret } from '@presence/infra/infra/auth/token.js'

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

const TEST_USER = 'testuser'
const TEST_PASSWORD = 'testpassword123'
const INSTANCE_ID = 'mock-test'

// ---------------------------------------------------------------------------
// Mock LLM
// ---------------------------------------------------------------------------

const createMockLLM = (handler) => {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', async () => {
      let parsed
      try { parsed = JSON.parse(body) } catch { parsed = {} }
      calls.push(parsed)
      try {
        const response = await Promise.resolve(handler(parsed, calls.length))
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
      } catch (err) {
        // handler 가 throw 하면 LLM 서버가 500 으로 응답 — 에러 경로 유도용.
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: err.message } }))
      }
    })
  })
  return {
    calls,
    start: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise(r => server.close(r)),
  }
}

// ---------------------------------------------------------------------------
// 서버 부팅 (PRESENCE_DIR 격리 + 인증)
// ---------------------------------------------------------------------------

/**
 * mock LLM handler + 옵션 → 격리된 인증 서버 부팅.
 *
 * @param {Function} llmHandler - (parsedBody, callN) => string|object
 * @param {object} [opts]
 * @param {object} [opts.configOverrides] - baseConfig에 병합할 추가 설정
 * @returns {{ port, token, server, shutdown, tmpDir, mockLLM, defaultSessionId, userContext }}
 */
const createTestServer = async (llmHandler, opts = {}) => {
  const { configOverrides = {} } = opts
  const tmpDir = mkdtempSync(join(tmpdir(), 'mock-e2e-'))
  const mockLLM = createMockLLM(llmHandler)
  const llmPort = await mockLLM.start()

  // 인스턴스 설정 파일
  mkdirSync(join(tmpDir, 'instances'), { recursive: true })
  writeFileSync(join(tmpDir, 'instances', `${INSTANCE_ID}.json`), JSON.stringify({
    memory: { path: join(tmpDir, 'memory') },
  }))
  writeFileSync(join(tmpDir, 'server.json'), JSON.stringify({
    llm: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: 'test', apiKey: 'k', responseFormat: 'json_object', maxRetries: 0, timeoutMs: 5000 },
    embed: { provider: 'none', baseUrl: null, apiKey: null, model: null, dimensions: 256 },
    locale: 'ko', maxIterations: 5,
    mcp: [],
    scheduler: { enabled: false, pollIntervalMs: 60000, todoReview: { enabled: false, cron: '0 9 * * *' } },
    delegatePolling: { intervalMs: 60000 },
    prompt: { maxContextTokens: 8000, reservedOutputTokens: 1000, maxContextChars: null, reservedOutputChars: null },
    ...configOverrides,
  }))

  // 사용자 등록 + PRESENCE_DIR 격리
  ensureSecret({ basePath: tmpDir })
  const userStore = createUserStore({ basePath: tmpDir })
  await userStore.addUser(TEST_USER, TEST_PASSWORD)
  // addUser는 mustChangePassword: true로 생성 → changePassword로 해제
  await userStore.changePassword(TEST_USER, TEST_PASSWORD)

  const origDir = process.env.PRESENCE_DIR
  process.env.PRESENCE_DIR = tmpDir

  // 서버 시작
  const { loadUserMerged } = await import('@presence/infra/infra/config-loader.js')
  const config = loadUserMerged(INSTANCE_ID, { basePath: tmpDir })
  // configOverrides의 agents를 config에 병합
  if (configOverrides.agents) config.agents = configOverrides.agents
  const result = await startServer(config, { port: 0, persistenceCwd: tmpDir, instanceId: INSTANCE_ID })
  const port = result.server.address().port

  // 로그인 → 토큰 발급
  const loginRes = await request(port, 'POST', '/api/auth/login', { username: TEST_USER, password: TEST_PASSWORD })
  const token = loginRes.body.accessToken
  // 인증 활성화 시 {username}-default 세션이 자동 생성됨
  const defaultSessionId = `${TEST_USER}-default`
  // 한 번 접근해서 세션을 자동 생성시킴
  await request(port, 'GET', `/api/sessions/${defaultSessionId}/state`, null, { token })

  const origShutdown = result.shutdown
  const shutdown = async () => {
    await origShutdown()
    await mockLLM.close()
    if (origDir) process.env.PRESENCE_DIR = origDir
    else delete process.env.PRESENCE_DIR
    rmSync(tmpDir, { recursive: true, force: true })
  }

  return {
    port,
    token,
    server: result.server,
    shutdown,
    tmpDir,
    mockLLM,
    defaultSessionId,
    userContext: result.userContext,
    evaluator: result.evaluator,
  }
}

// ---------------------------------------------------------------------------
// HTTP 요청 헬퍼 (토큰 자동 첨부)
// ---------------------------------------------------------------------------

const request = (port, method, path, body, { token, cookie } = {}) =>
  new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const headers = {
      'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    }
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      let buf = ''
      const setCookie = res.headers['set-cookie'] || []
      res.on('data', d => { buf += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf), setCookie }) }
        catch { resolve({ status: res.statusCode, body: buf, setCookie }) }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })

// ---------------------------------------------------------------------------
// WebSocket 헬퍼 (토큰 첨부)
// ---------------------------------------------------------------------------

const connectWS = (port, { token, sessionId, cwd } = {}) =>
  new Promise((resolve, reject) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {}
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
    const messages = []
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())))
    ws.on('open', () => {
      // sessionId가 지정되면 join 메시지 전송 → init 수신. cwd 는 옵션.
      if (sessionId) {
        const joinMsg = { type: 'join', session_id: sessionId }
        if (cwd) joinMsg.cwd = cwd
        ws.send(JSON.stringify(joinMsg))
      }
      resolve({ ws, messages })
    })
    ws.on('error', reject)
    ws.on('close', (code) => resolve({ ws: null, messages, closeCode: code }))
    setTimeout(() => resolve({ ws: null, messages, closeCode: 'timeout' }), 5000)
  })

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise(r => setTimeout(r, ms))

const waitFor = (fn, { timeout = 5000, interval = 50 } = {}) =>
  new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      try {
        const result = fn()
        if (result) { resolve(result); return }
      } catch (_) {}
      if (Date.now() - start > timeout) {
        reject(new Error(`waitFor timeout: ${fn.toString().slice(0, 80)}`))
        return
      }
      setTimeout(check, interval)
    }
    check()
  })

export {
  createTestServer,
  createMockLLM,
  request,
  connectWS,
  delay,
  waitFor,
  TEST_USER,
  TEST_PASSWORD,
  INSTANCE_ID,
}
