import React from 'react'
import { render } from 'ink-testing-library'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { initI18n } from '@presence/infra/i18n'
import { App } from '@presence/tui/ui/App.js'
import { TurnState } from '@presence/core/core/policies.js'
import { t } from '@presence/infra/i18n'

const h = React.createElement

const SETTLE_MS = 50

const defaultInitialState = () => ({
  turnState: TurnState.idle(),
  lastTurn: null,
  turn: 0,
  context: { memories: [], conversationHistory: [] },
  todos: [],
  events: { queue: [], deadLetter: [] },
  delegates: { pending: [] },
  _toolResults: [],
})

class FakeRemoteSession {
  constructor({ initialSessionId = 'testuser-default', sessions = [] } = {}) {
    this.sessions = new Map()
    for (const entry of sessions) {
      const id = typeof entry === 'string' ? entry : entry.id
      const name = typeof entry === 'string' ? entry : (entry.name ?? entry.id)
      this.sessions.set(id, { id, name, type: 'user' })
    }
    if (!this.sessions.has(initialSessionId)) {
      this.sessions.set(initialSessionId, { id: initialSessionId, name: initialSessionId, type: 'user' })
    }
    this.currentSessionId = initialSessionId
    this.events = []
  }

  listSessions = async () => {
    this.events.push({ type: 'list' })
    return Array.from(this.sessions.values())
  }

  createSession = async (id) => {
    this.events.push({ type: 'create', id })
    const session = { id, name: id, type: 'user' }
    this.sessions.set(id, session)
    return session
  }

  deleteSession = async (id) => {
    this.events.push({ type: 'delete', id })
    this.sessions.delete(id)
    return { ok: true }
  }

  switchSession = async (id) => {
    this.events.push({ type: 'switch', id })
    if (!this.sessions.has(id)) throw new Error(`unknown session: ${id}`)
    this.currentSessionId = id
    return { ok: true }
  }
}

const buildAppElement = ({ state, fakeSession, appProps, initialMessages }) =>
  h(App, {
    key: fakeSession.currentSessionId,
    state,
    agentName: appProps.agentName ?? 'TestAgent',
    tools: appProps.tools ?? [],
    agents: appProps.agents ?? [],
    initialMessages: initialMessages ?? appProps.initialMessages ?? [],
    cwd: appProps.cwd ?? '/tmp/presence-scenario',
    gitBranch: appProps.gitBranch ?? 'main',
    model: appProps.model ?? 'test-model',
    config: appProps.config ?? {
      persona: { name: appProps.agentName ?? 'TestAgent' },
      llm: { model: appProps.model ?? 'test-model' },
    },
    sessionId: fakeSession.currentSessionId,
    onListSessions: fakeSession.listSessions,
    onCreateSession: fakeSession.createSession,
    onDeleteSession: fakeSession.deleteSession,
    onSwitchSession: fakeSession.switchSession,
    onInput: appProps.onInput ?? (async (input) => `echo: ${input}`),
    onApprove: appProps.onApprove ?? (() => {}),
    onCancel: appProps.onCancel ?? (() => {}),
  })

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const createHarness = async (options = {}) => {
  await initI18n('ko')

  const state = createOriginState(options.initialState ?? defaultInitialState())
  const fakeSession = new FakeRemoteSession(options.session ?? {})
  const appProps = options.app ?? {}

  let rendered = null

  const requireMounted = () => {
    if (!rendered) throw new Error('harness not mounted — call mount() first')
    return rendered
  }

  // 실제 앱(remote.js)에서는 switchSession 성공 시 App을 새 sessionId로 remount 하고
  // `sessions_cmd.switched` 시스템 메시지를 새 mount 의 initialMessages 로 한 번 주입한다.
  // 테스트 환경에서도 같은 동작을 흉내내기 위해 원본 switchSession을 감싸 rerender + 메시지 주입.
  const originalSwitch = fakeSession.switchSession
  fakeSession.switchSession = async (id) => {
    const result = await originalSwitch(id)
    if (rendered) {
      const pending = [{ role: 'system', content: t('sessions_cmd.switched', { id }) }]
      rendered.rerender(buildAppElement({ state, fakeSession, appProps, initialMessages: pending }))
    }
    return result
  }

  const api = {
    state,
    fakeSession,

    async mount() {
      if (rendered) throw new Error('harness already mounted')
      rendered = render(buildAppElement({ state, fakeSession, appProps }))
      await wait(SETTLE_MS)
    },

    unmount() {
      if (rendered) {
        rendered.unmount()
        rendered = null
      }
    },

    async type(text) {
      requireMounted().stdin.write(text)
      await wait(SETTLE_MS)
    },

    async press(key) {
      const sequences = {
        enter: '\r',
        escape: '\x1b',
        up: '\x1b[A',
        down: '\x1b[B',
        left: '\x1b[D',
        right: '\x1b[C',
        'ctrl-t': '\x14',
        'ctrl-o': '\x0f',
      }
      const seq = sequences[key]
      if (seq == null) throw new Error(`unknown key: ${key}`)
      requireMounted().stdin.write(seq)
      await wait(SETTLE_MS)
    },

    async setState(path, value) {
      state.set(path, value)
      await wait(SETTLE_MS)
    },

    async wait(ms) {
      await wait(ms)
    },

    frame() {
      return rendered?.lastFrame() ?? ''
    },
  }

  return api
}

export { createHarness, FakeRemoteSession, defaultInitialState }
