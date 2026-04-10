import React from 'react'
import { render } from 'ink'
import { createMirrorState } from '@presence/infra/infra/states/mirror-state.js'
import { initI18n } from '@presence/infra/i18n'
import { jsonRequest, refreshAccessToken } from './http.js'
import { App } from './ui/App.js'

const h = React.createElement

// =============================================================================
// Remote 모드: 서버 세션을 WS/REST로 조작.
// =============================================================================

// 401 시 refresh token으로 access token 갱신. refreshPromise 단일화로 동시성 제어.
function createTokenRefresher(baseUrl, authState) {
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

// 401 자동 재시도를 포함한 HTTP 클라이언트.
function createAuthClient(baseUrl, authState, tryRefresh) {
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
async function detectGitBranch(cwd) {
  try {
    const { execSync } = await import('child_process')
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
  } catch (_) {
    return ''
  }
}

// =============================================================================
// RemoteSession: 세션 상태 + 전환 + App props 조립을 응집.
// =============================================================================

class RemoteSession {
  #wsUrl
  #authState
  #username
  #client
  #config
  #agents
  #cwd
  #gitBranch
  #currentSessionId
  #remoteState
  #currentTools
  #rerender
  #tryRefresh

  constructor({ wsUrl, authState, username, client, config, agents, cwd, gitBranch, initialTools, tryRefresh }) {
    this.#wsUrl = wsUrl
    this.#authState = authState
    this.#username = username
    this.#client = client
    this.#config = config
    this.#agents = agents
    this.#cwd = cwd
    this.#gitBranch = gitBranch
    this.#currentTools = initialTools
    this.#tryRefresh = tryRefresh
    this.#currentSessionId = username ? `${username}-default` : 'user-default'
    this.#remoteState = this.#createMirrorState(this.#currentSessionId)
    this.#rerender = null
  }

  // --- 세션 관리 API ---

  listSessions() { return this.#client.getJson('/api/sessions') }
  createSession(id) { return this.#client.post('/api/sessions', { id, type: 'user' }) }
  deleteSession(id) { return this.#client.del(`/api/sessions/${id}`) }

  async switchSession(newId) {
    this.#remoteState.disconnect()
    this.#currentSessionId = newId
    this.#remoteState = this.#createMirrorState(newId)
    this.#currentTools = await this.#client.getJson(`/api/sessions/${newId}/tools`).catch(() => this.#currentTools)
    if (this.#rerender) this.#rerender(h(App, this.#buildAppProps()))
  }

  disconnect() { this.#remoteState.disconnect() }

  // --- 렌더링 ---

  render() {
    const rendered = render(h(App, this.#buildAppProps()))
    this.#rerender = rendered.rerender
    return rendered.waitUntilExit
  }

  // --- private ---

  #createMirrorState(sessionId) {
    return createMirrorState({
      wsUrl: this.#wsUrl,
      sessionId,
      getHeaders: () => this.#authState?.accessToken
        ? { 'Authorization': `Bearer ${this.#authState.accessToken}` }
        : undefined,
      onAuthFailed: this.#tryRefresh,
      onUnrecoverable: (code) => {
        console.error(`WS connection unrecoverable (close code ${code}). Re-login required.`)
      },
    })
  }

  #buildHandlers() {
    const apiBase = `/api/sessions/${this.#currentSessionId}`
    return {
      handleInput: async (input) => {
        const res = await this.#client.post(`${apiBase}/chat`, { input })
        if (res.type === 'error') throw new Error(res.content)
        return res.content
      },
      handleApproveResponse: (approved) => { this.#client.post(`${apiBase}/approve`, { approved }).catch(() => {}) },
      handleCancel: () => { this.#client.post(`${apiBase}/cancel`).catch(() => {}) },
    }
  }

  #buildAppProps() {
    const { handleInput, handleApproveResponse, handleCancel } = this.#buildHandlers()
    return {
      key: this.#currentSessionId,
      state: this.#remoteState,
      onInput: handleInput,
      onApprove: handleApproveResponse,
      onCancel: handleCancel,
      agentName: this.#config.persona?.name || 'Presence',
      tools: this.#currentTools,
      agents: this.#agents,
      cwd: this.#cwd,
      gitBranch: this.#gitBranch,
      model: this.#config.llm?.model || '',
      config: this.#config,
      memory: null,
      llm: null,
      toolRegistry: null,
      initialMessages: [],
      sessionId: this.#currentSessionId,
      onListSessions: () => this.listSessions(),
      onCreateSession: (id) => this.createSession(id),
      onDeleteSession: (id) => this.deleteSession(id),
      onSwitchSession: (id) => this.switchSession(id),
    }
  }
}

// =============================================================================
// runRemote: 진입점. 인프라 생성 → RemoteSession → App 렌더.
// =============================================================================

async function runRemote(baseUrl, opts = {}) {
  const { authState, username } = opts
  const wsUrl = baseUrl.replace(/^http/, 'ws')

  const tryRefresh = createTokenRefresher(baseUrl, authState)
  const client = createAuthClient(baseUrl, authState, tryRefresh)

  const sessionId = username ? `${username}-default` : 'user-default'
  const sessionBase = `/api/sessions/${sessionId}`
  const [initialTools, agents, config] = await Promise.all([
    client.getJson(`${sessionBase}/tools`).catch(() => []),
    client.getJson(`${sessionBase}/agents`).catch(() => []),
    client.getJson(`${sessionBase}/config`).catch(() => ({})),
  ])

  initI18n(config.locale || 'ko')

  const cwd = process.cwd()
  const gitBranch = await detectGitBranch(cwd)

  const session = new RemoteSession({
    wsUrl, authState, username, client,
    config, agents, cwd, gitBranch, initialTools, tryRefresh,
  })

  const onSignal = () => { session.disconnect(); process.exit(0) }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  const waitUntilExit = session.render()
  await waitUntilExit()

  process.off('SIGTERM', onSignal)
  process.off('SIGINT', onSignal)
  session.disconnect()
}

export { runRemote }
