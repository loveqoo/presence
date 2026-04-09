/**
 * Live e2e 테스트 공용 인프라.
 * 서버 접속, 인증, MirrorState 연결, App 렌더링을 캡슐화.
 */

import React from 'react'
import { render } from 'ink-testing-library'
import http from 'node:http'
import { createMirrorState } from '@presence/infra/infra/states/mirror-state.js'
import { App } from '@presence/tui/ui/App.js'
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

const BASE_URL = cliArg('url', 'http://127.0.0.1:3000')
const WS_URL = BASE_URL.replace(/^http/, 'ws')
const USERNAME = cliArg('username', 'anthony')
const PASSWORD = cliArg('password', 'testpass123')
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

const connect = async () => {
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

  const apiBase = `/api/sessions/${sessionId}`
  const [toolsRes, agentsRes, configRes] = await Promise.all([
    httpRequest('GET', `${apiBase}/tools`).catch(() => ({ body: [] })),
    httpRequest('GET', `${apiBase}/agents`).catch(() => ({ body: [] })),
    httpRequest('GET', `${apiBase}/config`).catch(() => ({ body: {} })),
  ])

  return {
    sessionId, authRequired,
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

export {
  connect, setup, delay, waitFor, waitIdle, waitTurnComplete,
  typeInput, sendAndWait, httpRequest, LLM_TIMEOUT,
}
