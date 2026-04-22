/**
 * Live e2e 테스트 공용 인프라.
 * 서버 접속, 인증, MirrorState 연결, App 렌더링을 캡슐화.
 */

import React from 'react'
import { render } from 'ink-testing-library'
import http from 'node:http'
import { join } from 'node:path'
import { createMirrorState } from '@presence/infra/infra/states/mirror-state.js'
import { App } from '@presence/tui/ui/App.js'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import { removeUserCompletely } from '@presence/infra/infra/auth/remove-user.js'
import { Config } from '@presence/infra/infra/config.js'
import { initI18n } from '@presence/infra/i18n'

initI18n('ko')
const h = React.createElement

// =============================================================================
// CLI 인자 파싱
// =============================================================================

const cliArg = (name, fallback) => {
  const idx = process.argv.indexOf(`--${name}`)
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback
}

const hasFlag = (name) => process.argv.includes(`--${name}`)

const BASE_URL = cliArg('url', 'http://127.0.0.1:3000')
const WS_URL = BASE_URL.replace(/^http/, 'ws')
// 기존 --username/--password 는 고정 유저 지정용. 생략 시 임시 유저 자동 생성.
const OVERRIDE_USERNAME = cliArg('username', null)
const OVERRIDE_PASSWORD = cliArg('password', null)
const KEEP_USER = hasFlag('keep-user')
const LLM_TIMEOUT = 120_000

// =============================================================================
// HTTP
// =============================================================================

let accessToken = null

