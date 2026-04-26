import { createToolRegistry } from './tools/tool-registry.js'
import { createLocalTools } from './tools/local-tools.js'
import { initMcpIntegration } from './tools/mcp-tools.js'
import { createPersona, DEFAULT_PERSONA } from './persona.js'
import { createLogger } from './logger.js'
import { LLMClient } from './llm/llm-client.js'
import { createAgentRegistry, registerSummarizer } from './agents/agent-registry.js'
import { createListAgentsTool } from './agents/agent-tools.js'
import { createEmbedder } from './embedding/embedder.js'
import { createJobStore, defaultJobDbPath } from './jobs/job-store.js'
import { createA2aQueueStore, defaultA2aQueueDbPath } from './a2a/a2a-queue-store.js'
import { dispatchResponse } from './a2a/a2a-response-dispatcher.js'
import { A2A, EVENT_TYPE } from '@presence/core/core/policies.js'
import { UserDataStore, defaultUserDataDbPath } from './user-data-store.js'
import { Config } from './config.js'
import { loadUserMerged } from './config-loader.js'
import { ensureUserDefaultAgent } from './user-migration.js'
import { initI18n, t } from '../i18n/index.js'
import { createSessionManager } from './sessions/session-manager.js'

// =============================================================================
// UserContext: 유저 1명의 인프라 스택 + 세션 관리.
// 수명: 서버가 이 유저를 제공하는 동안 1개.
// 포함: 유저 공용 인프라(llm, memory, mcp, tools, jobStore 등) + sessions(SessionManager).
// =============================================================================

const buildEmbedder = (config) => {
  const embedApiKey = config.embed.apiKey
    || (config.embed.provider === 'openai' ? config.llm.apiKey : null)
  if (!embedApiKey && !config.embed.baseUrl) return null
  return createEmbedder({
    provider: config.embed.provider,
    baseUrl: config.embed.baseUrl,
    apiKey: embedApiKey,
    model: config.embed.model,
    dimensions: config.embed.dimensions,
  })
}

