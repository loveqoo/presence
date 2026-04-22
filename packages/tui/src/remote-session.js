import React from 'react'
import { render } from 'ink'
import { REST_ERROR } from '@presence/core/core/policies.js'
import { defaultSessionId } from '@presence/infra/infra/constants.js'
import { createMirrorState } from '@presence/infra/infra/states/mirror-state.js'
import { t } from '@presence/infra/i18n'
import { App } from './ui/App.js'
import { instrumentMirror } from '../diag/instrument-mirror.js'

const h = React.createElement
const noop = Function.prototype

// =============================================================================
// RemoteSession: 세션 상태 + 전환 + App props 조립을 응집.
// =============================================================================

class RemoteSession {
  #wsUrl
  #authState
  #client
  #config
  #agents
  #gitBranch
  #currentSessionId
  #remoteState
  #currentTools
  #rerender
  #tryRefresh
  #username
  #disconnected
  #pendingInitialMessages

  constructor(opts) {
    this.#wsUrl = opts.wsUrl
    this.#authState = opts.authState
    this.#client = opts.client
    this.#config = opts.config
    this.#agents = opts.agents
    this.#gitBranch = opts.gitBranch
    this.#currentTools = opts.initialTools
    this.#tryRefresh = opts.tryRefresh
    this.#username = opts.username
    this.#currentSessionId = defaultSessionId(opts.username)
    this.#disconnected = null
    this.#pendingInitialMessages = []
    this.#remoteState = this.#createMirrorState(this.#currentSessionId)
    this.#rerender = null
  }


  async switchSession(newId) {
    this.#remoteState.disconnect()
    this.#currentSessionId = newId
    this.#remoteState = this.#createMirrorState(newId)
    this.#currentTools = await this.#client.getJson(`/api/sessions/${newId}/tools`).catch(() => this.#currentTools)
    // transient 로 1회 표시. 다음 ESC 또는 턴 시작 시 clearTransient 로 자연 소멸.
    this.#pendingInitialMessages = [{ role: 'system', content: t('sessions_cmd.switched', { id: newId }), transient: true }]
    if (this.#rerender) this.#rerender(h(App, this.#buildAppProps()))
  }

  disconnect() { this.#remoteState.disconnect() }

  markDisconnected(code) {
    this.#disconnected = { code, at: Date.now() }
    if (this.#rerender) this.#rerender(h(App, this.#buildAppProps()))
  }

  render() {
    const rendered = render(h(App, this.#buildAppProps()))
    this.#rerender = rendered.rerender
    return rendered.waitUntilExit
  }

  #createMirrorState(sessionId) {
    const mirror = createMirrorState({
      wsUrl: this.#wsUrl,
      sessionId,
      // cwd 전송은 제거됨 — workingDir 은 서버가 userId 에서 자동 결정 (agent-identity.md I-WD).
      getHeaders: () => this.#authState?.accessToken
        ? { 'Authorization': `Bearer ${this.#authState.accessToken}` }
        : undefined,
      onAuthFailed: this.#tryRefresh,
      onUnrecoverable: (code) => {
        this.#disconnected = { code, at: Date.now() }
        if (this.#rerender) this.#rerender(h(App, this.#buildAppProps()))
      },
    })
    // FP-58 진단: PRESENCE_TRACE_PATCHES=1 로 실행하면 모든 수신 patch 를
    // /tmp/presence-patches.log 에 기록한다. 실환경 깜빡임 원인을 찾기 위함.
    if (process.env.PRESENCE_TRACE_PATCHES === '1') instrumentMirror(mirror)
    return mirror
  }


  // Phase 5-9: HTTP 응답의 stateVersion 이 MirrorState.lastStateVersion 과 다르면
  // 클라이언트 데이터가 뒤처진 것 → 최신화.
  //   - Phase 9: 응답에 snapshot 이 동봉되어 있으면 mirror 가 즉시 applySnapshot
  //     (WS 왕복 없이 reconcile). 에러/reject 응답에서 활용.
  //   - 없으면 fallback: requestRefresh() 로 서버 init snapshot 재수신.
  #reconcileIfStale(res) {
    if (!res || !res.stateVersion) return
    const mirror = this.#remoteState
    if (!mirror || !mirror.lastStateVersion) return
    if (res.stateVersion === mirror.lastStateVersion) return
    if (res.snapshot) {
      mirror.applySnapshot(res.snapshot)
      mirror.lastStateVersion = res.stateVersion
      return
    }
    mirror.requestRefresh?.()
  }

  #buildHandlers() {
    const apiBase = `/api/sessions/${this.#currentSessionId}`
    return {
      handleInput: async (input) => {
        try {
          const res = await this.#client.post(`${apiBase}/chat`, { input })
          this.#reconcileIfStale(res)
          if (res.type === 'error') throw new Error(res.content)
          return res.content
        } catch (err) {
          if (err?.kind === REST_ERROR.AUTH_FAILED) return ''
          throw err
        }
      },
      handleApproveResponse: (approved) => {
        this.#client.post(`${apiBase}/approve`, { approved })
          .then((res) => this.#reconcileIfStale(res))
          .catch(noop)
      },
      handleCancel: () => {
        this.#client.post(`${apiBase}/cancel`)
          .then((res) => this.#reconcileIfStale(res))
          .catch(noop)
      },
    }
  }

  #buildAppProps() {
    const handlers = this.#buildHandlers()
    const msgs = this.#pendingInitialMessages
    this.#pendingInitialMessages = []
    return {
      key: this.#currentSessionId,
      state: this.#remoteState,
      onInput: handlers.handleInput,
      onApprove: handlers.handleApproveResponse,
      onCancel: handlers.handleCancel,
      agentName: this.#config.persona?.name || 'Presence',
      tools: this.#currentTools,
      agents: this.#agents,
      gitBranch: this.#gitBranch,
      model: this.#config.llm?.model || '',
      config: this.#config,
      memory: null,
      llm: null,
      toolRegistry: null,
      initialMessages: msgs,
      username: this.#username,
      sessionId: this.#currentSessionId,
      onListSessions: this.#client.getJson.bind(this.#client, '/api/sessions'),
      onCreateSession: (id) => this.#client.post('/api/sessions', { id, type: 'user' }),
      onDeleteSession: (id) => this.#client.del(`/api/sessions/${id}`),
      onSwitchSession: this.switchSession.bind(this),
      disconnected: this.#disconnected,
    }
  }
}

export { RemoteSession }
