/**
 * Server E2E tests — 세션 API + WebSocket + 슬래시 커맨드
 *
 * 모든 요청은 인증 토큰 첨부. PRESENCE_DIR 격리.
 *
 * 커버하는 시나리오:
 *  S1.  GET /api/sessions/:id/state — 초기 상태 idle, turn 0
 *  S2.  GET /api/sessions/:id/tools — 도구 목록 배열
 *  S3.  GET /api/sessions/:id/config — apiKey 제외
 *  S4.  POST /api/sessions/:id/chat — 에이전트 응답
 *  S5.  POST /api/sessions/:id/chat 후 turn 증가
 *  S6.  POST /api/sessions/:id/chat — /status 슬래시 커맨드
 *  S7.  POST /api/sessions/:id/chat — /clear 히스토리 초기화
 *  S8.  POST /api/sessions/:id/chat — input 누락 → 400
 *  S9.  POST /api/sessions/:id/cancel
 *  S10. WebSocket — 인증 후 init 메시지
 *  S11. WebSocket — state 변경 push
 *  S12. POST /api/sessions/:id/chat — /mcp list (서버 없음)
 *  S13. GET /api/sessions/:id/agents
 *  S14. GET /api/sessions — 세션 목록에 default 포함
 *  S15. POST /api/sessions — 새 세션 생성 + chat + 삭제
 *  S16. 세션 격리 — 다른 세션 턴에 영향 없음
 *  S17. 존재하지 않는 세션 → 404
 *  S18. /clear 후 persistence flush — 재시작 시 이전 히스토리 복원 방지
 *  S19. SPA 정적 파일 fallback (web/dist 존재 시)
 */