class UserContext {
  /**
   * Builds a UserContext for a single user: bootstraps all infrastructure and creates a SessionManager.
   * @param {object|null} configOverride
   * @param {{ username?: string, onSessionCreated?: Function, evaluator: Function }} opts
   * @returns {Promise<UserContext>}
   *
   * `opts.evaluator` 는 필수: Cedar 인프라가 부팅된 상태가 invariant.
   * 부재 또는 falsy 시 throw — server boot 가 bootCedarSubsystem 결과를 그대로 전달하는 게 정상 경로.
   * (cedar-infra-y-prime plan v1.3 §4b)
   */
  static async create(configOverride, opts = {}) {
    const { username, onSessionCreated, evaluator } = opts
    if (typeof evaluator !== 'function') {
      throw new Error('UserContext.create: opts.evaluator (function) 필수 — Cedar 인프라가 부팅된 상태가 invariant')
    }
    const userContext = new UserContext()
    userContext.evaluator = evaluator
    // KG-17 — Op.Delegate remote 경로가 caller token 첨부 시 사용. server 부트가
    // tokenService.signA2aToken 을 주입. 부재 시 callerToken=null (legacy / 테스트).
    userContext.a2aSigner = opts.a2aSigner ?? null

    // --- Config + logger ---
    // configOverride 는 plain object 가능 → Config 인스턴스 보장
    userContext.config = configOverride
      ? (configOverride instanceof Config ? configOverride : new Config(configOverride))
      : loadUserMerged(username)
    initI18n(userContext.config.locale)
    userContext.logger = createLogger().logger
    if (!userContext.config.llm?.apiKey) userContext.logger.warn('[config] llm.apiKey is not set — LLM calls will fail')

    // --- M3+M4: primaryAgentId + default agent 보충 ---
    // admin 은 admin-bootstrap 이 처리. 비-admin user 만 여기서 lazy migration.
    if (username) {
      const { config: migratedConfig } = ensureUserDefaultAgent(userContext.config, {
        username, logger: userContext.logger,
      })
      userContext.config = migratedConfig
    }

    // --- Persona ---
    // docs/design/agent-identity-model.md §6.1 — persona 는 agent 의 필드.
    // 런타임 소비처(ephemeral-inits, server API)는 getPrimaryPersona() 사용.
    // userContext.persona (global Conf) 는 legacy 테스트 호환용으로만 유지.
    userContext.persona = createPersona()
    userContext.personaConfig = userContext.getPrimaryPersona()

    // --- Memory (외부 주입) ---
    userContext.memory = opts.memory ?? null
    userContext.logger.info(userContext.memory ? 'Memory: mem0 enabled' : 'Memory: disabled')

    // --- User data path (jobStore, userDataStore) ---
    userContext.userDataPath = Config.userDataPath(username || 'default')

    // --- Embedder ---
    userContext.embedder = buildEmbedder(userContext.config)

    // --- Tools (local + MCP) ---
    // local tool 은 세션 context (ctx.resolvePath) 로 workingDir 경계 검증.
    // UserContext 레벨에서 allowedDirs 주입 없음 (session 경유가 유일 진실).
    userContext.toolRegistry = createToolRegistry()
    const localTools = createLocalTools()
    for (const tool of localTools) userContext.toolRegistry.register(tool)
    const { mcpConnections } = await initMcpIntegration(userContext.config, userContext.logger, userContext.toolRegistry)
    userContext.mcpConnections = mcpConnections

    // --- LLM + Agents ---
    userContext.llm = new LLMClient({
      baseUrl: userContext.config.llm.baseUrl,
      model: userContext.config.llm.model,
      apiKey: userContext.config.llm.apiKey,
      timeoutMs: userContext.config.llm.timeoutMs,
    })
    userContext.agentRegistry = createAgentRegistry()
    registerSummarizer(userContext.agentRegistry, userContext.llm, { userId: username || 'default' })
    // A2A Phase 1 S3 — agent discovery tool. registerAgentSessions 이후에
    // config.agents 가 추가되어도 handler 호출 시점에 agentRegistry.list() 가 최신 값 반환.
    userContext.toolRegistry.register(createListAgentsTool(userContext.agentRegistry))

    // --- Job Store + User Data Store + A2A Queue Store ---
    userContext.jobStore = createJobStore(defaultJobDbPath(userContext.userDataPath))
    userContext.userDataStore = new UserDataStore(defaultUserDataDbPath(userContext.userDataPath))
    userContext.a2aQueueStore = createA2aQueueStore(defaultA2aQueueDbPath(userContext.userDataPath))

    // --- Sessions (userContext 자기 참조) ---
    userContext.sessions = createSessionManager(userContext, { onSessionCreated })

    // --- A2A expire tick (S2, a2a-internal.md §6.6) ---
    userContext.a2aExpireInterval = null
    userContext.a2aExpireInFlight = null
    userContext.startA2aExpireTick(opts.a2aExpireTickMs ?? A2A.EXPIRE_TICK_MS)

    return userContext
  }

