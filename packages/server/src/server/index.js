import { createServer } from 'node:http'
import { join } from 'node:path'
import express from 'express'
import { WebSocketServer } from 'ws'
import { UserContext } from '@presence/infra/infra/user-context.js'
import { loadServer } from '@presence/infra/infra/config-loader.js'
import { Memory } from '@presence/infra/infra/memory.js'
import { SESSION_TYPE } from '@presence/infra/infra/constants.js'
import { Config } from '@presence/infra/infra/config.js'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import { runAdminBootstrap, deleteInitialPasswordFile, ADMIN_USERNAME } from '@presence/infra/infra/admin-bootstrap.js'
import { bootCedarSubsystem } from '@presence/infra/infra/authz/cedar/index.js'
import { createServerScheduler, registerAgentSessions } from './scheduler-factory.js'
import { sessionBridgeR, WsHandler } from './ws-handler.js'
import { UserContextManager } from './user-context-manager.js'
import { createAuthSetup } from './auth-setup.js'
import { createSessionRouter } from './session-api.js'
import { createA2aRouter } from './a2a-router.js'
import { fireAndForget } from '@presence/core/lib/task.js'
import { corsMiddleware, mountStaticWebUi, logStartupSummaryR, warnPresenceDirChange, closeAsync, listenAsync } from './server-utils.js'

// =============================================================================
// PresenceServer: HTTP + WebSocket 서버 facade.
// =============================================================================


class PresenceServer {
  #httpServer
  #expressApp
  #wss
  #bridge
  #memory
  #userContext
  #userContextManager
  #scheduler
  #defaultSession
  #authEnabled
  #startedAt
  #port
  #host
  #username
  #evaluator

  static async create(configOverride, opts = {}) {
    const instance = new PresenceServer(opts)
    await instance.#boot(configOverride, opts)
    return instance
  }

  constructor(opts) {
    const { port = 3000, host = '127.0.0.1', username } = opts
    this.#port = port
    this.#host = host
    this.#username = username
    this.#expressApp = express()
    this.#httpServer = createServer(this.#expressApp)
    this.#wss = new WebSocketServer({ server: this.#httpServer })
    this.#expressApp.use(corsMiddleware)
  }

  // --- public accessors (테스트 하위 호환) ---

