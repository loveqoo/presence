import { UserContext } from '@presence/infra/infra/user-context.js'
import { SESSION_TYPE } from '@presence/infra/infra/constants.js'
import { DelegationMode } from '@presence/infra/infra/agents/delegation.js'
import { INACTIVITY_TIMEOUT_MS } from './constants.js'

// =============================================================================
// UserContextManager: 유저별 UserContext 생명주기 관리.
// - 인증된 첫 요청/WS 시 해당 유저의 UserContext 생성
// - 모든 WS 연결이 끊기면 INACTIVITY_TIMEOUT_MS 후 자동 shutdown
// (인증 활성화 시에만 사용)
// =============================================================================

class UserContextManager {
  #contexts = new Map() // username → { userContext, wsConnections, lastActivity, shutdownTimer }
  #bridge
  #configOverride

  constructor({ bridge, configOverride }) {
    this.#bridge = bridge
    this.#configOverride = configOverride
  }

  async getOrCreate(username) {
    if (this.#contexts.has(username)) return this.#contexts.get(username)
    // 유저별 config를 로드 (서버 전역 config가 아닌, 유저 인스턴스 config merge)
    const { Config } = await import('@presence/infra/infra/config.js')
    const userConfig = Config.loadUserMerged(username)
    const userContext = await UserContext.create(userConfig, {
      username,
      onSessionCreated: ({ id, type, session }) => {
        if (type !== SESSION_TYPE.SCHEDULED) this.#bridge.watchSession(id, session.state)
      },
    })
    // config.agents 기반 에이전트 세션 등록 (글로벌 PresenceServer와 동일)
    for (const agentDef of (userContext.config.agents || [])) {
      const agentEntry = userContext.sessions.create({
        id: `agent-${agentDef.name}`, type: SESSION_TYPE.AGENT,
      })
      userContext.agentRegistry.register({
        name: agentDef.name,
        description: agentDef.description,
        capabilities: agentDef.capabilities || [],
        type: DelegationMode.LOCAL,
        run: (task) => agentEntry.session.handleInput(task),
      })
      agentEntry.session.delegateActor.start().fork(() => {}, () => {})
    }

    const entry = { userContext, wsConnections: new Set(), lastActivity: Date.now(), shutdownTimer: null }
    this.#contexts.set(username, entry)
    return entry
  }

  touch(username) {
    const entry = this.#contexts.get(username)
    if (!entry) return
    entry.lastActivity = Date.now()
    if (entry.shutdownTimer) {
      clearTimeout(entry.shutdownTimer)
      entry.shutdownTimer = null
    }
  }

  addWs(username, ws) {
    const entry = this.#contexts.get(username)
    if (!entry) return
    entry.wsConnections.add(ws)
    if (entry.shutdownTimer) {
      clearTimeout(entry.shutdownTimer)
      entry.shutdownTimer = null
    }
  }

  removeWs(username, ws) {
    const entry = this.#contexts.get(username)
    if (!entry) return
    entry.wsConnections.delete(ws)
    if (entry.wsConnections.size === 0) this.#scheduleShutdown(username)
  }

  async shutdownAll() {
    const usernames = [...this.#contexts.keys()]
    await Promise.all(usernames.map(username => this.#shutdownUser(username)))
  }

  list() {
    return [...this.#contexts.entries()].map(([username, entry]) => ({ username, entry }))
  }

  async #shutdownUser(username) {
    const entry = this.#contexts.get(username)
    if (!entry) return
    this.#contexts.delete(username)
    if (entry.shutdownTimer) clearTimeout(entry.shutdownTimer)
    await entry.userContext.shutdown().catch(() => {})
  }

  #scheduleShutdown(username) {
    const entry = this.#contexts.get(username)
    if (!entry) return
    if (entry.wsConnections.size > 0) return
    if (entry.shutdownTimer) return
    entry.shutdownTimer = setTimeout(() => this.#shutdownUser(username), INACTIVITY_TIMEOUT_MS)
  }
}

export { UserContextManager }