  // A2A Phase 1 S2 — pending/processing request 가 timeout 초과 시 expired 전이
  // + sender 에게 expired response dispatch. unref() 로 프로세스 종료 방해 없음.
  startA2aExpireTick(intervalMs) {
    if (this.a2aExpireInterval) return
    this.a2aExpireInterval = setInterval(() => this.#runA2aExpireTick(), intervalMs)
    this.a2aExpireInterval.unref?.()
  }

  async #runA2aExpireTick() {
    const p = this.#expireTickBody().catch(err => {
      this.logger?.warn?.('A2A expire tick failed', { error: err?.message })
    })
    this.a2aExpireInFlight = p
    try { await p } finally { this.a2aExpireInFlight = null }
  }

  async #expireTickBody() {
    const now = Date.now()
    const expired = this.a2aQueueStore.listExpired(now)
    for (const request of expired) {
      // markExpired=false → receiver 가 먼저 completed 한 race. dispatchResponse skip.
      if (!this.a2aQueueStore.markExpired(request.id)) continue
      await dispatchResponse({
        a2aQueueStore: this.a2aQueueStore,
        sessionManager: this.sessions,
        logger: this.logger,
        request,
        status: 'expired',
        payload: null,
        error: `timeout-${request.timeoutMs ?? A2A.DEFAULT_TIMEOUT_MS}ms`,
      })
    }
  }

  // A2A Phase 1 S4 — 서버 재시작 회복 (a2a-internal.md §6.4 v9).
  //   processing → markFailed('server-restart') + dispatchResponse
  //   pending → receiver 등록 시 event queue 재진입; 부재/enqueue실패 시 markFailed + response
  // bounded batch: A2A.RECOVER_BATCH_MAX 행 처리 후 종료. 잔여는 다음 startup 에서 처리.
  // feature flag: opts.recoverOnStart === false 시 skip — 첫 배포 운영 rollback 경로.
  // 호출 시점: server 가 sessions 등록 (registerAgentSessions) 후. start() 와 분리.
  async recoverA2aQueue({ sessionManager, recoverOnStart = true } = {}) {
    if (!recoverOnStart) return { skipped: true }
    const limit = A2A.RECOVER_BATCH_MAX
    const procRows = this.a2aQueueStore.listByStatus('processing', { kind: 'request', limit })
    for (const row of procRows) {
      if (!this.a2aQueueStore.markFailed(row.id, 'server-restart')) continue
      await this.#dispatchRecoveryResponse(row, 'server-restart', sessionManager)
    }
    const pendingRows = this.a2aQueueStore.listByStatus('pending', { kind: 'request', limit })
    for (const row of pendingRows) {
      const routing = sessionManager.findAgentSession(row.toAgentId)
      if (routing.kind === 'ok') {
        const enqueued = await this.#tryReenqueueA2aRequest(row, routing)
        if (!enqueued) {
          if (this.a2aQueueStore.markFailed(row.id, 'server-restart-enqueue-failed')) {
            await this.#dispatchRecoveryResponse(row, 'server-restart-enqueue-failed', sessionManager)
          }
        }
      } else {
        if (this.a2aQueueStore.markFailed(row.id, 'server-restart-target-missing')) {
          await this.#dispatchRecoveryResponse(row, 'server-restart-target-missing', sessionManager)
        }
      }
    }
    return { processingCount: procRows.length, pendingCount: pendingRows.length }
  }

  async #tryReenqueueA2aRequest(row, routing) {
    const receiverEventActor = routing.entry?.session?.actors?.eventActor ?? routing.entry?.session?.eventActor
    if (!receiverEventActor) return false
    // event meta 인라인 — withEventMeta 와 동일 (id 보존, receivedAt 부여).
    const event = {
      id: row.id,
      type: EVENT_TYPE.A2A_REQUEST,
      prompt: row.payload,
      fromAgentId: row.fromAgentId,
      toAgentId: row.toAgentId,
      requestId: row.id,
      category: row.category ?? 'todo',
      receivedAt: Date.now(),
    }
    return await new Promise((resolve) => {
      try {
        receiverEventActor.enqueue(event).fork(
          () => resolve(false),
          () => resolve(true),
        )
      } catch (_err) { resolve(false) }
    })
  }

  async #dispatchRecoveryResponse(row, errorCode, sessionManager) {
    await dispatchResponse({
      a2aQueueStore: this.a2aQueueStore,
      sessionManager,
      logger: this.logger,
      request: row,
      status: 'failed',
      payload: null,
      error: errorCode,
    })
  }

  // primaryAgentId 가 가리키는 agent 반환 (없으면 null).
  // Agent ID 는 `{username}/{agentName}` — agentName 만 파싱해서 config.agents 에서 찾음.
  getPrimaryAgent() {
    const primaryId = this.config.primaryAgentId
    if (!primaryId || typeof primaryId !== 'string') return null
    const agentName = primaryId.split('/')[1]
    if (!agentName) return null
    const agents = Array.isArray(this.config.agents) ? this.config.agents : []
    return agents.find(a => a.name === agentName) || null
  }

  // primary agent 의 persona 반환. 없거나 persona 비어있으면 DEFAULT_PERSONA.
  getPrimaryPersona() {
    const agent = this.getPrimaryAgent()
    return { ...DEFAULT_PERSONA, ...(agent?.persona || {}) }
  }

  // 세션 → 인프라 순서로 정리.
  // A2A expire tick 우선 정리 (새 tick 차단 + in-flight 완료 대기) 후 store close.
  async shutdown() {
    if (this.a2aExpireInterval) {
      clearInterval(this.a2aExpireInterval)
      this.a2aExpireInterval = null
    }
    if (this.a2aExpireInFlight) {
      try { await this.a2aExpireInFlight } catch (_) {}
    }
    await Promise.all(this.sessions.list().map(({ session }) => session.shutdown().catch(() => {})))
    this.jobStore.close()
    this.userDataStore.close()
    this.a2aQueueStore.close()
    for (const conn of this.mcpConnections) {
      try { await conn.close() } catch (_) {}
    }
  }
}

export { UserContext }
