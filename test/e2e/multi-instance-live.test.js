/**
 * Multi-instance live e2e — 실제 오케스트레이터 + 실제 LLM으로 멀티-인스턴스 동작 검증.
 *
 * 사전 조건:
 *   1. ~/.presence/instances.json 에 2개 이상 인스턴스 정의
 *   2. 오케스트레이터 실행 중: npm start
 *
 * 사용법:
 *   node test/e2e/multi-instance-live.test.js [--orchestrator http://127.0.0.1:3010]
 *
 * 커버하는 시나리오:
 *
 * — 기본 인프라 —
 *  ML1.  오케스트레이터 관리 API — 인스턴스 목록 조회
 *  ML2.  각 인스턴스 헬스 — /api/instance 정상 응답 + uptime 검증
 *  ML3.  각 인스턴스 설정 분리 — /api/config에서 model/locale 확인
 *
 * — 대화 + 도구 —
 *  ML4.  인스턴스별 독립 대화 — 실제 LLM 응답 수신
 *  ML5.  도구 실행 — 인스턴스에서 file_list 등 도구 실행 후 결과 반환
 *  ML6.  멀티턴 대화 — 연속 대화에서 컨텍스트 유지 확인
 *
 * — 격리 —
 *  ML7.  세션 격리 — 한 인스턴스의 대화가 다른 인스턴스에 영향 없음
 *  ML8.  히스토리 격리 — 인스턴스 A의 conversationHistory에 B의 내용 없음
 *  ML9.  멀티세션 격리 — 같은 인스턴스 내 세션 간 대화 격리
 *
 * — 동시성 —
 *  ML10. 동시 요청(다른 인스턴스) — 병렬 chat → 각각 독립 완료
 *  ML11. 동시 요청(같은 인스턴스) — 다른 세션에 병렬 chat
 *
 * — 슬래시 커맨드 —
 *  ML12. /tools — 인스턴스별 도구 목록
 *  ML13. /status — 인스턴스별 상태 확인
 *  ML14. /clear — 인스턴스별 히스토리 초기화, 다른 인스턴스 무영향
 *
 * — WebSocket —
 *  ML15. WS init — 인스턴스 직접 WS 연결 + init 메시지
 *  ML16. WS state push — chat 후 turn 변경 push 수신
 *  ML17. WS 멀티 클라이언트 — 같은 인스턴스에 2개 WS, 둘 다 push 수신
 *
 * — 세션 CRUD —
 *  ML18. 세션 생성/대화/삭제 — 전체 lifecycle
 *  ML19. 삭제된 세션 접근 — 404 응답
 *
 * — 에러/경계 —
 *  ML20. 빈 입력 — 400 또는 무시
 *  ML21. 잘못된 JSON body — 에러 응답 후 인스턴스 정상 유지
 *  ML22. 존재하지 않는 인스턴스 관리 — 404
 *  ML23. 에이전트 에러 복구 — 에러 후 idle 복귀
 *
 * — 운영 —
 *  ML24. 인스턴스 restart — 오케스트레이터 restart API 후 서비스 복구
 *  ML25. restart 후 state — 재시작 후 /api/instance 정상
 */

import http from 'node:http'
import { WebSocket } from 'ws'
import { assert, summary } from '../lib/assert.js'

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------

const orchestratorUrl = (() => {
  const idx = process.argv.indexOf('--orchestrator')
  return idx !== -1 ? process.argv[idx + 1] : 'http://127.0.0.1:3010'
})()

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise(r => setTimeout(r, ms))

const request = (baseUrl, method, path, body, { token } = {}) =>
  new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl)
    const data = body ? JSON.stringify(body) : null
    const headers = {
      'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    }
    const req = http.request({ hostname: url.hostname, port: url.port, method, path: url.pathname, headers }, (res) => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }) }
        catch { resolve({ status: res.statusCode, body: buf }) }
      })
    })
    req.on('error', reject)
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('request timeout')) })
    if (data) req.write(data)
    req.end()
  })

