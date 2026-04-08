/**
 * TUI live e2e — 실제 서버 + 실제 LLM으로 TUI 흐름 검증.
 *
 * 사전 조건: 서버가 실행 중이어야 한다.
 *   npm start
 *
 * 실행:
 *   node test/e2e/tui-live.test.js [--url http://127.0.0.1:3000] [--username X] [--password X]
 */

import React from 'react'
import { render } from 'ink-testing-library'
import http from 'node:http'
import { createMirrorState } from '@presence/infra/infra/states/mirror-state.js'
import { App } from '@presence/tui/ui/App.js'
import { initI18n } from '@presence/infra/i18n'
import { assert, summary } from '../lib/assert.js'

initI18n('ko')
const h = React.createElement

// =============================================================================
// CLI 인자 파싱
// =============================================================================

const cliArg = (name, fallback) => {
  const idx = process.argv.indexOf(`--${name}`)
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback
}

const BASE_URL = cliArg('url', 'http://127.0.0.1:3000')
const WS_URL = BASE_URL.replace(/^http/, 'ws')
const USERNAME = cliArg('username', 'anthony')
const PASSWORD = cliArg('password', 'testpass123')
const LLM_TIMEOUT = 120_000

// =============================================================================
// HTTP 헬퍼
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

// =============================================================================
// 서버 접속 + 인증
// =============================================================================

const instanceRes = await httpRequest('GET', '/api/instance').catch(() => null)
if (!instanceRes || instanceRes.status !== 200) {
  console.error(`서버에 연결할 수 없습니다: ${BASE_URL}`)
  console.error('먼저 npm start 를 실행하세요.')
  process.exit(1)
}

const authRequired = instanceRes.body?.authRequired === true
let sessionId = 'user-default'

if (authRequired) {
  const loginRes = await httpRequest('POST', '/api/auth/login', { username: USERNAME, password: PASSWORD })
  if (!loginRes.body?.accessToken) {
    console.error('로그인 실패:', loginRes.body?.error || loginRes.body)
    process.exit(1)
  }
  accessToken = loginRes.body.accessToken
  sessionId = `${USERNAME}-default`
}

// 세션 API를 통해 tools, agents, config 조회
const apiBase = `/api/sessions/${sessionId}`
const [toolsRes, agentsRes, configRes] = await Promise.all([
  httpRequest('GET', `${apiBase}/tools`).catch(() => ({ body: [] })),
  httpRequest('GET', `${apiBase}/agents`).catch(() => ({ body: [] })),
  httpRequest('GET', `${apiBase}/config`).catch(() => ({ body: {} })),
])
const tools = Array.isArray(toolsRes.body) ? toolsRes.body : []
const agents = Array.isArray(agentsRes.body) ? agentsRes.body : []
const config = configRes.body || {}

console.log(`TUI live e2e (서버: ${BASE_URL}, 세션: ${sessionId}, 모델: ${config.llm?.model || '?'}, 인증: ${authRequired})`)

// =============================================================================
// 테스트 setup/teardown
// =============================================================================

