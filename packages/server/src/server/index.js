import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import express from 'express'
import { WebSocketServer } from 'ws'
import { UserContext } from '@presence/infra/infra/user-context.js'
import { Config } from '@presence/infra/infra/config.js'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import { SESSION_TYPE } from '@presence/infra/infra/constants.js'
import { DelegationMode } from '@presence/infra/infra/agents/delegation.js'
import { createSchedulerActor } from '@presence/infra/infra/actors/scheduler-actor.js'
import { sessionBridgeR, WsHandler } from './ws-handler.js'
import { UserContextManager } from './user-context-manager.js'
import { createAuthSetup } from './auth-setup.js'
import { createSessionRouter } from './session-api.js'

// =============================================================================
// PresenceServer: HTTP + WebSocket 서버 facade.
// =============================================================================

// CORS — localhost cross-origin 허용.
const corsMiddleware = (req, res, next) => {
  const origin = req.headers.origin
  if (origin) {
    try {
      const hostname = new URL(origin).hostname
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        res.header('Access-Control-Allow-Origin', origin)
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        res.header('Access-Control-Allow-Credentials', 'true')
      }
    } catch {}
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
}

class PresenceServer {
  #httpServer
  #expressApp
  #wss
  #bridge
  #userContext
  #userContextManager
  #scheduler
  #defaultSession
  #authEnabled
  #startedAt
  #port
  #host
  #username

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

  get app() {
    return {
      state: this.#defaultSession.state,
      tools: this.#defaultSession.tools,
      agents: this.#defaultSession.agents,
      config: this.#userContext.config,
      logger: this.#userContext.logger,
      personaConfig: this.#userContext.personaConfig,
      memory: this.#userContext.memory,
      llm: this.#userContext.llm,
      toolRegistry: this.#userContext.toolRegistry,
      jobStore: this.#userContext.jobStore,
      handleInput: this.#defaultSession.handleInput,
      handleApproveResponse: this.#defaultSession.handleApproveResponse,
      handleCancel: this.#defaultSession.handleCancel,
      schedulerActor: this.#scheduler,
      delegateActor: this.#defaultSession.delegateActor,
      shutdown: () => this.shutdown(),
    }
  }