// 로그인 헬퍼 — username/password를 CLI 인자 또는 기본값으로
const testUsername = (() => { const idx = process.argv.indexOf('--username'); return idx !== -1 ? process.argv[idx + 1] : 'testuser' })()
const testPassword = (() => { const idx = process.argv.indexOf('--password'); return idx !== -1 ? process.argv[idx + 1] : 'testpass123' })()

const login = async (baseUrl) => {
  const res = await request(baseUrl, 'POST', '/api/auth/login', { username: testUsername, password: testPassword })
  if (res.status !== 200) throw new Error(`Login failed (${res.status}): ${JSON.stringify(res.body)}`)
  return res.body.accessToken
}

const rawRequest = (baseUrl, method, path, rawBody, contentType = 'text/plain', { token } = {}) =>
  new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl)
    const req = http.request({
      hostname: url.hostname, port: url.port, method, path: url.pathname,
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(rawBody), ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
    }, (res) => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }) }
        catch { resolve({ status: res.statusCode, body: buf }) }
      })
    })
    req.on('error', reject)
    req.write(rawBody)
    req.end()
  })

const connectWS = (url, { token } = {}) =>
  new Promise((resolve, reject) => {
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {}
    const ws = new WebSocket(url, { headers })
    const messages = []
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())))
    ws.on('open', () => resolve({ ws, messages }))
    ws.on('error', reject)
    setTimeout(() => reject(new Error('WS connect timeout')), 10_000)
  })

const waitForPort = async (port, { maxMs = 15_000, intervalMs = 500 } = {}) => {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    try {
      const res = await request(`http://127.0.0.1:${port}`, 'GET', '/api/instance')
      if (res.status === 200) return true
    } catch {}
    await delay(intervalMs)
  }
  return false
}

// ---------------------------------------------------------------------------