const setup = async () => {
  // 이전 대화 초기화
  await httpRequest('POST', `${apiBase}/chat`, { input: '/clear' }).catch(() => {})
  await delay(200)

  // MirrorState 연결
  const wsHeaders = accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
  const remoteState = createMirrorState({ wsUrl: WS_URL, sessionId, headers: wsHeaders })
  await waitFor(() => remoteState.get('turnState') !== undefined, { timeout: 10000 })

  // idle 상태 안정화 대기
  await waitFor(() => remoteState.get('turnState')?.tag === 'idle', { timeout: 15000 }).catch(() => {})

  // App 렌더
  const onInput = (input) =>
    httpRequest('POST', `${apiBase}/chat`, { input }).then(res => res.body?.content ?? null)
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
// 테스트
// =============================================================================

// TL1. 초기 UI 렌더링 — idle + 모델명
{
  const { lastFrame, cleanup } = await setup()
  try {
    await waitFor(() => lastFrame().includes('idle'), { timeout: 10000 })
    const frame = lastFrame()
    assert(frame.includes('idle'), 'TL1: 초기 상태 idle')
    assert(frame.includes('>'), 'TL1: 입력 프롬프트')
    assert(frame.includes(config.llm?.model || ''), 'TL1: 모델명 표시')
  } finally { cleanup() }
}

// TL2. 실제 LLM 응답 — 인사 요청 → thinking → 응답 → idle
{
  const { lastFrame, stdin, remoteState, cleanup } = await setup()
  try {
    const turnBefore = remoteState.get('turn') ?? 0

    await typeInput(stdin, '안녕하세요. 한 문장으로만 답해주세요.')

    // turn 값 변경 대기 (/clear 후 turn이 감소할 수 있으므로 !== 비교)
    await waitFor(
      () => (remoteState.get('turn') ?? 0) !== turnBefore,
      { timeout: LLM_TIMEOUT },
    )
    await waitFor(
      () => lastFrame().includes('idle') && !lastFrame().includes('thinking'),
      { timeout: 10000 },
    )

    assert((remoteState.get('turn') ?? 0) !== turnBefore, 'TL2: turn 변경')
    assert(lastFrame().includes('idle'), 'TL2: 응답 후 idle 복귀')

    // 에이전트 응답 텍스트가 프레임에 존재하는지 확인
    const frame = lastFrame()
    const hasAgentResponse = frame.split('\n').some(line => {
      const trimmed = line.trim()
      return trimmed.length > 5 && !trimmed.startsWith('>') && !trimmed.includes('idle') && !trimmed.startsWith('─')
    })
    assert(hasAgentResponse, 'TL2: 에이전트 응답 표시')
  } finally { cleanup() }
}

// TL3. 도구 실행 — 파일 목록 요청
{
  const { lastFrame, stdin, cleanup } = await setup()
  try {
    await typeInput(stdin, '현재 디렉토리의 파일 목록을 알려줘.')

    await waitFor(
      () => lastFrame().includes('idle') && !lastFrame().includes('thinking'),
      { timeout: LLM_TIMEOUT },
    )

    const frame = lastFrame()
    const hasToolOrText = frame.includes('file_list') || frame.includes('package.json') || frame.includes('파일')
    assert(hasToolOrText, 'TL3: 파일 목록 요청 → 응답 표시')
  } finally { cleanup() }
}

// TL4. /status 슬래시 커맨드
{
  const { lastFrame, stdin, cleanup } = await setup()
  try {
    await typeInput(stdin, '/status')
    await waitFor(() => lastFrame().includes('status:'), { timeout: 5000 })
    assert(lastFrame().includes('status:'), 'TL4: /status 시스템 메시지')
  } finally { cleanup() }
}

// TL5. /tools 슬래시 커맨드
{
  const { lastFrame, stdin, cleanup } = await setup()
  try {
    await typeInput(stdin, '/tools')
    await waitFor(() => lastFrame().includes('file_'), { timeout: 5000 })
    assert(lastFrame().includes('file_'), 'TL5: /tools 도구 목록')
  } finally { cleanup() }
}

// TL6. 빈 입력 → 전송 안 됨
{
  const { remoteState, stdin, cleanup } = await setup()
  try {
    const turnBefore = remoteState.get('turn') ?? 0
    stdin.write('\r')
    await delay(500)
    assert((remoteState.get('turn') ?? 0) === turnBefore, 'TL6: 빈 입력 → turn 불변')
  } finally { cleanup() }
}

// TL7. 입력 히스토리 ↑↓
{
  const { lastFrame, stdin, cleanup } = await setup()
  try {
    // 두 메시지 전송
    await typeInput(stdin, 'ALPHA')
    await waitFor(() => lastFrame().includes('idle') && !lastFrame().includes('thinking'), { timeout: LLM_TIMEOUT })

    await typeInput(stdin, 'BRAVO')
    await waitFor(() => lastFrame().includes('idle') && !lastFrame().includes('thinking'), { timeout: LLM_TIMEOUT })
    await delay(300)

    // ↑ → BRAVO
    stdin.write('\x1B[A')
    await waitFor(() => lastFrame().includes('BRAVO'), { timeout: 3000 })
    assert(lastFrame().includes('BRAVO'), 'TL7: ↑ 마지막 입력 복원')

    // ↑↑ → ALPHA
    stdin.write('\x1B[A')
    await waitFor(() => lastFrame().includes('ALPHA'), { timeout: 3000 })
    assert(lastFrame().includes('ALPHA'), 'TL7: ↑↑ 이전 입력 복원')

    // ↓ → BRAVO
    stdin.write('\x1B[B')
    await waitFor(() => lastFrame().includes('BRAVO'), { timeout: 3000 })
    assert(lastFrame().includes('BRAVO'), 'TL7: ↓ 복원')
  } finally { cleanup() }
}

// TL8. 세션 목록 — /sessions (메인 세션 목록 반환)
{
  const { lastFrame, stdin, cleanup } = await setup()
  try {
    await typeInput(stdin, '/sessions')
    // /api/sessions는 메인 UserContext 세션을 반환. user-default가 항상 존재.
    await waitFor(() => lastFrame().includes('user-default'), { timeout: 5000 })
    assert(lastFrame().includes('user-default'), 'TL8: /sessions에 세션 목록 표시')
  } finally { cleanup() }
}

// TL9. 세션 생성 (TUI 슬래시 커맨드 + REST 검증)
{
  const testSessionId = `live-test-${Date.now()}`
  const { lastFrame, stdin, cleanup } = await setup()
  try {
    await typeInput(stdin, `/sessions new ${testSessionId}`)
    await waitFor(
      () => lastFrame().includes('생성됨') || lastFrame().includes(testSessionId),
      { timeout: 5000 },
    )
    const listRes = await httpRequest('GET', '/api/sessions')
    const sessions = Array.isArray(listRes.body) ? listRes.body : []
    assert(sessions.some(entry => entry.id === testSessionId), 'TL9: 세션 생성 확인 (REST)')
  } finally { cleanup() }
}

summary()