import http from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestServer, request, connectWS, delay } from '../../../test/lib/mock-server.js'
import { assert, summary } from '../../../test/lib/assert.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function run() {
  console.log('Server tests')

  const ctx = await createTestServer(
    (_req, n) => JSON.stringify({ type: 'direct_response', message: `응답 ${n}` })
  )
  const { port, token, defaultSessionId: sid, shutdown } = ctx

  const get = (path) => request(port, 'GET', path, null, { token })
  const post = (path, body) => request(port, 'POST', path, body, { token })

  try {
    // S1. 초기 상태
    {
      const res = await get(`/api/sessions/${sid}/state`)
      assert(res.status === 200, 'S1: GET state 200')
      assert(res.body.turnState?.tag === 'idle', 'S1: idle')
      assert(res.body.turn === 0, 'S1: turn 0')
    }

    // S2. 도구 목록
    {
      const res = await get(`/api/sessions/${sid}/tools`)
      assert(res.status === 200, 'S2: GET tools 200')
      assert(Array.isArray(res.body), 'S2: array')
      assert(res.body.length > 0, 'S2: has tools')
      assert(res.body[0].name != null, 'S2: tool has name')
    }

    // S3. config — apiKey 제외
    {
      const res = await get(`/api/sessions/${sid}/config`)
      assert(res.status === 200, 'S3: GET config 200')
      assert(res.body.llm.apiKey === undefined, 'S3: apiKey excluded')
      assert(res.body.llm.model === 'test', 'S3: model present')
    }

    // S4. chat → 에이전트 응답
    {
      const res = await post(`/api/sessions/${sid}/chat`, { input: '안녕하세요' })
      assert(res.status === 200, 'S4: POST chat 200')
      assert(res.body.type === 'agent', 'S4: type agent')
      assert(res.body.content === '응답 1', 'S4: correct response')
    }

    // S5. 턴 증가
    {
      const res = await get(`/api/sessions/${sid}/state`)
      assert(res.body.turn === 1, 'S5: turn incremented')
      assert(res.body.lastTurn?.tag === 'success', 'S5: lastTurn success')
    }

    // S6. /status 슬래시 커맨드
    {
      const res = await post(`/api/sessions/${sid}/chat`, { input: '/status' })
      assert(res.status === 200, 'S6: /status 200')
      assert(res.body.type === 'system', 'S6: type system')
      assert(res.body.content.includes('idle'), 'S6: includes idle')
    }

    // S7. /clear
    {
      await post(`/api/sessions/${sid}/chat`, { input: '/clear' })
      const state = await get(`/api/sessions/${sid}/state`)
      const historyLen = state.body.context?.conversationHistory?.length || 0
      assert(historyLen === 0, 'S7: history cleared')
    }

    // S8. input 누락 → 400
    {
      const res = await post(`/api/sessions/${sid}/chat`, {})
      assert(res.status === 400, 'S8: no input 400')
    }

    // S9. cancel
    {
      const res = await post(`/api/sessions/${sid}/cancel`)
      assert(res.status === 200, 'S9: cancel 200')
      assert(res.body.ok === true, 'S9: ok')
    }

    // S10. WebSocket — init 메시지
    {
      const { ws, messages } = await connectWS(port, { token, sessionId: sid })
      await delay(300)
      assert(messages.length >= 1, 'S10: received init')
      assert(messages[0].type === 'init', 'S10: type init')
      assert(messages[0].state.turnState?.tag === 'idle', 'S10: init idle')
      ws.close()
    }

    // S11. WebSocket — state push
    {
      const { ws, messages } = await connectWS(port, { token, sessionId: sid })
      await delay(200)
      const initCount = messages.length

      await post(`/api/sessions/${sid}/chat`, { input: '두 번째' })
      await delay(300)

      const stateMessages = messages.slice(initCount).filter(m => m.type === 'state')
      assert(stateMessages.length > 0, 'S11: state changes pushed')
      assert(stateMessages.some(m => m.path === 'turnState'), 'S11: turnState pushed')
      ws.close()
    }

    // S12. /mcp list (서버 없음)
    {
      const res = await post(`/api/sessions/${sid}/chat`, { input: '/mcp list' })
      assert(res.status === 200, 'S12: /mcp list 200')
      assert(res.body.type === 'system', 'S12: type system')
      assert(res.body.content.includes('No MCP servers'), 'S12: no servers')
    }

    // S13. agents
    {
      const res = await get(`/api/sessions/${sid}/agents`)
      assert(res.status === 200, 'S13: GET agents 200')
    }

    // S14. 세션 목록에 default 포함
    {
      const res = await get('/api/sessions')
      assert(res.status === 200, 'S14: GET sessions 200')
      assert(Array.isArray(res.body), 'S14: array')
      assert(res.body.some(s => s.id === sid), 'S14: default session exists')
    }

    // S15. 새 세션 생성 + chat + 삭제
    {
      const createRes = await post('/api/sessions', { type: 'user' })
      assert(createRes.status === 201, 'S15: create 201')
      const newId = createRes.body.id
      assert(typeof newId === 'string', 'S15: id returned')

      const chatRes = await post(`/api/sessions/${newId}/chat`, { input: '세션 테스트' })
      assert(chatRes.status === 200, 'S15: session chat 200')
      assert(chatRes.body.type === 'agent', 'S15: agent type')

      const stateRes = await get(`/api/sessions/${newId}/state`)
      assert(stateRes.body.turn === 1, 'S15: turn incremented')

      const deleteRes = await request(port, 'DELETE', `/api/sessions/${newId}`, null, { token })
      assert(deleteRes.status === 200, 'S15: delete 200')

      const afterRes = await get(`/api/sessions/${newId}/state`)
      assert(afterRes.status === 404, 'S15: deleted → 404')
    }

    // S15b. default 세션 삭제 → 재접속 시 자동 재생성
    {
      // default 세션 삭제
      const deleteRes = await request(port, 'DELETE', `/api/sessions/${sid}`, null, { token })
      assert(deleteRes.status === 200, 'S15b: default session delete 200')

      // 삭제 직후 목록에서 사라짐
      const listRes = await get('/api/sessions')
      const hasDefault = listRes.body.some(s => s.id === sid)
      assert(!hasDefault, 'S15b: default session removed from list')

      // 다시 접근 → findOrCreateSession이 자동 재생성
      const stateRes = await get(`/api/sessions/${sid}/state`)
      assert(stateRes.status === 200, 'S15b: auto-recreated on access')
      assert(stateRes.body.turn === 0, 'S15b: fresh state (turn 0)')

      // chat도 정상 동작
      const chatRes = await post(`/api/sessions/${sid}/chat`, { input: '재생성 테스트' })
      assert(chatRes.status === 200, 'S15b: chat after recreate 200')
    }

    // S15c. 비-default 커스텀 세션 삭제 → 재접근 시 404 (자동 재생성 안 됨)
    {
      const createRes = await post('/api/sessions', { type: 'user' })
      const customId = createRes.body.id
      await request(port, 'DELETE', `/api/sessions/${customId}`, null, { token })
      const afterRes = await get(`/api/sessions/${customId}/state`)
      assert(afterRes.status === 404, 'S15c: custom session not auto-recreated')
    }

    // S16. 세션 격리
    {
      const beforeState = await get(`/api/sessions/${sid}/state`)
      const turnBefore = beforeState.body.turn

      const newSession = await post('/api/sessions', { type: 'user' })
      const newId = newSession.body.id
      await post(`/api/sessions/${newId}/chat`, { input: '격리 테스트' })

      const afterState = await get(`/api/sessions/${sid}/state`)
      assert(afterState.body.turn === turnBefore, 'S16: default turn unchanged')
      await request(port, 'DELETE', `/api/sessions/${newId}`, null, { token })
    }

    // S17. 존재하지 않는 세션 → 404
    {
      const res = await get('/api/sessions/nonexistent/state')
      assert(res.status === 404, 'S17: nonexistent session 404')
    }

    // S18. /clear 후 persistence flush — 재시작 시 이전 히스토리 복원 방지
    {
      // chat → persistence에 history 기록
      await post(`/api/sessions/${sid}/chat`, { input: 'persist-test' })
      await delay(1000) // debounce flush 대기

      const stateFile = join(ctx.tmpDir, 'users', 'testuser', 'sessions', sid, 'state.json')
      const before = JSON.parse(readFileSync(stateFile, 'utf-8'))
      assert(before.agentState?.context?.conversationHistory?.length > 0, 'S18: chat 후 history 저장됨')

      // /clear → persistence에 빈 history 기록
      await post(`/api/sessions/${sid}/chat`, { input: '/clear' })
      await delay(1000)

      const after = JSON.parse(readFileSync(stateFile, 'utf-8'))
      assert(after.agentState?.context?.conversationHistory?.length === 0, 'S18: /clear 후 빈 history 저장됨')

      // 새 chat → 새 history만 저장
      await post(`/api/sessions/${sid}/chat`, { input: 'after-clear' })
      await delay(1000)

      const final = JSON.parse(readFileSync(stateFile, 'utf-8'))
      assert(final.agentState?.context?.conversationHistory?.length === 1, 'S18: /clear 후 새 대화만 저장됨')
      assert(!JSON.stringify(final).includes('persist-test'), 'S18: 이전 대화 내용 없음')
    }

  } finally {
    await shutdown()
  }

  // ==========================================================================
  // S19. SPA fallback (web/dist 존재 시)
  // ==========================================================================
  const webDist = join(__dirname, '../../web/dist')
  if (existsSync(webDist)) {
    const ctx2 = await createTestServer(
      (_req, n) => JSON.stringify({ type: 'direct_response', message: `ok ${n}` })
    )
    const { port: port2, token: token2, defaultSessionId: sid2, shutdown: shutdown2 } = ctx2

    try {
      const apiRes = await request(port2, 'GET', `/api/sessions/${sid2}/state`, null, { token: token2 })
      assert(apiRes.status === 200, 'S19: API returns 200 with web/dist')
      assert(typeof apiRes.body === 'object' && apiRes.body.turn !== undefined, 'S19: API returns JSON')

      const spaRes = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: port2, method: 'GET', path: '/some-client-route' }, (res) => {
          let data = ''
          res.on('data', d => { data += d })
          res.on('end', () => resolve({ status: res.statusCode, body: data }))
        })
        req.on('error', reject)
        req.end()
      })
      assert(spaRes.status === 200, 'S19: SPA fallback 200')
      assert(spaRes.body.includes('<html') || spaRes.body.includes('<!DOCTYPE'), 'S19: SPA returns HTML')
    } finally {
      await shutdown2()
    }
  }

  summary()
}

run()