  get server() { return this.#httpServer }
  get wss() { return this.#wss }
  get userContext() { return this.#userContext }
  get evaluator() { return this.#evaluator }

  get app() {
    return {
      state: this.#defaultSession.state,
      tools: this.#defaultSession.tools,
      agents: this.#defaultSession.agents,
      config: this.#userContext.config,
      logger: this.#userContext.logger,
      personaConfig: this.#userContext.getPrimaryPersona(),
      memory: this.#userContext.memory,
      llm: this.#userContext.llm,
      toolRegistry: this.#userContext.toolRegistry,
      jobStore: this.#userContext.jobStore,
      handleInput: this.#defaultSession.handleInput,
      handleApproveResponse: this.#defaultSession.handleApproveResponse,
      handleCancel: this.#defaultSession.handleCancel,
      schedulerActor: this.#scheduler,
      delegateActor: this.#defaultSession.delegateActor,
      shutdown: this.shutdown.bind(this),
    }
  }

  async shutdown() {
    process.off('SIGTERM', this.#onSignal)
    process.off('SIGINT', this.#onSignal)
    fireAndForget(this.#scheduler.stop())
    await this.#userContext.shutdown()
    if (this.#userContextManager) await this.#userContextManager.shutdownAll()
    await closeAsync(this.#wss)
    await closeAsync(this.#httpServer)
  }

  // --- private bootstrap ---

  async #boot(configOverride, opts) {
    const { persistenceCwd } = opts
    const config = configOverride || loadServer()

    // docs §11.1 — a2a.enabled=true 일 때 publicUrl 필수. 없으면 부팅 거부.
    if (config.a2a?.enabled && !config.a2a?.publicUrl) {
      throw new Error('config.a2a.enabled=true requires publicUrl (docs/design/agent-identity-model.md §11.1)')
    }

    // KG-06: PRESENCE_DIR 변경 시 이전 경로 데이터 경고
    warnPresenceDirChange()

    // Admin bootstrap — docs/design/agent-identity-model.md §7.3
    // loadServer 직후, UserContext 생성 전. 실패 시 throw → 서버 부팅 거부.
    const presenceDir = Config.presenceDir()
    const bootstrapUserStore = createUserStore()
    try {
      const result = await runAdminBootstrap({
        userStore: bootstrapUserStore,
        presenceDir,
        logger: console,
      })
      if (result.createdAccount) {
        console.log(`[admin-bootstrap] Admin created. Initial password file: ${presenceDir}/admin-initial-password.txt`)
      }
    } catch (err) {
      throw new Error(`Admin bootstrap failed: ${err.message}. Recovery: check ${presenceDir} write permissions or delete partial files.`)
    }

    // Cedar 인프라 부팅 — 정책/스키마 parse 검증 (boot fail-closed) + audit writer.
    // 의미론 호출처는 governance-cedar v2.1 phase 에서 박힘. 이 phase 는 evaluator 노출만.
    this.#evaluator = await bootCedarSubsystem({ presenceDir })

    this.#bridge = sessionBridgeR.run({ wss: this.#wss })

    // 서버 레벨 Memory — 모든 유저 공유
    this.#memory = await Memory.create(config).catch(err => {
      console.warn('mem0 init failed, memory disabled', { error: err.message })
      return null
    })

    this.#userContext = await UserContext.create(config, {
      username: this.#username,
      memory: this.#memory,
      evaluator: this.#evaluator,
      onSessionCreated: ({ id, type, session }) => {
        if (type !== SESSION_TYPE.SCHEDULED) this.#bridge.watchSession(id, session)
      },
    })
    this.#startedAt = Date.now()
    this.#scheduler = createServerScheduler(this.#userContext, { username: this.#username })

    // 기본 세션 + 에이전트 세션
    const defaultUserId = this.#username || 'default'
    // agentId: M1 단계 runtime hardcode `${userId}/default`.
    // M3 에서 config.primaryAgentId 로 이관 (docs/design/agent-identity-model.md §12).
    // 세션 경로에 agent 디렉토리 삽입 — opts.persistenceCwd 가 주어진 경우에만
    // agent 계층 조립. 프로덕션 cli.js 는 persistenceCwd 없이 호출 → persistence no-op.
    // 테스트 mock-server.js 는 tmpDir 주입 → tmpDir/agents/default/sessions/user-default/.
    const defaultPersistenceCwd = persistenceCwd
      ? join(persistenceCwd, 'agents', 'default', 'sessions', 'user-default')
      : undefined
    const defaultEntry = this.#userContext.sessions.create({
      id: 'user-default', type: SESSION_TYPE.USER, persistenceCwd: defaultPersistenceCwd,
      userId: defaultUserId,
      agentId: `${defaultUserId}/default`,
      onScheduledJobDone: Function.prototype,
    })
    this.#defaultSession = defaultEntry.session
    registerAgentSessions(this.#userContext, this.#username)
    // S4: A2A 큐 재시작 회복. config.a2a.recoverOnStart 기본 true.
    await this.#userContext.recoverA2aQueue({
      sessionManager: this.#userContext.sessions,
      recoverOnStart: this.#userContext.config?.a2a?.recoverOnStart !== false,
    })

    // Auth + UserContextManager — admin 비밀번호 변경 성공 시 initial-password 파일 삭제
    const auth = createAuthSetup({
      onPasswordChanged: (username) => {
        if (username === ADMIN_USERNAME) deleteInitialPasswordFile(presenceDir)
      },
    })
    this.#authEnabled = true
    this.#userContextManager = new UserContextManager({ bridge: this.#bridge, serverConfig: config, memory: this.#memory, evaluator: this.#evaluator })
    const getUserContextManager = () => this.#userContextManager

    // Express 라우트 마운트 (순서 중요)
    this.#mountRoutes(auth, { getUserContextManager })

    // WebSocket
    const wsHandler = new WsHandler({
      host: this.#host, authEnabled: this.#authEnabled, wsAuth: auth.wsAuth,
      userContext: this.#userContext, getUserContextManager,
    })
    wsHandler.attach(this.#wss)

    // Background tasks
    if (this.#userContext.config.scheduler.enabled) fireAndForget(this.#scheduler.start())
    fireAndForget(this.#defaultSession.delegateActor.start())

    // Signal handlers
    process.on('SIGTERM', this.#onSignal)
    process.on('SIGINT', this.#onSignal)

    // Listen
    await listenAsync(this.#httpServer, this.#port, this.#host)
    this.#userContext.logger.info(`Server listening on http://${this.#host}:${this.#port}`)
    logStartupSummaryR.run({
      server: { username: this.#username, host: this.#host, port: this.#port },
      infra: { config: this.#userContext.config, memory: this.#memory, defaultSession: this.#defaultSession, userContext: this.#userContext },
    })
  }

  // Express 미들웨어 + 라우트 마운트. 순서가 곧 파이프라인.
  #mountRoutes(auth, { getUserContextManager }) {
    const app = this.#expressApp

    // 1. Cookie parser
    app.use(auth.cookieParser)
    // 2. Public auth routes (인증 불필요: login, refresh, logout, status)
    app.use('/api/auth', auth.publicRouter)
    // 3. Auth middleware (JWT 검증)
    app.use('/api', auth.authMiddleware)
    // 4. Protected auth routes (인증 필요: change-password)
    app.use('/api/auth', auth.protectedRouter)
    // 5. Activity tracking
    app.use('/api', (req, _res, next) => {
      if (req.user?.username && this.#userContextManager) this.#userContextManager.touch(req.user.username)
      next()
    })
    // 6. Health endpoint
    app.get('/api/instance', (_req, res) => {
      res.json({
        id: this.#username || process.env.PRESENCE_INSTANCE_ID || 'standalone',
        status: 'running',
        uptime: Math.floor((Date.now() - this.#startedAt) / 1000),
        authRequired: this.#authEnabled,
      })
    })
    // 7. Session API
    app.use('/api', createSessionRouter({
      userContext: this.#userContext, getUserContextManager, authEnabled: this.#authEnabled,
    }))
    // 8. /a2a — docs/design/agent-identity-model.md §11. enabled=true 에서만 마운트.
    // JSON-RPC 메시지 처리 + A2A JWT 는 authz phase — 현재 discovery 엔드포인트만.
    if (this.#userContext.config.a2a?.enabled) {
      app.use('/a2a', createA2aRouter({
        userContext: this.#userContext,
        config: this.#userContext.config,
      }))
    }
    // 9. Static web UI (catch-all — 반드시 마지막)
    mountStaticWebUi(this.#expressApp)
  }

  #onSignal = async () => { await this.shutdown(); process.exit(0) }

}

// 레거시 브릿지 — 테스트 호환 { server, wss, app, userContext, evaluator, shutdown }
const startServer = async (configOverride, opts = {}) => {
  const instance = await PresenceServer.create(configOverride, opts)
  return {
    server: instance.server,
    wss: instance.wss,
    app: instance.app,
    userContext: instance.userContext,
    evaluator: instance.evaluator,
    shutdown: instance.shutdown.bind(instance),
  }
}

export { PresenceServer, startServer, sessionBridgeR }