  async shutdown() {
    process.off('SIGTERM', this.#onSignal)
    process.off('SIGINT', this.#onSignal)
    this.#scheduler.stop().fork(() => {}, () => {})
    await this.#userContext.shutdown()
    if (this.#userContextManager) await this.#userContextManager.shutdownAll()
    await new Promise(resolve => this.#wss.close(resolve))
    await new Promise(resolve => this.#httpServer.close(resolve))
  }

  // --- private bootstrap ---

  async #boot(configOverride, opts) {
    const { persistenceCwd } = opts

    this.#bridge = sessionBridgeR.run({ wss: this.#wss })

    this.#userContext = await UserContext.create(configOverride, {
      username: this.#username,
      onSessionCreated: ({ id, type, session }) => {
        if (type !== SESSION_TYPE.SCHEDULED) this.#bridge.watchSession(id, session.state)
      },
    })
    this.#startedAt = Date.now()
    this.#scheduler = this.#createScheduler()

    // 기본 세션 + 에이전트 세션
    const defaultEntry = this.#userContext.sessions.create({
      id: 'user-default', type: SESSION_TYPE.USER, persistenceCwd,
      onScheduledJobDone: () => {},
    })
    this.#defaultSession = defaultEntry.session
    this.#registerAgentSessions()

    // Auth + UserContextManager
    const auth = createAuthSetup()
    this.#authEnabled = true
    this.#userContextManager = new UserContextManager({ bridge: this.#bridge, configOverride })
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
    if (this.#userContext.config.scheduler.enabled) this.#scheduler.start().fork(() => {}, () => {})
    this.#defaultSession.delegateActor.start().fork(() => {}, () => {})

    // Signal handlers
    process.on('SIGTERM', this.#onSignal)
    process.on('SIGINT', this.#onSignal)

    // Listen
    await new Promise(resolve => this.#httpServer.listen(this.#port, this.#host, resolve))
    this.#userContext.logger.info(`Server listening on http://${this.#host}:${this.#port}`)
    this.#logStartupSummary()
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
    // 8. Static web UI (catch-all — 반드시 마지막)
    this.#mountStaticWebUi()
  }

  #onSignal = async () => { await this.shutdown(); process.exit(0) }

  #createScheduler() {
    let scheduler
    scheduler = createSchedulerActor({
      store: this.#userContext.jobStore,
      onDispatch: (jobEvent) => {
        const sessionId = `scheduled-${jobEvent.runId}`
        const entry = this.#userContext.sessions.create({
          type: SESSION_TYPE.SCHEDULED,
          id: sessionId,
          onScheduledJobDone: (event, outcome) => {
            const task = outcome.success
              ? scheduler.jobDone(event.runId, event.jobId, outcome.result)
              : scheduler.jobFail(event.runId, event.jobId, event.attempt ?? 1, outcome.error)
            task.fork(() => {}, () => {})
            this.#userContext.sessions.destroy(sessionId).catch(() => {})
          },
        })
        entry.session.eventActor.enqueue(jobEvent).fork(() => {}, () => {})
      },
      logger: this.#userContext.logger,
      pollIntervalMs: this.#userContext.config.scheduler.pollIntervalMs,
    })
    return scheduler
  }

  #registerAgentSessions() {
    for (const agentDef of (this.#userContext.config.agents || [])) {
      const agentEntry = this.#userContext.sessions.create({
        id: `agent-${agentDef.name}`, type: SESSION_TYPE.AGENT,
      })
      this.#userContext.agentRegistry.register({
        name: agentDef.name,
        description: agentDef.description,
        capabilities: agentDef.capabilities || [],
        type: DelegationMode.LOCAL,
        run: (task) => agentEntry.session.handleInput(task),
      })
      agentEntry.session.delegateActor.start().fork(() => {}, () => {})
    }
  }

  #mountStaticWebUi() {
    try {
      const webDist = join(import.meta.dirname, '../../../web/dist')
      if (!existsSync(webDist)) return false
      this.#expressApp.use(express.static(webDist))
      this.#expressApp.get('/{*splat}', (_req, res) => res.sendFile(join(webDist, 'index.html')))
      return true
    } catch (_) {
      return false
    }
  }

  #logStartupSummary() {
    const { config: cfg, mcpConnections, jobStore } = this.#userContext
    const toolCount = this.#defaultSession.tools.length
    const agentCount = this.#userContext.agentRegistry.list().length
    const jobCount = jobStore.listJobs().filter(job => job.enabled).length
    const hasWebUI = existsSync(join(import.meta.dirname, '../../../web/dist'))

    console.log(`\nPresence server ready`)
    if (this.#username || process.env.PRESENCE_INSTANCE_ID) console.log(`  User       : ${this.#username || process.env.PRESENCE_INSTANCE_ID}`)
    console.log(`  URL        : http://${this.#host}:${this.#port}`)
    console.log(`  WebSocket  : ws://${this.#host}:${this.#port}`)
    console.log(`  Model      : ${cfg.llm.model}`)
    console.log(`  Memory     : ${this.#userContext.memoryPath}`)
    console.log(`  Tools      : ${toolCount}`)
    console.log(`  Agents     : ${agentCount}`)
    if (mcpConnections.length > 0) console.log(`  MCP        : ${mcpConnections.length} server(s)`)
    console.log(`  Scheduler  : ${cfg.scheduler.enabled ? `enabled (${jobCount} active jobs)` : 'disabled'}`)
    if (hasWebUI) console.log(`  Web UI     : http://${this.#host}:${this.#port}`)
    console.log(`\n  CLI client : npm run start:cli`)
    console.log(`  Logs       : ~/.presence/logs/agent.log\n`)
  }
}

// 레거시 브릿지 — 테스트 호환 { server, wss, app, userContext, shutdown }
const startServer = async (configOverride, opts = {}) => {
  const instance = await PresenceServer.create(configOverride, opts)
  return {
    server: instance.server,
    wss: instance.wss,
    app: instance.app,
    userContext: instance.userContext,
    shutdown: () => instance.shutdown(),
  }
}

export { PresenceServer, startServer, sessionBridgeR }

// CLI 실행
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''))) {
  const userStore = createUserStore()
  if (!userStore.hasUsers()) {
    console.error('No users configured.')
    console.error('Run: npm run user -- init')
    process.exit(1)
  }
  const port = Number(process.env.PORT) || 3000
  const host = process.env.HOST || '127.0.0.1'
  const config = Config.loadServer()
  console.log(`Starting Presence server on ${host}:${port}...`)
  startServer(config, { port, host }).catch(err => {
    console.error(`\nFailed to start server: ${err.message}`)
    if (err.code === 'EADDRINUSE') console.error(`  Port ${port} is already in use. Set a different port with PORT=<n>`)
    else if (err.code === 'EACCES') console.error(`  Permission denied. Try a port above 1024.`)
    process.exit(1)
  })
}
