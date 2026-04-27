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
import { createTestServer, request, connectWS, delay, waitFor } from '../../../test/lib/mock-server.js'
import { inspectAccessInvocations, resetAccessInvocations } from '@presence/infra/infra/authz/agent-access.js'
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
    // KG-18: 진입점 #1 (session-api) — happy path 가 canAccessAgent 호출 spy 검증
    {
      resetAccessInvocations()
      const res = await get(`/api/sessions/${sid}/state`)
      assert(res.status === 200, 'S1: GET state 200')
      assert(res.body.turnState?.tag === 'idle', 'S1: idle')
      assert(res.body.turn === 0, 'S1: turn 0')

      // KG-18 spy: 진입점 #1 가 CONTINUE_SESSION intent 로 canAccessAgent 호출했는지 동적 검증
      const calls = inspectAccessInvocations()
      assert(
        calls.some(c => c.intent === 'continue-session' && typeof c.agentId === 'string' && c.agentId.includes('/')),
        'S1 (KG-18): 진입점 #1 spy — CONTINUE_SESSION intent + qualified agentId',
      )
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
      // FP-71 — personaConfigured 가 boolean 으로 노출 (TUI 첫 진입 안내용)
      assert(typeof res.body.personaConfigured === 'boolean',
        `S3: personaConfigured boolean (got ${typeof res.body.personaConfigured})`)
      assert(res.body.personaConfigured === false,
        `S3: 신규 testuser 는 systemPrompt unset → false (got ${res.body.personaConfigured})`)
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

    // S7b. FP-71 — /persona 슬래시 커맨드 (show/set/reset)
    {
      // show: 초기 unset 표시
      const showRes = await post(`/api/sessions/${sid}/chat`, { input: '/persona show' })
      assert(showRes.status === 200, 'S7b: /persona show 200')
      assert(showRes.body.type === 'system', 'S7b: type system')
      assert(showRes.body.content.includes('unset'), `S7b: 초기 unset 표시 (got: ${showRes.body.content})`)

      // set: systemPrompt 갱신
      const setRes = await post(`/api/sessions/${sid}/chat`, { input: '/persona set 코드 멘토 역할' })
      assert(setRes.status === 200, 'S7b: /persona set 200')
      assert(setRes.body.content.includes('updated'), `S7b: 갱신 안내 (got: ${setRes.body.content})`)

      // show: 갱신된 systemPrompt 표시
      const showAfter = await post(`/api/sessions/${sid}/chat`, { input: '/persona' })
      assert(showAfter.body.content.includes('코드 멘토 역할'),
        `S7b: 갱신된 systemPrompt 노출 (got: ${showAfter.body.content})`)

      // reset: null 로 환원
      const resetRes = await post(`/api/sessions/${sid}/chat`, { input: '/persona reset' })
      assert(resetRes.status === 200, 'S7b: /persona reset 200')

      const showFinal = await post(`/api/sessions/${sid}/chat`, { input: '/persona show' })
      assert(showFinal.body.content.includes('unset'), 'S7b: reset 후 다시 unset')

      // 잘못된 사용법 — set 없이
      const badRes = await post(`/api/sessions/${sid}/chat`, { input: '/persona set' })
      assert(badRes.body.content.includes('Usage'), 'S7b: 빈 set → Usage 안내')

      // 알 수 없는 서브커맨드
      const unknownRes = await post(`/api/sessions/${sid}/chat`, { input: '/persona xyz' })
      assert(unknownRes.body.content.includes('Usage'), 'S7b: 알 수 없는 서브커맨드 → Usage')
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
    // KG-18: 진입점 #3 (ws-handler) — WS join happy path 가 canAccessAgent 호출 spy 검증
    {
      resetAccessInvocations()
      const { ws, messages } = await connectWS(port, { token, sessionId: sid })
      await delay(300)
      assert(messages.length >= 1, 'S10: received init')
      assert(messages[0].type === 'init', 'S10: type init')
      assert(messages[0].state.turnState?.tag === 'idle', 'S10: init idle')

      // KG-18 spy: 진입점 #3 이 CONTINUE_SESSION intent 로 canAccessAgent 호출했는지 동적 검증
      const calls = inspectAccessInvocations()
      assert(
        calls.some(c => c.intent === 'continue-session' && typeof c.agentId === 'string' && c.agentId.includes('/')),
        'S10 (KG-18): 진입점 #3 spy — CONTINUE_SESSION intent + qualified agentId',
      )
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

      const stateFile = join(ctx.tmpDir, 'users', 'testuser', 'agents', 'default', 'sessions', sid, 'state.json')
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

    // S20b. POST /sessions — workingDir 은 userId 에서 자동 결정 (body 입력 무시).
    //        docs/specs/agent-identity.md I-WD.
    {
      const { Config } = await import('@presence/infra/infra/config.js')
      const newId = `working-dir-${Date.now()}`
      const res = await post('/api/sessions', { id: newId, type: 'user', workingDir: '/ignored' })
      assert(res.status === 201, 'S20b: POST → 201')
      assert(res.body.workingDir === Config.userDataPath('testuser'),
        `S20b: workingDir = userDataPath (got ${res.body.workingDir})`)
      await request(port, 'DELETE', `/api/sessions/${newId}`, null, { token })
    }

    // SC-Y1a. Cedar evaluator 가용성 — 부팅 후 ctx.evaluator 함수 (CI-Y3 통합 검증).
    {
      assert(typeof ctx.evaluator === 'function', 'SC-Y1a: ctx.evaluator 함수 가용')
    }

    // SC-Y3. 정상 부팅 후 evaluator 1 회 호출 → audit log 파일에 entry 1 줄 추가.
    {
      const { join: joinPath } = await import('node:path')
      const { existsSync: exists, readFileSync: readFile } = await import('node:fs')
      const auditPath = joinPath(ctx.tmpDir, 'logs', 'authz-audit.log')
      const before = exists(auditPath) ? readFile(auditPath, 'utf-8').split('\n').filter(Boolean).length : 0
      // governance-cedar v2.3 §X — schema 가 currentCount/maxAgents 강제 → context 첨부 필수.
      const r = ctx.evaluator({
        principal: { type: 'LocalUser', id: 'admin' },
        action:    'create_agent',
        resource:  { type: 'User', id: 'admin' },
        context:   { currentCount: 0, maxAgents: 5 },
      })
      assert(r.decision === 'allow', `SC-Y3: 실 자산으로 admin allow (got ${r.decision})`)
      const after = readFile(auditPath, 'utf-8').split('\n').filter(Boolean).length
      assert(after === before + 1, `SC-Y3: audit entry 1 줄 추가 (${before} → ${after})`)
    }

    // S21. INV-RJT-SNAPSHOT — chat 500 응답은 snapshot + stateVersion 동반
    {
      const errCtx = await createTestServer(() => { throw new Error('llm boom') })
      try {
        const res = await request(
          errCtx.port, 'POST', `/api/sessions/${errCtx.defaultSessionId}/chat`,
          { input: '에러 유도' }, { token: errCtx.token },
        )
        assert(res.status === 500, 'S21: chat error → 500')
        assert(res.body.type === 'error', 'S21: type=error')
        assert(typeof res.body.content === 'string' && res.body.content.length > 0,
          'S21: content 존재')
        assert(res.body.snapshot && typeof res.body.snapshot === 'object',
          'S21: snapshot 동봉 (INV-RJT-SNAPSHOT)')
        assert('turnState' in res.body.snapshot || 'turn' in res.body.snapshot,
          'S21: snapshot 이 실제 state 구조')
        assert('stateVersion' in res.body, 'S21: stateVersion 동봉')
      } finally { await errCtx.shutdown() }
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

  // ==========================================================================
  // S20. KG-07 — 재연결 중 pending approve 상태 복원
  //   전제: client A 가 chat 시작 → APPROVE op 대기 → WS 끊김 → client B 재연결.
  //   검증: 재연결 시 init snapshot 에 `_approve` 가 포함되어 ApprovePrompt 가 복원된다.
  //        POST /approve 가 여전히 동작하여 pending turn 이 해소된다.
  //   (spec approve.md E4 / KG-07 의 실제 동작 확인)
  // ==========================================================================
  {
    const approvePlan = {
      type: 'plan',
      steps: [
        { op: 'APPROVE', args: { description: 'dangerous: rm -rf /tmp/test' } },
        { op: 'RESPOND', args: { message: 'approved and done' } },
      ],
    }
    const ctx3 = await createTestServer(
      (_req, n) => n === 1 ? JSON.stringify(approvePlan) : JSON.stringify({ type: 'direct_response', message: 'ok' })
    )
    const { port: port3, token: token3, defaultSessionId: sid3, shutdown: shutdown3 } = ctx3
    const get3 = (path) => request(port3, 'GET', path, null, { token: token3 })
    const post3 = (path, body) => request(port3, 'POST', path, body, { token: token3 })

    try {
      // 1. WS A 연결 → init 수신
      const connA = await connectWS(port3, { token: token3, sessionId: sid3 })
      await delay(150)
      assert(connA.messages.some(m => m.type === 'init'), 'S20: WS A received init')

      // 2. chat POST — APPROVE 에서 블로킹 (fire-and-forget)
      const chatPromise = post3(`/api/sessions/${sid3}/chat`, { input: 'start risky op' })

      // 3. WS A 에 _approve state 메시지가 push 될 때까지 대기
      await waitFor(() => connA.messages.some(m => m.type === 'state' && m.path === '_approve' && m.value?.description), { timeout: 2000 })
      const approveMsgA = connA.messages.find(m => m.type === 'state' && m.path === '_approve' && m.value?.description)
      assert(approveMsgA.value.description.includes('dangerous'), 'S20: WS A received _approve push')

      // 4. WS A 끊기 (클라이언트 측 close)
      connA.ws.close()
      await delay(100)

      // 5. WS B 재연결 — init snapshot 에 _approve 복원 확인
      const connB = await connectWS(port3, { token: token3, sessionId: sid3 })
      await delay(150)
      const initB = connB.messages.find(m => m.type === 'init')
      assert(initB != null, 'S20: WS B received init')
      assert(initB.state._approve != null, 'S20 (KG-07): init snapshot 에 _approve 복원됨')
      assert(initB.state._approve.description.includes('dangerous'),
        `S20 (KG-07): _approve description 복원 (got: ${JSON.stringify(initB.state._approve)})`)

      // 6. POST /approve → approved=true → pending turn 해소
      const approveRes = await post3(`/api/sessions/${sid3}/approve`, { approved: true })
      assert(approveRes.status === 200, 'S20: POST /approve 200')

      // 7. 원래 chat POST 가 완료 응답 반환
      const chatResult = await chatPromise
      assert(chatResult.status === 200, `S20: chat POST 200 (got ${chatResult.status})`)
      assert(chatResult.body.content === 'approved and done',
        `S20: turn 완료 응답 복원 (got: ${JSON.stringify(chatResult.body)})`)

      connB.ws.close()
    } finally {
      await shutdown3()
    }
  }

  summary()
}

run()
