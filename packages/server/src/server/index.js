import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import express from 'express'
import { WebSocketServer } from 'ws'
import { UserContext } from '@presence/infra/infra/user-context.js'
import { Config } from '@presence/infra/infra/config.js'
import { createUserStore } from '@presence/infra/infra/auth/auth-user-store.js'
import { SESSION_TYPE } from '@presence/core/core/policies.js'
import { sessionBridgeR } from './ws-bridge.js'
import { sessionRoutesR } from './legacy-routes.js'
import { buildUserContextManager } from './user-context-manager.js'
import { setupAuth } from './auth-setup.js'
import { mountSessionApi } from './session-api.js'
import { attachWsHandler } from './ws-handler.js'
import { createGlobalScheduler } from './scheduler.js'

// =============================================================================
// Presence HTTP + WebSocket 서버.
// =============================================================================

// CORS — localhost cross-origin 허용.
const corsMiddleware = (req, res, next) => {
  const origin = req.headers.origin
  if (origin) {
    try {
      const h = new URL(origin).hostname
      if (h === 'localhost' || h === '127.0.0.1') {
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

// config.agents → 서브 에이전트 세션 생성 + agentRegistry 등록.
const registerAgentSessions = (userContext) => {
  for (const agentDef of (userContext.config.agents || [])) {
    const agentEntry = userContext.sessions.create({
      id: `agent-${agentDef.name}`, type: SESSION_TYPE.AGENT,
    })
    userContext.agentRegistry.register({
      name: agentDef.name,
      description: agentDef.description,
      capabilities: agentDef.capabilities || [],
      type: 'local',
      run: (task) => agentEntry.session.handleInput(task),
    })
    agentEntry.session.delegateActor.start().fork(() => {}, () => {})
  }
}

// 정적 웹 UI (web/dist 존재 시만). API 라우트 이후 마운트.
const mountStaticWebUi = (expressApp) => {
  try {
    const webDist = join(import.meta.dirname, '../../../web/dist')
    if (!existsSync(webDist)) return false
    expressApp.use(express.static(webDist))
    expressApp.get('/{*splat}', (_req, res) => res.sendFile(join(webDist, 'index.html')))
    return true
  } catch (_) {
    return false
  }
}

const logStartupSummary = (ctx) => {
  const { userContext, host, port, username, defaultSession, hasWebUI } = ctx
  const { config: cfg, mcpConnections, jobStore } = userContext
  const toolCount = defaultSession.tools.length
  const agentCount = userContext.agentRegistry.list().length
  const jobCount = jobStore.listJobs().filter(j => j.enabled).length

  console.log(`\nPresence server ready`)
  if (username || process.env.PRESENCE_INSTANCE_ID) console.log(`  User       : ${username || process.env.PRESENCE_INSTANCE_ID}`)
  console.log(`  URL        : http://${host}:${port}`)
  console.log(`  WebSocket  : ws://${host}:${port}`)
  console.log(`  Model      : ${cfg.llm.model}`)
  console.log(`  Memory     : ${userContext.memoryPath}`)
  console.log(`  Tools      : ${toolCount}`)
  console.log(`  Agents     : ${agentCount}`)
  if (mcpConnections.length > 0) console.log(`  MCP        : ${mcpConnections.length} server(s)`)
  console.log(`  Scheduler  : ${cfg.scheduler.enabled ? `enabled (${jobCount} active jobs)` : 'disabled'}`)
  if (hasWebUI) console.log(`  Web UI     : http://${host}:${port}`)
  console.log(`\n  CLI client : npm run start:cli`)
  console.log(`  Logs       : ~/.presence/logs/agent.log\n`)
}

const buildAppFacade = (userContext, defaultSession, globalSchedulerActor, shutdown) => ({
  state: defaultSession.state,
  tools: defaultSession.tools,
  agents: defaultSession.agents,
  config: userContext.config,
  logger: userContext.logger,
  personaConfig: userContext.personaConfig,
  memory: userContext.memory,
  llm: userContext.llm,
  mcpControl: userContext.mcpControl,
  jobStore: userContext.jobStore,
  handleInput: defaultSession.handleInput,
  handleApproveResponse: defaultSession.handleApproveResponse,
  handleCancel: defaultSession.handleCancel,
  schedulerActor: globalSchedulerActor,
  delegateActor: defaultSession.delegateActor,
  shutdown,
})

/**
 * Start the Presence HTTP + WebSocket server.
 * @param {object} configOverride
 * @param {{port?: number, host?: string, persistenceCwd?: string, username?: string}} [options]
 * @returns {Promise<{server, wss, app, userContext, shutdown}>}
 */
const startServer = async (configOverride, opts = {}) => {
  const { port = 3000, host = '127.0.0.1', persistenceCwd, username } = opts
  const expressApp = express()
  const server = createServer(expressApp)
  const wss = new WebSocketServer({ server })
  expressApp.use(corsMiddleware)

  const bridge = sessionBridgeR.run({ wss })

  const userContext = await UserContext.create(configOverride, {
    username,
    onSessionCreated: ({ id, type, session }) => {
      if (type !== SESSION_TYPE.SCHEDULED) bridge.watchSession(id, session.state)
    },
  })
  const serverStartedAt = Date.now()
  const globalSchedulerActor = createGlobalScheduler(userContext)

  const defaultEntry = userContext.sessions.create({
    id: 'user-default', type: SESSION_TYPE.USER, persistenceCwd,
    onScheduledJobDone: () => {},
  })
  const defaultSession = defaultEntry.session
  registerAgentSessions(userContext)

  // Auth
  const { authEnabled } = setupAuth(expressApp)
  let userContextManager = null
  const getUserContextManager = () => userContextManager

  // Activity tracking middleware (인증된 요청)
  expressApp.use('/api', (req, _res, next) => {
    if (req.user?.username && userContextManager) userContextManager.touch(req.user.username)
    next()
  })

  // Health endpoint
  expressApp.get('/api/instance', (_req, res) => {
    res.json({
      id: username || process.env.PRESENCE_INSTANCE_ID || 'standalone',
      status: 'running',
      uptime: Math.floor((Date.now() - serverStartedAt) / 1000),
      authRequired: authEnabled,
    })
  })

  // Session API
  mountSessionApi(expressApp, { userContext, getUserContextManager, authEnabled })
  expressApp.use('/api', sessionRoutesR.run({ session: defaultSession, userContext }))

  // UserContextManager (인증 활성화 시)
  userContextManager = buildUserContextManager({ bridge, configOverride })

  // WebSocket
  const userStore = createUserStore()
  const { createTokenService } = await import('@presence/infra/infra/auth/auth-token.js')
  const tokenService = createTokenService()
  attachWsHandler(wss, {
    host, authEnabled, tokenService, userStore,
    userContext, defaultSession, getUserContextManager,
  })

  // Background tasks
  if (userContext.config.scheduler.enabled) globalSchedulerActor.start().fork(() => {}, () => {})
  defaultSession.delegateActor.start().fork(() => {}, () => {})

  // Shutdown
  const shutdown = async () => {
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
    globalSchedulerActor.stop().fork(() => {}, () => {})
    await userContext.shutdown()
    if (userContextManager) await userContextManager.shutdownAll()
    await new Promise(r => wss.close(r))
    await new Promise(r => server.close(r))
  }
  const onSignal = async () => { await shutdown(); process.exit(0) }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  const hasWebUI = mountStaticWebUi(expressApp)

  await new Promise(resolve => server.listen(port, host, resolve))
  userContext.logger.info(`Server listening on http://${host}:${port}`)
  logStartupSummary({ userContext, host, port, username, defaultSession, hasWebUI })

  const app = buildAppFacade(userContext, defaultSession, globalSchedulerActor, shutdown)
  return { server, wss, app, userContext, shutdown }
}

export { startServer, sessionRoutesR, sessionBridgeR }

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
