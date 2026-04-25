import { UserContext } from '@presence/infra/infra/user-context.js'
import { mergeUserOver } from '@presence/infra/infra/config-loader.js'
import { SESSION_TYPE } from '@presence/infra/infra/constants.js'
import { INACTIVITY_TIMEOUT_MS } from './constants.js'
import { registerAgentSessions } from './scheduler-factory.js'

// =============================================================================
// UserContextManager: 유저별 UserContext 생명주기 관리.
// - 인증된 첫 요청/WS 시 해당 유저의 UserContext 생성
// - 모든 WS 연결이 끊기면 INACTIVITY_TIMEOUT_MS 후 자동 shutdown
// (인증 활성화 시에만 사용)
// =============================================================================

class UserContextManager {
  #contexts = new Map() // username → { userContext, wsConnections, lastActivity, shutdownTimer }
  #pending = new Map()  // username → Promise<entry> — single-flight 보호 (S4)
  #bridge
  #serverConfig
  #memory

  constructor({ bridge, serverConfig, memory }) {
    this.#bridge = bridge
    this.#serverConfig = serverConfig
    this.#memory = memory
  }

  // S4: single-flight — 동시 첫 접근 (REST + WS) 시 UserContext.create 가 두 번 실행되어
  //   DB 핸들 중복 open + recovery 가 두 번 도는 race window 차단.
  async getOrCreate(username) {
    if (this.#contexts.has(username)) return this.#contexts.get(username)
    if (this.#pending.has(username)) return this.#pending.get(username)
    const promise = this.#createInternal(username)
    this.#pending.set(username, promise)
    try { return await promise } finally { this.#pending.delete(username) }
  }

  async #createInternal(username) {
    // 런타임 서버 config를 base로 유저 config merge (disk server.json 재독 없음)
    const userConfig = mergeUserOver(this.#serverConfig, username)
    const userContext = await UserContext.create(userConfig, {
      username,
      memory: this.#memory,
      onSessionCreated: ({ id, type, session }) => {
        if (type !== SESSION_TYPE.SCHEDULED) this.#bridge.watchSession(id, session)
      },
    })
    // config.agents 기반 에이전트 세션 등록
    registerAgentSessions(userContext, username)
    // S4: A2A 큐 재시작 회복 (sessions 등록 후, 첫 요청 처리 전)
    await userContext.recoverA2aQueue({
      sessionManager: userContext.sessions,
      recoverOnStart: userContext.config?.a2a?.recoverOnStart !== false,
    })

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