const httpRequest = (method, path, body) =>
  new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL)
    const data = body ? JSON.stringify(body) : null
    const headers = { 'Content-Type': 'application/json' }
    if (data) headers['Content-Length'] = Buffer.byteLength(data)
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`
    const req = http.request(
      { hostname: url.hostname, port: url.port, method, path: url.pathname, headers },
      (res) => {
        let buf = ''
        res.on('data', (chunk) => { buf += chunk })
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

// =============================================================================
// 유틸리티
// =============================================================================

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const waitFor = (fn, { timeout = LLM_TIMEOUT, interval = 100 } = {}) =>
  new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      try {
        const result = fn()
        if (result) { resolve(result); return }
      } catch (_) {}
      if (Date.now() - start > timeout) {
        reject(new Error(`waitFor timeout (${timeout}ms): ${fn.toString().slice(0, 80)}`))
        return
      }
      setTimeout(check, interval)
    }
    check()
  })

const typeInput = async (stdin, text) => {
  for (const ch of text) { stdin.write(ch); await delay(10) }
  stdin.write('\r')
  await delay(20)
}

// idle 복귀 대기
const waitIdle = (lastFrame) => waitFor(
  () => lastFrame().includes('idle') && !lastFrame().includes('thinking'),
  { timeout: LLM_TIMEOUT },
)

// 턴 완료 대기 (turn 값 변경 + idle)
const waitTurnComplete = async (remoteState, lastFrame, turnBefore) => {
  await waitFor(
    () => (remoteState.get('turn') ?? 0) !== turnBefore,
    { timeout: LLM_TIMEOUT },
  )
  await waitIdle(lastFrame)
}

// 메시지를 보내고 응답 완료까지 대기
const sendAndWait = async (stdin, remoteState, lastFrame, message) => {
  const turnBefore = remoteState.get('turn') ?? 0
  await typeInput(stdin, message)
  await waitTurnComplete(remoteState, lastFrame, turnBefore)
}

// =============================================================================
// 서버 접속 + 인증
// =============================================================================

// 임시 유저 생성 + 비밀번호 변경 (mustChangePassword 해제).
// --username/--password 플래그 있으면 그걸로 로그인만 수행 (기존 동작 유지).
const authenticate = async () => {
  if (OVERRIDE_USERNAME && OVERRIDE_PASSWORD) {
    const loginRes = await httpRequest('POST', '/api/auth/login', { username: OVERRIDE_USERNAME, password: OVERRIDE_PASSWORD })
    if (!loginRes.body?.accessToken) {
      console.error('로그인 실패:', loginRes.body?.error || loginRes.body)
      process.exit(1)
    }
    accessToken = loginRes.body.accessToken
    return { username: OVERRIDE_USERNAME, store: null }
  }

  // 임시 유저 자동 생성
  // username 은 agent-id agentName part 규칙 (kebab-case, 언더바 금지) 준수.
  // docs/specs/agent-identity.md I1 — agentId 의 username 부분도 같은 제약.
  const username = `livetest-${Date.now().toString(36)}`
  const INITIAL_PW = 'init_password_1234'
  const NEW_PW = 'new_password_5678'

  const store = createUserStore()
  await store.addUser(username, INITIAL_PW)
  console.log(`[setup] 임시 테스트 유저 생성: ${username}`)

  const loginRes = await httpRequest('POST', '/api/auth/login', { username, password: INITIAL_PW })
  if (!loginRes.body?.accessToken) {
    console.error('로그인 실패:', loginRes.body)
    try { store.removeUser(username) } catch (_) {}
    process.exit(1)
  }
  accessToken = loginRes.body.accessToken

  // addUser 가 mustChangePassword=true 로 생성 → 변경 1회 수행
  const changeRes = await httpRequest('POST', '/api/auth/change-password', { currentPassword: INITIAL_PW, newPassword: NEW_PW })
  if (!changeRes.body?.accessToken) {
    console.error('비밀번호 변경 실패:', changeRes.body)
    try { store.removeUser(username) } catch (_) {}
    process.exit(1)
  }
  accessToken = changeRes.body.accessToken

  // 이상 종료 시에도 유저를 남기지 않음
  process.on('exit', () => {
    if (!KEEP_USER) try { store.removeUser(username) } catch (_) {}
  })

  return { username, store }
}

const connect = async () => {
  const instanceRes = await httpRequest('GET', '/api/instance').catch(() => null)
  if (!instanceRes || instanceRes.status !== 200) {
    console.error(`서버에 연결할 수 없습니다: ${BASE_URL}`)
    console.error('먼저 npm start 를 실행하세요.')
    process.exit(1)
  }

  const authRequired = instanceRes.body?.authRequired === true
  let sessionId = 'user-default'
  let username = null
  let store = null

  if (authRequired) {
    const auth = await authenticate()
    username = auth.username
    store = auth.store
    sessionId = `${username}-default`
  }

  const apiBase = `/api/sessions/${sessionId}`
  const [toolsRes, agentsRes, configRes] = await Promise.all([
    httpRequest('GET', `${apiBase}/tools`).catch(() => ({ body: [] })),
    httpRequest('GET', `${apiBase}/agents`).catch(() => ({ body: [] })),
    httpRequest('GET', `${apiBase}/config`).catch(() => ({ body: {} })),
  ])

  const teardown = async () => {
    if (KEEP_USER) {
      if (username) console.log(`[teardown] --keep-user — 유저 ${username} 유지`)
      return
    }
    if (!username || !store) return
    try {
      const userDir = join(Config.presenceDir(), 'users', username)
      await removeUserCompletely({ store, memory: null, username, userDir })
      console.log(`[teardown] 임시 유저 삭제: ${username}`)
    } catch (err) {
      console.error(`[teardown] 유저 삭제 실패:`, err.message)
    }
  }

  return {
    sessionId, authRequired, username, teardown,
    tools: Array.isArray(toolsRes.body) ? toolsRes.body : [],
    agents: Array.isArray(agentsRes.body) ? agentsRes.body : [],
    config: configRes.body || {},
  }
}

// =============================================================================
// 테스트 setup
// =============================================================================

const setup = async (serverInfo) => {
  const { sessionId, tools, agents, config } = serverInfo
  const apiBase = `/api/sessions/${sessionId}`

  // 이전 턴 완료 대기 (서버 state가 idle이 될 때까지, REST 폴링)
  for (let attempt = 0; attempt < 60; attempt++) {
    const stateRes = await httpRequest('GET', `${apiBase}/state`).catch(() => ({ body: {} }))
    if (stateRes.body?.turnState?.tag === 'idle') break
    await delay(1000)
  }

  // 이전 대화 초기화
  await httpRequest('POST', `${apiBase}/chat`, { input: '/clear' }).catch(() => {})
  await delay(500)

  // /clear 후 idle 복귀 대기
  for (let attempt = 0; attempt < 30; attempt++) {
    const stateRes = await httpRequest('GET', `${apiBase}/state`).catch(() => ({ body: {} }))
    if (stateRes.body?.turnState?.tag === 'idle') break
    await delay(500)
  }

  // MirrorState 연결
  const wsHeaders = accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
  const remoteState = createMirrorState({ wsUrl: WS_URL, sessionId, headers: wsHeaders })
  await waitFor(() => remoteState.get('turnState') !== undefined, { timeout: 10000 })
  await waitFor(() => remoteState.get('turnState')?.tag === 'idle', { timeout: 15000 }).catch(() => {})

  // App 렌더
  const onInput = (input) => httpRequest('POST', `${apiBase}/chat`, { input }).then(res => res.body?.content ?? null)
  const onApprove = (approved) => httpRequest('POST', `${apiBase}/approve`, { approved })
  const onCancel = () => httpRequest('POST', `${apiBase}/cancel`)
  const onListSessions = () => httpRequest('GET', '/api/sessions').then(res => Array.isArray(res.body) ? res.body : [])
  const onCreateSession = (id) => httpRequest('POST', '/api/sessions', { id, type: 'user' }).then(res => res.body)
  const onDeleteSession = (id) => httpRequest('DELETE', `/api/sessions/${id}`)

  const { lastFrame, stdin, unmount } = render(h(App, {
    state: remoteState, onInput, onApprove, onCancel,
    tools, agents, cwd: process.cwd(), gitBranch: '', model: config.llm?.model || '',
    config, memory: null, llm: null, toolRegistry: null, initialMessages: [],
    sessionId, onListSessions, onCreateSession, onDeleteSession,
  }))

  const cleanup = () => { unmount(); remoteState.disconnect() }
  return { remoteState, lastFrame, stdin, cleanup }
}

// =============================================================================
// Probe helpers — live-probes 테스트 전용.
// REST 만으로 chat 한 번 돌리고 toolTranscript 에서 tool 호출 결과 추출.
// TUI 렌더/setup 없이 빠르게 검증 가능. 임시 유저/정리는 connect() 가 보장.
// =============================================================================

// chat 호출 → toolTranscript 추출. 외부에서 assertion 수행.
// input 앞에 /clear 를 먼저 전송해 이전 대화 맥락을 초기화.
const probeTool = async (serverInfo, { input, toolName } = {}) => {
  const apiBase = `/api/sessions/${serverInfo.sessionId}`
  await httpRequest('POST', `${apiBase}/chat`, { input: '/clear' }).catch(() => {})
  const t0 = Date.now()
  const chatRes = await httpRequest('POST', `${apiBase}/chat`, { input })
  const elapsed = Date.now() - t0
  const stateRes = await httpRequest('GET', `${apiBase}/state`)
  const toolTranscript = stateRes.body?._toolTranscript || []
  const entries = toolName
    ? toolTranscript.filter(e => e.tool === toolName)
    : toolTranscript
  return { elapsed, status: chatRes.status, response: chatRes.body, toolTranscript, entries }
}

export {
  connect, setup, delay, waitFor, waitIdle, waitTurnComplete,
  typeInput, sendAndWait, httpRequest, probeTool, LLM_TIMEOUT,
}
