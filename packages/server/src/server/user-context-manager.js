import { UserContext } from '@presence/infra/infra/user-context.js'
import { mergeUserOver } from '@presence/infra/infra/config-loader.js'
import { SESSION_TYPE } from '@presence/infra/infra/constants.js'
import { rebootCedarSubsystem } from '@presence/infra/infra/authz/cedar/index.js'
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
  #reloadPending = null // null | Promise<reloadResult> — Cedar policy reload single-flight (KG-28 P5)
  #bridge
  #serverConfig
  #memory
  #evaluator         // KG-28 P5: callable wrapper (snapshot / replace 메서드 보유)
  #auditWriter       // KG-28 P5: rebootCedarSubsystem 에 재사용 — 단일 진실 소스 유지
  #tokenService

  constructor({ bridge, serverConfig, memory, evaluator, auditWriter, tokenService }) {
    if (typeof evaluator !== 'function') {
      throw new Error('UserContextManager: evaluator (function) 필수 — Cedar 인프라가 부팅된 상태가 invariant')
    }
    if (typeof evaluator.replace !== 'function' || typeof evaluator.snapshot !== 'function') {
      throw new Error('UserContextManager: evaluator 가 createEvaluatorRef wrapper 가 아님 — KG-28 P5 invariant')
    }
    if (!auditWriter || typeof auditWriter.append !== 'function') {
      throw new Error('UserContextManager: auditWriter (with append) 필수 — KG-28 P5 invariant (reload 시 재사용)')
    }
    this.#bridge = bridge
    this.#serverConfig = serverConfig
    this.#memory = memory
    this.#evaluator = evaluator
    this.#auditWriter = auditWriter
    this.#tokenService = tokenService ?? null
  }

  // KG-28 P5 — Cedar policy hot reload. 단순 single-flight: 진행 중 reload 가 있으면 같은 promise 공유.
  // edge-trigger 의미론 — 진행 중 reload 의 follower 는 같은 reloadStartedAt + 결과 받음.
  // 호출자가 자기 호출 후 변경 반영 필요하면 명시적 두 번째 호출.
  async reloadEvaluator({ presenceDir, logger }) {
    if (this.#reloadPending) return this.#reloadPending
    const reloadStartedAt = new Date().toISOString()
    this.#reloadPending = this.#doReload({ presenceDir, logger, reloadStartedAt })
    try { return await this.#reloadPending }
    finally { this.#reloadPending = null }
  }

  async #doReload({ presenceDir, logger, reloadStartedAt }) {
    const snapshot = this.#evaluator.snapshot()
    // rebootCedarSubsystem 단일 함수 (newEvaluator) 만 반환. 부팅 실패 시 throw → wrapper.replace 미호출 = fail-safe.
    const newEvaluator = await rebootCedarSubsystem({
      presenceDir, logger, auditWriter: this.#auditWriter,
    })
    const newVersion = snapshot.version + 1
    // wrapper 의 state 갱신 — 모든 호출자 (살아있는 세션 / 캐시된 UC) 자동 propagate
    this.#evaluator.replace(newEvaluator, newVersion)
    return {
      version: newVersion,
      reloadedAt: this.#evaluator.snapshot().reloadedAt,
      reloadStartedAt,
    }
  }

  // KG-28 P5 — admin REST GET /api/admin/policy/version + reload 실패 시 활성 정보 응답에 사용.
  getEvaluatorSnapshot() {
    return this.#evaluator.snapshot()
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
      evaluator: this.#evaluator,
      // KG-17 — Op.Delegate remote 경로가 caller token 첨부 시 사용.
      a2aSigner: this.#tokenService ? (sub) => this.#tokenService.signA2aToken(sub) : null,
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