async function run() {
  console.log('Multi-instance live E2E tests')
  console.log(`  Orchestrator: ${orchestratorUrl}`)

  // =========================================================================
  // ML1. 오케스트레이터 관리 API — 인스턴스 목록
  // =========================================================================
  let instances
  {
    const res = await request(orchestratorUrl, 'GET', '/api/instances')
    assert(res.status === 200, 'ML1: GET /api/instances returns 200')
    assert(Array.isArray(res.body), 'ML1: response is array')
    assert(res.body.length >= 2, `ML1: at least 2 instances (got ${res.body.length})`)
    instances = res.body
    console.log(`  Instances: ${instances.map(i => `${i.id}(:${i.port})`).join(', ')}`)
  }

  const instanceUrls = instances.map(i => ({
    ...i,
    baseUrl: `http://${i.host || '127.0.0.1'}:${i.port}`,
  }))

  // 각 인스턴스에 로그인
  console.log(`  Logging in as: ${testUsername}`)
  const tokens = {}
  for (const inst of instanceUrls) {
    tokens[inst.id] = await login(inst.baseUrl)
  }
  const t = (inst) => tokens[inst.id] // token shorthand

  const inst0 = instanceUrls[0]
  const inst1 = instanceUrls[1]

  // 테스트 전 히스토리 초기화
  for (const inst of instanceUrls) {
    await request(inst.baseUrl, 'POST', '/api/chat', { input: '/clear' }, { token: t(inst) }).catch(() => {})
  }
  await delay(300)

  // =========================================================================
  // ML2. 각 인스턴스 헬스
  // =========================================================================
  for (const inst of instanceUrls) {
    const res = await request(inst.baseUrl, 'GET', '/api/instance')
    assert(res.status === 200, `ML2: [${inst.id}] /api/instance returns 200`)
    assert(res.body.id === inst.id, `ML2: [${inst.id}] instance id matches`)
    assert(res.body.status === 'running', `ML2: [${inst.id}] status is running`)
    assert(typeof res.body.uptime === 'number' && res.body.uptime >= 0, `ML2: [${inst.id}] uptime is non-negative number`)
  }

  // =========================================================================
  // ML3. 각 인스턴스 설정 분리
  // =========================================================================
  {
    const configs = await Promise.all(
      instanceUrls.map(inst => request(inst.baseUrl, 'GET', '/api/config', null, { token: t(inst) }))
    )
    for (let i = 0; i < configs.length; i++) {
      assert(configs[i].status === 200, `ML3: [${instanceUrls[i].id}] config returns 200`)
      assert(typeof configs[i].body.llm?.model === 'string', `ML3: [${instanceUrls[i].id}] has llm.model`)
      assert(typeof configs[i].body.locale === 'string', `ML3: [${instanceUrls[i].id}] has locale`)
      // apiKey가 노출되지 않아야 함
      assert(!configs[i].body.llm?.apiKey, `ML3: [${instanceUrls[i].id}] apiKey not exposed`)
      console.log(`  [${instanceUrls[i].id}] model: ${configs[i].body.llm.model}`)
    }
  }

  // =========================================================================
  // ML4. 인스턴스별 독립 대화 — 실제 LLM 응답
  // =========================================================================
  {
    const res = await request(inst0.baseUrl, 'POST', '/api/chat', { input: '안녕하세요. "HELLO"라고만 답해주세요.' }, { token: t(inst0) })
    assert(res.status === 200, `ML4: [${inst0.id}] chat returns 200`)
    assert(res.body.type === 'agent', `ML4: [${inst0.id}] type is agent`)
    assert(typeof res.body.content === 'string' && res.body.content.length > 0, `ML4: [${inst0.id}] has content`)
    console.log(`  [${inst0.id}] response: ${res.body.content.slice(0, 80)}`)
  }

  // =========================================================================
  // ML5. 도구 실행 — file_list 요청
  // =========================================================================
  {
    await request(inst0.baseUrl, 'POST', '/api/chat', { input: '/clear' }, { token: t(inst0) })
    const res = await request(inst0.baseUrl, 'POST', '/api/chat', { input: '현재 디렉토리의 파일 목록을 file_list 도구로 알려줘.' }, { token: t(inst0) })
    assert(res.status === 200, `ML5: [${inst0.id}] tool chat returns 200`)
    assert(res.body.type === 'agent', `ML5: [${inst0.id}] type is agent`)
    // 도구 결과 또는 파일 관련 텍스트가 있어야 함
    const content = res.body.content || ''
    const hasFileInfo = content.includes('file') || content.includes('파일') || content.includes('.js') || content.includes('package')
    assert(hasFileInfo, `ML5: [${inst0.id}] response contains file information`)
    console.log(`  [${inst0.id}] tool response: ${content.slice(0, 100)}`)
  }

  // =========================================================================
  // ML6. 멀티턴 대화 — 컨텍스트 유지
  // =========================================================================
  {
    await request(inst1.baseUrl, 'POST', '/api/chat', { input: '/clear' }, { token: t(inst1) })
    await request(inst1.baseUrl, 'POST', '/api/chat', { input: '내 이름은 TESTUSER입니다. 기억해주세요.' }, { token: t(inst1) })
    const res = await request(inst1.baseUrl, 'POST', '/api/chat', { input: '방금 내가 말한 이름이 뭐였죠?' }, { token: t(inst1) })
    assert(res.status === 200, `ML6: [${inst1.id}] multi-turn returns 200`)
    const content = (res.body.content || '').toUpperCase()
    assert(content.includes('TESTUSER'), `ML6: [${inst1.id}] LLM remembers context (TESTUSER)`)
  }

  // =========================================================================
  // ML7. 세션 격리 — 대화 내용이 다른 인스턴스에 없음
  // =========================================================================
  {
    const state1 = await request(inst0.baseUrl, 'GET', '/api/state', null, { token: t(inst0) })
    const history0 = state1.body.context?.conversationHistory || []
    const hasTestUser = history0.some(h => JSON.stringify(h).includes('TESTUSER'))
    assert(!hasTestUser, 'ML7: instance 0 has no TESTUSER from instance 1')
  }

  // =========================================================================
  // ML8. 히스토리 격리 — 인스턴스별 turn 독립
  // =========================================================================
  {
    // idle 상태 대기 (다른 테스트의 잔여 working 상태 방지)
    const waitIdle = async (inst) => {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const s = await request(inst.baseUrl, 'GET', '/api/state', null, { token: t(inst) })
        if (s.body.turnState?.tag === 'idle') return s
        await delay(500)
      }
      return request(inst.baseUrl, 'GET', '/api/state', null, { token: t(inst) })
    }
    const [state0, state1] = await Promise.all([waitIdle(inst0), waitIdle(inst1)])
    assert(typeof state0.body.turn === 'number', 'ML8: instance 0 has turn number')
    assert(typeof state1.body.turn === 'number', 'ML8: instance 1 has turn number')
    assert(state0.body.turnState?.tag === 'idle', 'ML8: instance 0 is idle')
    assert(state1.body.turnState?.tag === 'idle', 'ML8: instance 1 is idle')
  }

  // =========================================================================
  // ML9. 멀티세션 격리 — 같은 인스턴스 내 세션 간 대화 격리
  // =========================================================================
  {
    const sid = `ml9-${Date.now()}`
    await request(inst0.baseUrl, 'POST', '/api/sessions', { id: sid, type: 'user' }, { token: t(inst0) })
    await request(inst0.baseUrl, 'POST', `/api/sessions/${sid}/chat`, { input: 'ML9_UNIQUE_TOKEN' }, { token: t(inst0) })

    // user-default 세션의 히스토리에 ML9_UNIQUE_TOKEN이 없어야 함
    const defaultState = await request(inst0.baseUrl, 'GET', '/api/state', null, { token: t(inst0) })
    const defaultHistory = JSON.stringify(defaultState.body.context?.conversationHistory || [])
    assert(!defaultHistory.includes('ML9_UNIQUE_TOKEN'), 'ML9: default session has no ML9 content')

    await request(inst0.baseUrl, 'DELETE', `/api/sessions/${sid}`, null, { token: t(inst0) })
  }

  // =========================================================================
  // ML10. 동시 요청(다른 인스턴스) — 병렬 chat
  // =========================================================================
  {
    await Promise.all(instanceUrls.map(i => request(i.baseUrl, 'POST', '/api/chat', { input: '/clear' }, { token: t(i) })))
    const results = await Promise.all(
      instanceUrls.map(inst =>
        request(inst.baseUrl, 'POST', '/api/chat', { input: '"ACK"라고만 답하세요.' }, { token: t(inst) })
      )
    )
    for (let i = 0; i < results.length; i++) {
      assert(results[i].status === 200, `ML10: [${instanceUrls[i].id}] parallel chat 200`)
      assert(results[i].body.type === 'agent', `ML10: [${instanceUrls[i].id}] type is agent`)
    }
  }

  // =========================================================================
  // ML11. 동시 요청(같은 인스턴스, 다른 세션)
  // =========================================================================
  {
    const s1 = `ml11a-${Date.now()}`
    const s2 = `ml11b-${Date.now()}`
    await request(inst0.baseUrl, 'POST', '/api/sessions', { id: s1, type: 'user' }, { token: t(inst0) })
    await request(inst0.baseUrl, 'POST', '/api/sessions', { id: s2, type: 'user' }, { token: t(inst0) })

    const [r1, r2] = await Promise.all([
      request(inst0.baseUrl, 'POST', `/api/sessions/${s1}/chat`, { input: '"ONE"이라고 답하세요.' }, { token: t(inst0) }),
      request(inst0.baseUrl, 'POST', `/api/sessions/${s2}/chat`, { input: '"TWO"라고 답하세요.' }, { token: t(inst0) }),
    ])
    assert(r1.status === 200, 'ML11: session 1 chat 200')
    assert(r2.status === 200, 'ML11: session 2 chat 200')

    await request(inst0.baseUrl, 'DELETE', `/api/sessions/${s1}`, null, { token: t(inst0) })
    await request(inst0.baseUrl, 'DELETE', `/api/sessions/${s2}`, null, { token: t(inst0) })
  }

  // =========================================================================
  // ML12. /tools — 인스턴스별 도구 목록
  // =========================================================================
  for (const inst of instanceUrls) {
    const res = await request(inst.baseUrl, 'POST', '/api/chat', { input: '/tools' }, { token: t(inst) })
    assert(res.status === 200, `ML12: [${inst.id}] /tools returns 200`)
    assert(res.body.type === 'system', `ML12: [${inst.id}] /tools type is system`)
    assert(res.body.content.includes('file_'), `ML12: [${inst.id}] /tools lists file tools`)
  }

  // =========================================================================
  // ML13. /status — 인스턴스별 상태
  // =========================================================================
  for (const inst of instanceUrls) {
    const res = await request(inst.baseUrl, 'POST', '/api/chat', { input: '/status' }, { token: t(inst) })
    assert(res.status === 200, `ML13: [${inst.id}] /status returns 200`)
    assert(res.body.type === 'system', `ML13: [${inst.id}] /status type is system`)
    assert(res.body.content.includes('idle'), `ML13: [${inst.id}] /status shows idle`)
  }

  // =========================================================================
  // ML14. /clear — 히스토리 초기화, 다른 인스턴스 무영향
  // =========================================================================
  {
    // inst1에 대화 1턴
    await request(inst1.baseUrl, 'POST', '/api/chat', { input: 'ML14 메시지입니다.' }, { token: t(inst1) })
    const beforeState = await request(inst1.baseUrl, 'GET', '/api/state', null, { token: t(inst1) })
    const beforeLen = (beforeState.body.context?.conversationHistory || []).length
    assert(beforeLen > 0, 'ML14: inst1 has history before clear')

    // inst0 turn 기록
    const inst0StateBefore = await request(inst0.baseUrl, 'GET', '/api/state', null, { token: t(inst0) })
    const inst0TurnBefore = inst0StateBefore.body.turn

    // inst1 clear
    await request(inst1.baseUrl, 'POST', '/api/chat', { input: '/clear' }, { token: t(inst1) })
    const afterState = await request(inst1.baseUrl, 'GET', '/api/state', null, { token: t(inst1) })
    const afterLen = (afterState.body.context?.conversationHistory || []).length
    assert(afterLen === 0, 'ML14: inst1 history cleared')

    // inst0 무영향
    const inst0StateAfter = await request(inst0.baseUrl, 'GET', '/api/state', null, { token: t(inst0) })
    assert(inst0StateAfter.body.turn === inst0TurnBefore, 'ML14: inst0 turn unchanged after inst1 clear')
  }

  // =========================================================================
  // ML15. WS init — 인스턴스 직접 WS 연결
  // =========================================================================
  {
    const wsUrl = inst0.baseUrl.replace(/^http/, 'ws')
    const { ws, messages } = await connectWS(wsUrl, { token: t(inst0) })
    await delay(500)

    assert(messages.length > 0, `ML15: [${inst0.id}] received WS messages`)
    assert(messages[0].type === 'init', `ML15: [${inst0.id}] first message is init`)
    assert(messages[0].session_id === 'user-default', `ML15: [${inst0.id}] init for user-default`)
    assert(messages[0].state?.turnState?.tag === 'idle', `ML15: [${inst0.id}] init state is idle`)

    ws.close()
  }

  // =========================================================================
  // ML16. WS state push — chat 후 turn push
  // =========================================================================
  {
    await request(inst0.baseUrl, 'POST', '/api/chat', { input: '/clear' }, { token: t(inst0) })
    const wsUrl = inst0.baseUrl.replace(/^http/, 'ws')
    const { ws, messages } = await connectWS(wsUrl, { token: t(inst0) })
    await delay(300)

    const beforeCount = messages.length
    await request(inst0.baseUrl, 'POST', '/api/chat', { input: '"OK"라고 답하세요.' }, { token: t(inst0) })
    await delay(1500)

    const pushes = messages.slice(beforeCount)
    const turnPush = pushes.find(m => m.type === 'state' && m.path === 'turn')
    assert(turnPush != null, `ML16: [${inst0.id}] turn push received`)
    assert(typeof turnPush.value === 'number', `ML16: [${inst0.id}] turn value is number`)

    const turnStatePushes = pushes.filter(m => m.type === 'state' && m.path === 'turnState')
    assert(turnStatePushes.length > 0, `ML16: [${inst0.id}] turnState pushes received`)

    ws.close()
  }

  // =========================================================================
  // ML17. WS 멀티 클라이언트 — 같은 인스턴스에 2개 WS
  // =========================================================================
  {
    await request(inst0.baseUrl, 'POST', '/api/chat', { input: '/clear' }, { token: t(inst0) })
    const wsUrl = inst0.baseUrl.replace(/^http/, 'ws')
    const { ws: ws1, messages: msg1 } = await connectWS(wsUrl, { token: t(inst0) })
    const { ws: ws2, messages: msg2 } = await connectWS(wsUrl, { token: t(inst0) })
    await delay(300)

    const before1 = msg1.length
    const before2 = msg2.length

    await request(inst0.baseUrl, 'POST', '/api/chat', { input: '"MULTI"라고 답하세요.' }, { token: t(inst0) })
    await delay(1500)

    const pushes1 = msg1.slice(before1)
    const pushes2 = msg2.slice(before2)

    assert(pushes1.some(m => m.type === 'state'), 'ML17: WS client 1 received state push')
    assert(pushes2.some(m => m.type === 'state'), 'ML17: WS client 2 received state push')

    ws1.close()
    ws2.close()
  }

  // =========================================================================
  // ML18. 세션 생성/대화/삭제 — 전체 lifecycle
  // =========================================================================
  {
    const sid = `ml18-${Date.now()}`
    const createRes = await request(inst0.baseUrl, 'POST', '/api/sessions', { id: sid, type: 'user' }, { token: t(inst0) })
    assert(createRes.status === 201, `ML18: session create 201`)

    const chatRes = await request(inst0.baseUrl, 'POST', `/api/sessions/${sid}/chat`, { input: '테스트입니다.' }, { token: t(inst0) })
    assert(chatRes.status === 200, 'ML18: session chat 200')

    const stateRes = await request(inst0.baseUrl, 'GET', `/api/sessions/${sid}/state`, null, { token: t(inst0) })
    assert(stateRes.status === 200, 'ML18: session state 200')
    assert(stateRes.body.turn >= 1, 'ML18: session turn >= 1')

    const delRes = await request(inst0.baseUrl, 'DELETE', `/api/sessions/${sid}`, null, { token: t(inst0) })
    assert(delRes.status === 200, 'ML18: session delete 200')
  }

  // =========================================================================
  // ML19. 삭제된 세션 접근 — 404
  // =========================================================================
  {
    const res = await request(inst0.baseUrl, 'GET', '/api/sessions/nonexistent-session/state', null, { token: t(inst0) })
    assert(res.status === 404, 'ML19: deleted/nonexistent session state returns 404')

    const chatRes = await request(inst0.baseUrl, 'POST', '/api/sessions/nonexistent-session/chat', { input: 'test' }, { token: t(inst0) })
    assert(chatRes.status === 404, 'ML19: deleted/nonexistent session chat returns 404')
  }

  // =========================================================================
  // ML20. 빈 입력 — 400 응답
  // =========================================================================
  {
    const res = await request(inst0.baseUrl, 'POST', '/api/chat', { input: '' }, { token: t(inst0) })
    assert(res.status === 400, 'ML20: empty input returns 400')

    const res2 = await request(inst0.baseUrl, 'POST', '/api/chat', {}, { token: t(inst0) })
    assert(res2.status === 400, 'ML20: missing input returns 400')
  }

  // =========================================================================
  // ML21. 잘못된 JSON body — 에러 후 인스턴스 정상
  // =========================================================================
  {
    const res = await rawRequest(inst0.baseUrl, 'POST', '/api/chat', '<<<not json>>>', 'application/json', { token: t(inst0) })
    // Express는 JSON parse 실패 시 400 반환
    assert(res.status >= 400, 'ML21: malformed JSON returns error status')

    // 인스턴스 정상 유지 확인
    const health = await request(inst0.baseUrl, 'GET', '/api/instance')
    assert(health.status === 200, 'ML21: instance still healthy after malformed request')
    assert(health.body.status === 'running', 'ML21: instance still running')
  }

  // =========================================================================
  // ML22. 존재하지 않는 인스턴스 관리
  // =========================================================================
  {
    const res = await request(orchestratorUrl, 'POST', '/api/instances/nonexistent/stop')
    assert(res.status === 404, 'ML22: stop nonexistent instance returns 404')

    const res2 = await request(orchestratorUrl, 'POST', '/api/instances/nonexistent/restart')
    assert(res2.status === 404, 'ML22: restart nonexistent instance returns 404')
  }

  // =========================================================================
  // ML23. 에이전트 에러 복구 — 에러 후 idle 복귀
  // =========================================================================
  {
    await request(inst0.baseUrl, 'POST', '/api/chat', { input: '/clear' }, { token: t(inst0) })

    // 극단적으로 긴 반복 입력 (에이전트가 처리 중 에러 가능성)
    const res = await request(inst0.baseUrl, 'POST', '/api/chat', { input: '다음 JSON을 파싱해줘: {"a":' + '{"b":'.repeat(50) + '"end"' + '}'.repeat(50) + '}' }, { token: t(inst0) })
    // 성공이든 에러든 응답이 와야 함
    assert(res.status === 200 || res.status === 500, 'ML23: response received for complex input')

    // idle 복귀 확인
    await delay(500)
    const state = await request(inst0.baseUrl, 'GET', '/api/state', null, { token: t(inst0) })
    assert(state.body.turnState?.tag === 'idle', 'ML23: instance returns to idle after complex input')
  }

  // =========================================================================
  // ML24 + ML25. 인스턴스 restart — 서비스 복구
  // =========================================================================
  {
    const targetInst = instanceUrls[instanceUrls.length - 1] // 마지막 인스턴스로 테스트

    const restartRes = await request(orchestratorUrl, 'POST', `/api/instances/${targetInst.id}/restart`)
    assert(restartRes.status === 200, `ML24: [${targetInst.id}] restart returns 200`)

    // 재시작 대기
    const ready = await waitForPort(targetInst.port)
    assert(ready, `ML24: [${targetInst.id}] reachable after restart`)

    // 재시작 후 정상 동작
    const health = await request(targetInst.baseUrl, 'GET', '/api/instance')
    assert(health.status === 200, `ML25: [${targetInst.id}] /api/instance 200 after restart`)
    assert(health.body.id === targetInst.id, `ML25: [${targetInst.id}] id correct after restart`)
    assert(health.body.status === 'running', `ML25: [${targetInst.id}] running after restart`)

    // 재시작 후 재로그인
    tokens[targetInst.id] = await login(targetInst.baseUrl)

    // 재시작 후 chat 가능
    const chatRes = await request(targetInst.baseUrl, 'POST', '/api/chat', { input: '"RESTARTED"라고 답하세요.' }, { token: t(targetInst) })
    assert(chatRes.status === 200, `ML25: [${targetInst.id}] chat works after restart`)
    assert(chatRes.body.type === 'agent', `ML25: [${targetInst.id}] agent response after restart`)
  }

  // =========================================================================
  // 정리
  // =========================================================================
  for (const inst of instanceUrls) {
    await request(inst.baseUrl, 'POST', '/api/chat', { input: '/clear' }, { token: t(inst) }).catch(() => {})
  }

  summary()
}

run().catch(err => {
  console.error(`Live test failed: ${err.message}`)
  process.exit(1)
})
