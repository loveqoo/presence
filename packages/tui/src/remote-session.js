import React from 'react'
import { render } from 'ink'
import { createMirrorState } from '@presence/infra/infra/states/mirror-state.js'
import { t } from '@presence/infra/i18n'
import { App } from './ui/App.js'

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
  #cwd
  #gitBranch
  #currentSessionId
  #remoteState
  #currentTools
  #rerender
  #tryRefresh
  #disconnected
  #pendingInitialMessages

  constructor(opts) {
    this.#wsUrl = opts.wsUrl
    this.#authState = opts.authState
    this.#client = opts.client
    this.#config = opts.config
    this.#agents = opts.agents
    this.#cwd = opts.cwd
    this.#gitBranch = opts.gitBranch
    this.#currentTools = opts.initialTools
    this.#tryRefresh = opts.tryRefresh
    this.#currentSessionId = opts.username ? `${opts.username}-default` : 'user-default'
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
    this.#pendingInitialMessages = [{ role: 'system', content: t('sessions_cmd.switched', { id: newId }) }]
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
    return createMirrorState({
      wsUrl: this.#wsUrl,
      sessionId,
      getHeaders: () => this.#authState?.accessToken
        ? { 'Authorization': `Bearer ${this.#authState.accessToken}` }
        : undefined,
      onAuthFailed: this.#tryRefresh,
      onUnrecoverable: (code) => {
        this.#disconnected = { code, at: Date.now() }
        if (this.#rerender) this.#rerender(h(App, this.#buildAppProps()))
      },
    })
  }


  #buildHandlers() {
    const apiBase = `/api/sessions/${this.#currentSessionId}`
    return {
      handleInput: async (input) => {
        try {
          const res = await this.#client.post(`${apiBase}/chat`, { input })
          if (res.type === 'error') throw new Error(res.content)
          return res.content
        } catch (err) {
          if (err?.kind === 'AUTH_FAILED') return ''
          throw err
        }
      },
      handleApproveResponse: (approved) => {
        this.#client.post(`${apiBase}/approve`, { approved }).catch(noop)
      },
      handleCancel: () => {
        this.#client.post(`${apiBase}/cancel`).catch(noop)
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
      cwd: this.#cwd,
      gitBranch: this.#gitBranch,
      model: this.#config.llm?.model || '',
      config: this.#config,
      memory: null,
      llm: null,
      toolRegistry: null,
      initialMessages: msgs,
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
