/**
 * Live LLM focused test — 메시지 아키텍처 재설계 회귀 검증.
 *
 * 목적:
 *   - 이번 재설계로 변경된 서버/TUI 경계 동작을 실제 LLM + 실제 WS 로 확인
 *   - `tui-live.test.js` 는 전체 기능(slash, tools, sessions…) 을 커버하고 느리므로
 *     이 파일은 재설계 핵심 5개 시나리오만 빠르게 회귀
 *
 * 검증 시나리오:
 *   F1. pendingInput 즉시 표시 + `{input, ts}` 구조 — LLM 응답 전에 UI 가 입력을 렌더
 *   F2. 턴 완료 후 유저 입력 중복 없음 — pending → persisted 전환 시 dedup
 *   F3. cancel (진행 중 턴) → executor.recover 가 cancelled turn + SYSTEM cancel entry 기록
 *   F4. /clear → history/pendingInput/toolTranscript/budgetWarning 모두 초기화 (INV-CLR-1)
 *   F5. MirrorState.cache 에 _pendingInput, _toolTranscript path 존재
 *
 * 인프라:
 *   - 전용 테스트 유저를 매 실행마다 생성 → 비밀번호 변경 → 테스트 수행 → 완전 삭제
 *   - 영속 유저를 남기지 않으므로 `livetest` 같은 고정 계정이 users.json 에 쌓이지 않음
 *   - 서버는 이미 실행 중이어야 함 (`npm start`). 테스트는 인증 + 세션만 관리
 *
 * 실행:
 *   npm start                                # 다른 터미널에서 서버 먼저
 *   node test/e2e/tui-live-focus.test.js [--url http://127.0.0.1:3000]
 *
 * CLI 옵션 (거의 기본값 사용):
 *   --url       서버 URL (기본 http://127.0.0.1:3000)
 *   --keep-user 삭제 건너뛰기 (디버깅용, 실패 시 로그인 상태 유지)
 *
 * tui-live.test.js 와의 차이:
 *   - tui-live.test.js: 전체 기능 스모크 (slash commands, tools, sessions, …)
 *   - tui-live-focus.test.js: 메시지 아키텍처(FP-61/KG-14) 회귀 전용
 */

import React from 'react'
import { render } from 'ink-testing-library'
import http from 'node:http'
import { createMirrorState } from '@presence/infra/infra/states/mirror-state.js'
import { App } from '@presence/tui/ui/App.js'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import { removeUserCompletely } from '@presence/infra/infra/auth/remove-user.js'
import { Config } from '@presence/infra/infra/config.js'
import { initI18n } from '@presence/infra/i18n'
import { join } from 'node:path'
import { assert, summary } from '../lib/assert.js'

initI18n('ko')
const h = React.createElement

const cliArg = (name, fallback) => {
  const idx = process.argv.indexOf(`--${name}`)
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback
}

const hasFlag = (name) => process.argv.includes(`--${name}`)

const BASE_URL = cliArg('url', 'http://127.0.0.1:3000')
const WS_URL = BASE_URL.replace(/^http/, 'ws')
// 테스트 유저 — 매 실행마다 고유 이름으로 생성/삭제.
const USERNAME = `livefocus_${Date.now().toString(36)}`
const INITIAL_PW = 'init_password_1234'
const NEW_PW = 'new_password_5678'
const KEEP_USER = hasFlag('keep-user')
const LLM_TIMEOUT = 300_000   // 5분 — 로컬 LLM 은 느림

let accessToken = null

