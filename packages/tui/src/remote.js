import React from 'react'
import { render } from 'ink'
import { createMirrorState } from '@presence/infra/infra/states/mirror-state.js'
import { jsonRequest, refreshAccessToken } from './http.js'
import { App } from './ui/App.js'

const h = React.createElement

// =============================================================================
// Remote 모드: 서버 세션을 WS/REST로 조작.
// 401 자동 refresh, 세션 전환, App 렌더링을 담당.
// =============================================================================

// 401 시 refresh token으로 access token 갱신. refreshPromise 단일화로 동시성 제어.
const createTokenRefresher = (baseUrl, authState) => {
  let refreshPromise = null
  return async () => {
    if (!authState) return false
    if (refreshPromise) return refreshPromise
    refreshPromise = (async () => {
      try {
        const res = await refreshAccessToken(baseUrl, authState.refreshToken)
        if (res.status === 200) {
          authState.accessToken = res.body.accessToken
          if (res.body.refreshToken) authState.refreshToken = res.body.refreshToken
          return true
        }
      } catch {}
      return false
    })()
    const result = await refreshPromise
    refreshPromise = null
    return result
  }
}

// 401 자동 재시도를 포함한 HTTP 클라이언트. body만 반환 (status 숨김).
const createAuthClient = (baseUrl, authState, tryRefresh) => {
  const request = async (method, path, body) => {
    const res = await jsonRequest(baseUrl, { method, path, body, token: authState?.accessToken })
    if (res.status === 401 && authState) {
      const refreshed = await tryRefresh()
      if (refreshed) {
        const retry = await jsonRequest(baseUrl, { method, path, body, token: authState?.accessToken })
        return retry.body
      }
    }
    return res.body
  }
  return {
    post: (path, body) => request('POST', path, body),
    del: (path) => request('DELETE', path),
    getJson: async (path) => (await request('GET', path)) ?? [],
  }
}

// git branch 조회 (실패하면 빈 문자열)
const detectGitBranch = async (cwd) => {
  try {
    const { execSync } = await import('child_process')
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
  } catch (_) {
    return ''
  }
}

const runRemote = async (baseUrl, opts = {}) => {
  const { authState, username } = opts
  const wsUrl = baseUrl.replace(/^http/, 'ws')

  const tryRefresh = createTokenRefresher(baseUrl, authState)
  const { post, del, getJson } = createAuthClient(baseUrl, authState, tryRefresh)

  // --- 세션 관리 API ---
  const onListSessions = () => getJson('/api/sessions')
  const onCreateSession = (id) => post('/api/sessions', { id, type: 'user' })
  const onDeleteSession = (id) => del(`/api/sessions/${id}`)

  // --- 세션 상태 (mutable) ---
  let currentSessionId = username ? `${username}-default` : 'user-default'
  const wsHeaders = authState?.accessToken ? { 'Authorization': `Bearer ${authState.accessToken}` } : undefined
  let remoteState = createMirrorState({ wsUrl, sessionId: currentSessionId, headers: wsHeaders })
  let currentTools = []
  let rerender = null

  const [initialTools, agents, config] = await Promise.all([
    getJson('/api/tools').catch(() => []),
    getJson('/api/agents').catch(() => []),
    getJson('/api/config').catch(() => ({})),
  ])
  currentTools = initialTools

  const cwd = process.cwd()
  const gitBranch = await detectGitBranch(cwd)

  // --- 세션별 핸들러 빌더 ---
  const buildHandlers = (sessionId) => {
    const apiBase = `/api/sessions/${sessionId}`
    return {
      handleInput: async (input) => {
        const res = await post(`${apiBase}/chat`, { input })
        if (res.type === 'error') throw new Error(res.content)
        return res.content
      },
      handleApproveResponse: (approved) => { post(`${apiBase}/approve`, { approved }).catch(() => {}) },
      handleCancel: () => { post(`${apiBase}/cancel`).catch(() => {}) },
    }
  }

  // --- App props 빌더 ---
  const buildAppProps = () => {
    const { handleInput, handleApproveResponse, handleCancel } = buildHandlers(currentSessionId)
    return {
      key: currentSessionId,   // 세션 전환 시 App 완전 재마운트 → 메시지 초기화
      state: remoteState,
      onInput: handleInput,
      onApprove: handleApproveResponse,
      onCancel: handleCancel,
      agentName: config.persona?.name || 'Presence',
      tools: currentTools,
      agents,
      cwd,
      gitBranch,
      model: config.llm?.model || '',
      config,
      memory: null,
      llm: null,
      mcpControl: null,
      initialMessages: [],
      sessionId: currentSessionId,
      onListSessions,
      onCreateSession,
      onDeleteSession,
      onSwitchSession,
    }
  }

  // --- 세션 전환 ---
  const onSwitchSession = async (newId) => {
    remoteState.disconnect()
    currentSessionId = newId
    const newWsHeaders = authState?.accessToken ? { 'Authorization': `Bearer ${authState.accessToken}` } : undefined
    remoteState = createMirrorState({ wsUrl, sessionId: newId, headers: newWsHeaders })
    const defaultSessionId = username ? `${username}-default` : 'user-default'
    const toolsPath = newId === defaultSessionId ? '/api/tools' : `/api/sessions/${newId}/tools`
    currentTools = await getJson(toolsPath).catch(() => currentTools)
    if (rerender) rerender(h(App, buildAppProps()))
  }

  const onSignal = () => { remoteState.disconnect(); process.exit(0) }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  const rendered = render(h(App, buildAppProps()))
  rerender = rendered.rerender
  const { waitUntilExit } = rendered

  await waitUntilExit()
  process.off('SIGTERM', onSignal)
  process.off('SIGINT', onSignal)
  remoteState.disconnect()
}

export { runRemote }
