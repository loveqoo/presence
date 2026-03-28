import http from 'node:http'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { WebSocket } from 'ws'
import { startServer } from '@presence/server'
import { assert, summary } from '../lib/assert.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// --- Mock LLM HTTP 서버 ---

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
    start: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

// --- HTTP 요청 헬퍼 ---

const request = (port, method, path, body) =>
  new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json' } }
    const req = http.request(opts, (res) => {
      let data = ''
      res.on('data', d => { data += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, body: data }) }
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })

// --- WebSocket 연결 헬퍼 ---

const connectWS = (port) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const messages = []
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())))
    ws.on('open', () => resolve({ ws, messages }))
  })

async function run() {
  console.log('Server tests')

  const tmpDir = mkdtempSync(join(tmpdir(), 'presence-server-'))
  const mockLLM = createMockLLM((_req, n) =>
    JSON.stringify({ type: 'direct_response', message: `응답 ${n}` })
  )
  const llmPort = await mockLLM.start()

  const config = {
    llm: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: 'test', apiKey: 'k', responseFormat: 'json_object', maxRetries: 0, timeoutMs: 5000 },
    embed: { provider: 'openai', baseUrl: null, apiKey: null, model: null, dimensions: 256 },
    locale: 'ko', maxIterations: 5,
    memory: { path: join(tmpDir, 'memory') },
    mcp: [],
    scheduler: { enabled: false, pollIntervalMs: 60000, todoReview: { enabled: false, cron: '0 9 * * *' } },
    delegatePolling: { intervalMs: 60000 },
    prompt: { maxContextTokens: 8000, reservedOutputTokens: 1000, maxContextChars: null, reservedOutputChars: null },
  }

  const { server, shutdown, app } = await startServer(config, { port: 0, persistenceCwd: tmpDir })
  const port = server.address().port

  try {
    // 1. GET /api/state — 초기 상태
    {
      const res = await request(port, 'GET', '/api/state')
      assert(res.status === 200, 'GET /api/state: 200')
      assert(res.body.turnState?.tag === 'idle', 'GET /api/state: idle')
      assert(res.body.turn === 0, 'GET /api/state: turn 0')
    }

    // 2. GET /api/tools — 도구 목록
    {
      const res = await request(port, 'GET', '/api/tools')
      assert(res.status === 200, 'GET /api/tools: 200')
      assert(Array.isArray(res.body), 'GET /api/tools: array')
      assert(res.body.length > 0, 'GET /api/tools: has tools')
      assert(res.body[0].name != null, 'GET /api/tools: tool has name')
    }

    // 3. GET /api/config — apiKey 제외
    {
      const res = await request(port, 'GET', '/api/config')
      assert(res.status === 200, 'GET /api/config: 200')
      assert(res.body.llm.apiKey === undefined, 'GET /api/config: apiKey excluded')
      assert(res.body.llm.model === 'test', 'GET /api/config: model present')
    }

    // 4. POST /api/chat — 에이전트 턴
    {
      const res = await request(port, 'POST', '/api/chat', { input: '안녕하세요' })
      assert(res.status === 200, 'POST /api/chat: 200')
      assert(res.body.type === 'agent', 'POST /api/chat: type agent')
      assert(res.body.content === '응답 1', 'POST /api/chat: correct response')
    }

    // 5. POST /api/chat — 턴 증가 확인
    {
      const stateRes = await request(port, 'GET', '/api/state')
      assert(stateRes.body.turn === 1, 'after chat: turn incremented')
      assert(stateRes.body.lastTurn?.tag === 'success', 'after chat: lastTurn success')
    }

    // 6. POST /api/chat — slash command
    {
      const res = await request(port, 'POST', '/api/chat', { input: '/status' })
      assert(res.status === 200, 'slash /status: 200')
      assert(res.body.type === 'system', 'slash /status: type system')
      assert(res.body.content.includes('idle'), 'slash /status: includes idle')
    }

    // 7. POST /api/chat — /clear
    {
      // 먼저 history 확인
      let state = await request(port, 'GET', '/api/state')
      const historyBefore = state.body.context?.conversationHistory?.length || 0

      await request(port, 'POST', '/api/chat', { input: '/clear' })
      state = await request(port, 'GET', '/api/state')
      const historyAfter = state.body.context?.conversationHistory?.length || 0
      assert(historyAfter === 0, 'slash /clear: history cleared')
    }

    // 8. POST /api/chat — input 누락
    {
      const res = await request(port, 'POST', '/api/chat', {})
      assert(res.status === 400, 'no input: 400')
    }

    // 9. POST /api/cancel
    {
      const res = await request(port, 'POST', '/api/cancel')
      assert(res.status === 200, 'POST /api/cancel: 200')
      assert(res.body.ok === true, 'POST /api/cancel: ok')
    }

    // 10. WebSocket — 연결 시 init 메시지
    {
      const { ws, messages } = await connectWS(port)
      await new Promise(r => setTimeout(r, 100))
      assert(messages.length >= 1, 'WS: received init message')
      assert(messages[0].type === 'init', 'WS: type is init')
      assert(messages[0].state.turnState?.tag === 'idle', 'WS: init state is idle')
      ws.close()
    }

    // 11. WebSocket — state 변경 push
    {
      const { ws, messages } = await connectWS(port)
      await new Promise(r => setTimeout(r, 100))
      const initCount = messages.length

      // 턴 실행 → state 변경 → WS push
      await request(port, 'POST', '/api/chat', { input: '두 번째 질문' })
      await new Promise(r => setTimeout(r, 200))

      const stateMessages = messages.slice(initCount).filter(m => m.type === 'state')
      assert(stateMessages.length > 0, 'WS: state changes pushed')
      assert(stateMessages.some(m => m.path === 'turnState'), 'WS: turnState change pushed')
      ws.close()
    }

    // 12. POST /api/chat — /mcp list (서버 없음)
    {
      const res = await request(port, 'POST', '/api/chat', { input: '/mcp list' })
      assert(res.status === 200, 'slash /mcp list: 200')
      assert(res.body.type === 'system', 'slash /mcp list: type system')
      assert(res.body.content.includes('No MCP servers'), 'slash /mcp list: no servers message')
    }

    // 13. POST /api/chat — /mcp enable (서버 없음)
    {
      const res = await request(port, 'POST', '/api/chat', { input: '/mcp enable mcp0' })
      assert(res.status === 200, 'slash /mcp enable: 200')
      assert(res.body.type === 'system', 'slash /mcp enable: type system')
      assert(res.body.content.includes('No MCP servers'), 'slash /mcp enable: no servers message')
    }

    // 14. GET /api/agents
    {
      const res = await request(port, 'GET', '/api/agents')
      assert(res.status === 200, 'GET /api/agents: 200')
      assert(Array.isArray(res.body), 'GET /api/agents: array')
    }

    // 15. WS init 메시지에 session_id 포함
    {
      const { ws, messages } = await connectWS(port)
      await new Promise(r => setTimeout(r, 100))
      assert(messages[0].session_id === 'user-default', 'WS: init has session_id')
      ws.close()
    }

    // 16. GET /api/sessions — user-default 포함
    {
      const res = await request(port, 'GET', '/api/sessions')
      assert(res.status === 200, 'GET /api/sessions: 200')
      assert(Array.isArray(res.body), 'GET /api/sessions: array')
      assert(res.body.some(s => s.id === 'user-default'), 'GET /api/sessions: user-default exists')
    }

    // 17. POST /api/sessions — 새 세션 생성
    {
      const res = await request(port, 'POST', '/api/sessions', { type: 'user' })
      assert(res.status === 201, 'POST /api/sessions: 201')
      assert(typeof res.body.id === 'string', 'POST /api/sessions: id returned')
      assert(res.body.type === 'user', 'POST /api/sessions: type returned')

      // 생성된 세션으로 chat
      const sessionId = res.body.id
      const beforeChatState = await request(port, 'GET', `/api/sessions/${sessionId}/state`)
      const turnBefore = beforeChatState.body.turn

      const chatRes = await request(port, 'POST', `/api/sessions/${sessionId}/chat`, { input: '세션 테스트' })
      assert(chatRes.status === 200, 'session chat: 200')
      assert(chatRes.body.type === 'agent', 'session chat: agent type')

      // 세션 상태 조회
      const stateRes = await request(port, 'GET', `/api/sessions/${sessionId}/state`)
      assert(stateRes.status === 200, 'session state: 200')
      assert(stateRes.body.turn === turnBefore + 1, 'session state: turn incremented')

      // 세션 소멸
      const deleteRes = await request(port, 'DELETE', `/api/sessions/${sessionId}`)
      assert(deleteRes.status === 200, 'DELETE session: 200')
      assert(deleteRes.body.ok === true, 'DELETE session: ok')

      // 소멸된 세션 접근 → 404
      const afterRes = await request(port, 'GET', `/api/sessions/${sessionId}/state`)
      assert(afterRes.status === 404, 'deleted session: 404')
    }

    // 18. /api/sessions/:id/chat — 세션 격리 (user-default 턴 영향 없음)
    {
      const beforeState = await request(port, 'GET', '/api/state')
      const turnBefore = beforeState.body.turn

      const newSession = await request(port, 'POST', '/api/sessions', { type: 'user' })
      const sessionId = newSession.body.id
      await request(port, 'POST', `/api/sessions/${sessionId}/chat`, { input: '격리 테스트' })

      const afterState = await request(port, 'GET', '/api/state')
      assert(afterState.body.turn === turnBefore, 'session isolation: user-default turn unchanged')

      await request(port, 'DELETE', `/api/sessions/${sessionId}`)
    }

  } finally {
    await shutdown()
    await mockLLM.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }

  // ==========================================================================
  // 19. SPA 정적 파일 fallback — API 라우트 우선 매칭 (web/dist 존재 시)
  // Express 5에서 '/{*splat}' 패턴 사용, API 라우트 이후 등록으로 GET /api/* 선점
  // ==========================================================================
  const webDist = join(__dirname, '../../web/dist')
  if (existsSync(webDist)) {
    const tmpDir2 = mkdtempSync(join(tmpdir(), 'presence-spa-'))
    const mockLLM2 = createMockLLM((_req, n) =>
      JSON.stringify({ type: 'direct_response', message: `ok ${n}` })
    )
    const llmPort2 = await mockLLM2.start()
    const config2 = {
      llm: { baseUrl: `http://127.0.0.1:${llmPort2}/v1`, model: 'test', apiKey: 'k', responseFormat: 'json_object', maxRetries: 0, timeoutMs: 5000 },
      embed: { provider: 'openai', baseUrl: null, apiKey: null, model: null, dimensions: 256 },
      locale: 'ko', maxIterations: 5,
      memory: { path: join(tmpDir2, 'memory') },
      mcp: [],
      scheduler: { enabled: false, pollIntervalMs: 60000, todoReview: { enabled: false, cron: '0 9 * * *' } },
      delegatePolling: { intervalMs: 60000 },
      prompt: { maxContextTokens: 8000, reservedOutputTokens: 1000, maxContextChars: null, reservedOutputChars: null },
    }
    const { server: server2, shutdown: shutdown2 } = await startServer(config2, { port: 0, persistenceCwd: tmpDir2 })
    const port2 = server2.address().port
    try {
      // GET /api/state는 JSON을 반환해야 함 (index.html로 먹히면 안 됨)
      const apiRes = await request(port2, 'GET', '/api/state')
      assert(apiRes.status === 200, '19: GET /api/state returns 200 with web/dist present')
      assert(typeof apiRes.body === 'object' && apiRes.body.turn !== undefined, '19: GET /api/state returns JSON not HTML')

      // GET /api/tools도 JSON 반환
      const toolsRes = await request(port2, 'GET', '/api/tools')
      assert(toolsRes.status === 200, '19: GET /api/tools returns 200 with web/dist present')
      assert(Array.isArray(toolsRes.body), '19: GET /api/tools returns array not HTML')

      // SPA fallback: 알 수 없는 경로 → index.html (200, HTML 응답)
      const spaRes = await new Promise((resolve, reject) => {
        const opts = { hostname: '127.0.0.1', port: port2, method: 'GET', path: '/some-client-route' }
        const req = http.request(opts, (res) => {
          let data = ''
          res.on('data', d => { data += d })
          res.on('end', () => resolve({ status: res.statusCode, body: data, ct: res.headers['content-type'] }))
        })
        req.on('error', reject)
        req.end()
      })
      assert(spaRes.status === 200, '19: SPA fallback returns 200')
      assert(spaRes.body.includes('<html') || spaRes.body.includes('<!DOCTYPE'), '19: SPA fallback returns HTML')
    } finally {
      await shutdown2()
      await mockLLM2.close()
      rmSync(tmpDir2, { recursive: true, force: true })
    }
  }

  summary()
}

run()