const httpRequest = (method, path, body) => new Promise((resolve, reject) => {
  const url = new URL(path, BASE_URL)
  const data = body ? JSON.stringify(body) : null
  const headers = { 'Content-Type': 'application/json' }
  if (data) headers['Content-Length'] = Buffer.byteLength(data)
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`
  const req = http.request(
    { hostname: url.hostname, port: url.port, method, path: url.pathname, headers },
    (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }) }
        catch { resolve({ status: res.statusCode, body: buf }) }
      })
    },
  )
  req.on('error', reject)
  if (data) req.write(data)
  req.end()
})

const delay = (ms) => new Promise(r => setTimeout(r, ms))
const waitFor = (fn, { timeout = LLM_TIMEOUT, interval = 100 } = {}) => new Promise((resolve, reject) => {
  const start = Date.now()
  const check = () => {
    try { if (fn()) return resolve() } catch (_) {}
    if (Date.now() - start > timeout) return reject(new Error(`waitFor timeout (${timeout}ms)`))
    setTimeout(check, interval)
  }
  check()
})

const typeInput = async (stdin, text) => {
  for (const ch of text) { stdin.write(ch); await delay(5) }
  stdin.write('\r')
  await delay(30)
}

// --- 서버 연결 확인 ---
const instanceRes = await httpRequest('GET', '/api/instance').catch(() => null)
if (!instanceRes || instanceRes.status !== 200) {
  console.error(`서버 연결 실패: ${BASE_URL}`)
  process.exit(1)
}

// --- 전용 테스트 유저 생성 (매 실행마다 신규) ---
const store = createUserStore()
await store.addUser(USERNAME, INITIAL_PW)
console.log(`[setup] 테스트 유저 생성: ${USERNAME}`)

const teardown = async () => {
  if (KEEP_USER) {
    console.log(`[teardown] --keep-user 플래그 — 유저 ${USERNAME} 유지`)
    return
  }
  try {
    const userDir = join(Config.presenceDir(), 'users', USERNAME)
    await removeUserCompletely({ store, memory: null, username: USERNAME, userDir })
    console.log(`[teardown] 테스트 유저 삭제: ${USERNAME}`)
  } catch (err) {
    console.error(`[teardown] 유저 삭제 실패:`, err.message)
  }
}

// 프로세스 종료 시 반드시 삭제 (assertion 실패 시에도).
process.on('exit', () => {
  // sync 경로 — store.removeUser 만 호출 (간단한 경우)
  if (!KEEP_USER) try { store.removeUser(USERNAME) } catch (_) {}
})

// --- 로그인 + mustChangePassword 처리 ---
const loginRes = await httpRequest('POST', '/api/auth/login', { username: USERNAME, password: INITIAL_PW })
if (!loginRes.body?.accessToken) {
  console.error('로그인 실패:', loginRes.body)
  await teardown()
  process.exit(1)
}
accessToken = loginRes.body.accessToken

// addUser 가 mustChangePassword=true 를 설정하므로 변경 1회 수행.
const changeRes = await httpRequest('POST', '/api/auth/change-password', { currentPassword: INITIAL_PW, newPassword: NEW_PW })
if (!changeRes.body?.accessToken) {
  console.error('비밀번호 변경 실패:', changeRes.body)
  await teardown()
  process.exit(1)
}
accessToken = changeRes.body.accessToken

const sessionId = `${USERNAME}-default`
const apiBase = `/api/sessions/${sessionId}`

// tools/agents/config
const [toolsRes, agentsRes, configRes] = await Promise.all([
  httpRequest('GET', `${apiBase}/tools`).catch(() => ({ body: [] })),
  httpRequest('GET', `${apiBase}/agents`).catch(() => ({ body: [] })),
  httpRequest('GET', `${apiBase}/config`).catch(() => ({ body: {} })),
])
const tools = Array.isArray(toolsRes.body) ? toolsRes.body : []
const agents = Array.isArray(agentsRes.body) ? agentsRes.body : []
const config = configRes.body || {}

console.log(`Live focus e2e — model=${config.llm?.model}, session=${sessionId}`)

const setup = async () => {
  await httpRequest('POST', `${apiBase}/chat`, { input: '/clear' }).catch(() => {})
  await delay(300)
  const remoteState = createMirrorState({ wsUrl: WS_URL, sessionId, headers: { Authorization: `Bearer ${accessToken}` } })
  await waitFor(() => remoteState.get('turnState') !== undefined, { timeout: 10000 })
  await waitFor(() => remoteState.get('turnState')?.tag === 'idle', { timeout: 15000 }).catch(() => {})

  const onInput = (i) => httpRequest('POST', `${apiBase}/chat`, { input: i }).then(r => r.body?.content ?? null)
  const onApprove = (a) => httpRequest('POST', `${apiBase}/approve`, { approved: a })
  const onCancel = () => httpRequest('POST', `${apiBase}/cancel`)

  const { lastFrame, stdin, unmount } = render(h(App, {
    state: remoteState, onInput, onApprove, onCancel,
    tools, agents, cwd: process.cwd(), gitBranch: '',
    model: config.llm?.model || '',
    config, memory: null, llm: null, toolRegistry: null, initialMessages: [], sessionId,
  }))
  const cleanup = () => { unmount(); remoteState.disconnect() }
  return { remoteState, lastFrame, stdin, cleanup }
}

// =============================================================================
// F1 + F2. pendingInput 즉시 표시 + 턴 완료 후 중복 없음
// =============================================================================
{
  const { remoteState, lastFrame, stdin, cleanup } = await setup()
  try {
    const UNIQUE = `pendtest_${Date.now()}`
    const turnBefore = remoteState.get('turn') ?? 0

    await typeInput(stdin, `${UNIQUE} - 한 문장으로 답해주세요.`)

    // F1. 1-2초 내 pending 이 화면에 떠야 함 (LLM 응답 도착 전)
    await waitFor(() => lastFrame().includes(UNIQUE), { timeout: 5000 })
    const pending = remoteState.get('_pendingInput')
    assert(pending && pending.input.includes(UNIQUE), 'F1: _pendingInput 서버 state 에 설정됨')
    assert(pending && typeof pending.ts === 'number', 'F1: _pendingInput.ts 필드 포함')
    assert(lastFrame().includes(UNIQUE), 'F1: pendingInput 즉시 렌더')

    // 턴 완료 대기
    await waitFor(() => (remoteState.get('turn') ?? 0) !== turnBefore, { timeout: LLM_TIMEOUT })
    await waitFor(() => remoteState.get('turnState')?.tag === 'idle', { timeout: 30000 })

    // F2. history 에 turn entry 기록, pendingInput null, 화면에 UNIQUE 1번만
    const history = remoteState.get('context.conversationHistory') || []
    const lastTurn = [...history].reverse().find(e => !e.type || e.type === 'turn')
    assert(lastTurn && lastTurn.input.includes(UNIQUE), 'F2: history 에 turn entry 기록')
    assert(remoteState.get('_pendingInput') === null, 'F2: _pendingInput null 로 정리')

    const frame = lastFrame()
    const firstIdx = frame.indexOf(UNIQUE)
    const lastIdx = frame.lastIndexOf(UNIQUE)
    assert(firstIdx !== -1, 'F2: UNIQUE 입력 프레임에 존재')

    // agent 응답이 UNIQUE 를 echo 할 가능성이 있으므로, agent output 에 UNIQUE 포함된 경우는 제외.
    // history 에서 실제로 유저 entry 가 몇 개인지, agent output 이 UNIQUE 포함하는지 체크.
    const finalHistory = remoteState.get('context.conversationHistory') || []
    const userTurns = finalHistory.filter(e => (!e.type || e.type === 'turn') && e.input?.includes(UNIQUE))
    const agentEchos = finalHistory.filter(e => (!e.type || e.type === 'turn') && e.output?.includes(UNIQUE))
    console.log('[DEBUG F2] userTurns:', userTurns.length, 'agentEchos:', agentEchos.length)

    if (agentEchos.length === 0) {
      assert(firstIdx === lastIdx, 'F2: UNIQUE 입력 중복 없음 (pending → persisted 전환)')
    } else {
      // agent 가 UNIQUE 를 echo 한 경우: history 에 userTurn 1개만 있으면 pending 은 이미 dedup.
      assert(userTurns.length === 1, 'F2: history 에 userTurn 1개 (agent echo 와 무관)')
    }
  } finally { cleanup() }
}

// =============================================================================
// F3. cancel → SYSTEM entry 기록
// =============================================================================
{
  const { remoteState, lastFrame, stdin, cleanup } = await setup()
  try {
    const UNIQUE = `canceltest_${Date.now()}`
    const hist0 = (remoteState.get('context.conversationHistory') || []).length
    await typeInput(stdin, `${UNIQUE} 한국의 역사를 최대한 자세하게, 모든 시대를 빠짐없이 5000자 이상으로 설명해주세요.`)

    // working 상태 대기 후 즉시 REST /cancel 전송.
    // LLM 속도에 따라 두 경로 중 하나를 탄다 — 두 경로 모두 검증 목표.
    //   A. abort 확정 (LLM 진행 중 abort): cancelled turn + SYSTEM cancel entry 2개 append
    //   B. 후행 cancel (LLM 이 cancel 도착 전 finish): 마지막 turn 에 cancelled=true 플래그
    await waitFor(() => remoteState.get('turnState')?.tag === 'working', { timeout: 10000 })
    await httpRequest('POST', `${apiBase}/cancel`)

    // turn 이 idle 로 복귀 대기
    await waitFor(() => remoteState.get('turnState')?.tag === 'idle', { timeout: 60000 })
    await delay(500) // WS 패치 도착 여유

    const history = remoteState.get('context.conversationHistory') || []
    console.log('[DEBUG F3] history.length:', history.length, 'hist0:', hist0)
    if (history.length > hist0) {
      const added = history.slice(hist0)
      console.log('[DEBUG F3] added entries:', JSON.stringify(added, null, 2).slice(0, 500))
    }

    // 두 경로 공통: history 에 최소 1 entry 추가, 해당 turn 은 cancelled 표시
    assert(history.length > hist0, 'F3: history 에 entry 추가 (최소 1개)')
    const lastTurn = [...history].reverse().find(e => !e.type || e.type === 'turn')
    assert(lastTurn?.cancelled === true, 'F3: 최근 turn 에 cancelled 플래그 (abort 또는 후행 cancel)')

    // abort path 는 추가로 SYSTEM cancel entry + errorKind=aborted 를 기록
    const systemCancelEntries = history.slice(hist0).filter(e => e.type === 'system' && e.tag === 'cancel')
    if (lastTurn.errorKind === 'aborted') {
      assert(systemCancelEntries.length === 1, 'F3 (abort path): SYSTEM cancel entry 1개')
      assert(systemCancelEntries[0].content?.includes('취소'), 'F3 (abort path): SYSTEM content 한글 메시지')
      console.log('[DEBUG F3] path = abort 확정 (executor.recover)')
    } else {
      assert(systemCancelEntries.length === 0, 'F3 (후행 cancel): SYSTEM cancel entry 없음 (의도된 동작)')
      console.log('[DEBUG F3] path = 후행 cancel (markLastTurnCancelledSync)')
    }
    assert(remoteState.get('_pendingInput') === null, 'F3: _pendingInput null 정리')
  } finally { cleanup() }
}

// =============================================================================
// F4. /clear → history/pendingInput/toolTranscript/budgetWarning 초기화
// =============================================================================
{
  const { remoteState, lastFrame, stdin, cleanup } = await setup()
  try {
    // 먼저 간단한 질문으로 history 에 entry 생성
    const turnBefore = remoteState.get('turn') ?? 0
    await typeInput(stdin, '하이라고 답해주세요')
    await waitFor(() => (remoteState.get('turn') ?? 0) !== turnBefore, { timeout: LLM_TIMEOUT })
    await waitFor(() => remoteState.get('turnState')?.tag === 'idle', { timeout: 30000 })
    assert((remoteState.get('context.conversationHistory') || []).length > 0, 'F4: history 에 entry 존재')

    // /clear 실행 — history 가 비워질 때까지 최대 10초 대기.
    // TUI dispatch 는 fire-and-forget 이라 WS 왕복 필요.
    await typeInput(stdin, '/clear')
    try {
      await waitFor(() => (remoteState.get('context.conversationHistory') || []).length === 0, { timeout: 10000 })
    } catch (_) {
      console.log('[DEBUG F4] hist after timeout:', JSON.stringify(remoteState.get('context.conversationHistory')))
      console.log('[DEBUG F4] pending:', JSON.stringify(remoteState.get('_pendingInput')))
    }

    const history = remoteState.get('context.conversationHistory') || []
    assert(history.length === 0, 'F4: /clear 후 history 초기화')
    assert(remoteState.get('_pendingInput') === null, 'F4: /clear 후 _pendingInput null')
    const transcript = remoteState.get('_toolTranscript') || []
    assert(transcript.length === 0, 'F4: /clear 후 _toolTranscript 초기화')
    assert(remoteState.get('_budgetWarning') === null, 'F4: /clear 후 _budgetWarning null')
  } finally { cleanup() }
}

// =============================================================================
// F5. MirrorState cache 에 신규 path 존재
// =============================================================================
{
  const { remoteState, cleanup } = await setup()
  try {
    assert('_toolTranscript' in remoteState.cache, 'F5: _toolTranscript SNAPSHOT_PATHS 포함')
    assert('_pendingInput' in remoteState.cache, 'F5: _pendingInput SNAPSHOT_PATHS 포함')
  } finally { cleanup() }
}

summary()
await teardown()
