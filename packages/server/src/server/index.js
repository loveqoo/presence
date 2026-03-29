import { createServer } from 'node:http'
import express from 'express'
import { WebSocketServer } from 'ws'
import { createGlobalContext } from '@presence/infra/infra/global-context.js'
import { loadInstanceConfig } from '@presence/infra/infra/config.js'
import { createSessionManager } from '@presence/infra/infra/session-manager.js'
import { createSchedulerActor } from '@presence/infra/infra/scheduler-actor.js'
import { clearDebugState } from '@presence/core/core/agent.js'
import { SESSION_TYPE } from '@presence/core/core/policies.js'
import { createUserStore } from '@presence/infra/infra/auth-user-store.js'
import { createTokenService } from '@presence/infra/infra/auth-token.js'
import { createLocalAuthProvider } from '@presence/infra/infra/auth-provider.js'
import {
  loginHandlerR, refreshHandlerR, logoutHandlerR,
  authMiddlewareR, authenticateWsR,
} from '@presence/infra/infra/auth-middleware.js'
import fp from '@presence/core/lib/fun-fp.js'
const { Either, Reader } = fp

// =============================================================================
// State → WebSocket Bridge (세션 인식)
// 세션의 state.hooks 변경을 연결된 모든 클라이언트에 push.
// session_id 포함으로 클라이언트가 멀티 세션 구분 가능.
// =============================================================================

const WATCHED_PATHS = [
  'turnState', 'lastTurn', 'turn',
  'context.memories', 'context.conversationHistory',
  '_streaming', '_retry', '_approve',
  '_debug.lastTurn', '_debug.opTrace', '_debug.recalledMemories',
  '_budgetWarning', '_toolResults',
  'todos', 'events', 'events.*', 'delegates', 'delegates.*',
]

// --- SessionBridge: Reader({ wss } → { broadcast, watchSession }) ---

/**
 * Reader that creates a WebSocket bridge for broadcasting session state changes.
 * Provides `broadcast` (send to all clients) and `watchSession` (subscribe a session's state hooks).
 * @type {Reader<{wss: WebSocketServer}, {broadcast: Function, watchSession: Function}>}
 */
const sessionBridgeR = Reader.asks(({ wss }) => {
  const broadcast = (data) => {
    const msg = JSON.stringify(data)
    for (const ws of wss.clients) {
      if (ws.readyState === 1) ws.send(msg)
    }
  }

  const watchSession = (sessionId, state) => {
    for (const path of WATCHED_PATHS) {
      const broadcastPath = path.replace('.*', '')
      state.hooks.on(path, () => {
        broadcast({ type: 'state', session_id: sessionId, path: broadcastPath, value: state.get(broadcastPath) })
      })
    }
  }

  return { broadcast, watchSession }
})

// =============================================================================
// Slash commands
// =============================================================================

const handleSlashCommand = (input, { state, tools, memory, mcpControl }) => {
  if (input.startsWith('/mcp')) {
    if (!mcpControl || mcpControl.list().length === 0) return { handled: true, result: { type: 'system', content: 'No MCP servers configured.' } }
    const args = input.trim().split(/\s+/).slice(1)
    const sub = args[0] || 'list'
    if (sub === 'list') {
      const lines = mcpControl.list().map(s => `${s.enabled ? '●' : '○'} ${s.prefix}  ${s.serverName}  (${s.toolCount} tools)`)
      return { handled: true, result: { type: 'system', content: `MCP servers:\n${lines.join('\n')}` } }
    }
    if (sub === 'enable' || sub === 'disable') {
      const prefix = args[1]
      if (!prefix) return { handled: true, result: { type: 'system', content: `Usage: /mcp ${sub} <id>` } }
      const ok = sub === 'enable' ? mcpControl.enable(prefix) : mcpControl.disable(prefix)
      return { handled: true, result: { type: 'system', content: ok ? `${prefix} ${sub}d.` : `Unknown MCP id: ${prefix}` } }
    }
    return { handled: true, result: { type: 'system', content: 'Usage: /mcp [list | enable <id> | disable <id>]' } }
  }
  if (input === '/clear') {
    clearDebugState(state)
    return { handled: true, result: { type: 'system', content: 'Conversation cleared.' } }
  }
  if (input === '/status') {
    const ts = state.get('turnState')
    const lt = state.get('lastTurn')
    return {
      handled: true,
      result: {
        type: 'system',
        content: `status: ${ts?.tag || 'idle'} | turn: ${state.get('turn') || 0} | last: ${lt?.tag || 'none'}`,
      },
    }
  }
  if (input === '/tools') {
    return { handled: true, result: { type: 'system', content: tools.map(t => t.name).join(', ') || '(none)' } }
  }
  if (input === '/memory list') {
    const nodes = memory.allNodes()
    const summary = nodes.slice(0, 20).map(n => `[${n.type}/${n.tier}] ${n.label}`).join('\n')
    return { handled: true, result: { type: 'system', content: `${nodes.length} nodes:\n${summary}` } }
  }
  return { handled: false }
}

// =============================================================================
// Per-session Express Router
// session: createSession() 반환값
// globalCtx: createGlobalContext() 반환값 (mcpControl, memory, config 등)
// =============================================================================

// --- SessionRoutes: Reader({ session, globalCtx } → Express Router) ---

/**
 * Reader that builds an Express router for a single session (chat, state, approve, cancel, tools, agents, config).
 * @type {Reader<{session: object, globalCtx: object}, import('express').Router>}
 */
const sessionRoutesR = Reader.asks(({ session, globalCtx }) => {
  const { mcpControl, memory, config } = globalCtx
  const router = express.Router()
  router.use(express.json())

  router.post('/chat', async (req, res) => {
    const { input } = req.body
    if (!input || typeof input !== 'string') {
      return res.status(400).json({ error: 'input (string) required' })
    }
    if (input.startsWith('/')) {
      const cmd = handleSlashCommand(input, { state: session.state, tools: session.tools, memory, mcpControl })
      if (cmd.handled) return res.json(cmd.result)
    }
    try {
      const result = await session.handleInput(input)
      res.json({ type: 'agent', content: result })
    } catch (err) {
      res.status(500).json({ type: 'error', content: err.message })
    }
  })

  router.get('/state', (_req, res) => {
    res.json(session.state.snapshot())
  })

  router.post('/approve', (req, res) => {
    session.handleApproveResponse(!!req.body.approved)
    res.json({ ok: true })
  })

  router.post('/cancel', (_req, res) => {
    session.handleCancel()
    res.json({ ok: true })
  })

  router.get('/tools', (_req, res) => {
    res.json(session.tools.map(t => ({ name: t.name, description: t.description, source: t.source })))
  })

  router.get('/agents', (_req, res) => {
    res.json(session.agents)
  })

  router.get('/config', (_req, res) => {
    const { llm, ...rest } = config
    const { apiKey, ...safeLlm } = llm
    res.json({ ...rest, llm: safeLlm })
  })

  return router
})

// =============================================================================
// Server 시작
// =============================================================================

/**
 * Start the Presence HTTP + WebSocket server for a single instance.
 * Initialises global context, session manager, scheduler, auth, and static web UI if available.
 * @param {object} configOverride - Instance config overrides merged on top of defaults.
 * @param {{port?: number, host?: string, persistenceCwd?: string, instanceId?: string}} [options]
 * @returns {Promise<{server: import('http').Server, wss: import('ws').WebSocketServer, app: object, sessionManager: object, globalCtx: object, shutdown: Function}>}
 */
const startServer = async (configOverride, { port = 3000, host = '127.0.0.1', persistenceCwd, instanceId } = {}) => {
  const globalCtx = await createGlobalContext(configOverride, { instanceId })
  const serverStartedAt = Date.now()

  const expressApp = express()
  const server = createServer(expressApp)
  const wss = new WebSocketServer({ server })

  const bridge = sessionBridgeR.run({ wss })

  const sessionManager = createSessionManager(globalCtx, {
    // ephemeral(scheduled) 세션은 WS 브릿지 구독 제외
    onSessionCreated: ({ id, type, session }) => {
      if (type !== SESSION_TYPE.SCHEDULED) bridge.watchSession(id, session.state)
    },
  })

  // 전역 스케줄러 — 잡 실행 시 ephemeral 세션 생성, 완료 후 소멸
  let globalSchedulerActor = createSchedulerActor({
    store: globalCtx.jobStore,
    onDispatch: (jobEvent) => {
      const sessionId = `scheduled-${jobEvent.runId}`
      const entry = sessionManager.create({
        type: SESSION_TYPE.SCHEDULED,
        id: sessionId,
        onScheduledJobDone: (event, outcome) => {
          if (outcome.success) {
            globalSchedulerActor.send({ type: 'job_done', runId: event.runId, jobId: event.jobId, result: outcome.result }).fork(() => {}, () => {})
          } else {
            globalSchedulerActor.send({ type: 'job_fail', runId: event.runId, jobId: event.jobId, attempt: event.attempt ?? 1, error: outcome.error }).fork(() => {}, () => {})
          }
          sessionManager.destroy(sessionId).catch(() => {})
        },
      })
      entry.session.eventActor.send({ type: 'enqueue', event: jobEvent }).fork(() => {}, () => {})
    },
    logger: globalCtx.logger,
    pollIntervalMs: globalCtx.config.scheduler.pollIntervalMs,
  })

  // 기본 사용자 세션 생성 (글로벌 스케줄러가 scheduled_job 처리)
  const defaultEntry = sessionManager.create({
    id: 'user-default', type: SESSION_TYPE.USER, persistenceCwd,
    onScheduledJobDone: () => {},
  })
  const defaultSession = defaultEntry.session

  // config.agents → 서브 에이전트 세션 생성 + agentRegistry 등록
  for (const agentDef of (globalCtx.config.agents || [])) {
    const agentEntry = sessionManager.create({
      id: `agent-${agentDef.name}`,
      type: SESSION_TYPE.AGENT,
    })
    globalCtx.agentRegistry.register({
      name: agentDef.name,
      description: agentDef.description,
      capabilities: agentDef.capabilities || [],
      type: 'local',
      run: (task) => agentEntry.session.handleInput(task),
    })
    agentEntry.session.delegateActor.send({ type: 'start' }).fork(() => {}, () => {})
  }

  // --- 인증 ---
  const userStore = instanceId ? createUserStore(instanceId) : null

  // instanceId가 있으면 인증 필수 — 사용자 없으면 시작 불가
  if (instanceId && !userStore?.hasUsers()) {
    throw new Error(`No users configured for instance '${instanceId}'. Run: npm run user -- init --instance ${instanceId}`)
  }

  const authEnabled = userStore?.hasUsers() ?? false
  let tokenService = null
  let authProvider = null

  if (authEnabled) {
    tokenService = createTokenService(instanceId)
    authProvider = createLocalAuthProvider(userStore)

    // cookie-parser (쿠키에서 refreshToken 추출용)
    expressApp.use((req, _res, next) => {
      req.cookies = {}
      const cookieStr = req.headers.cookie || ''
      for (const pair of cookieStr.split(';')) {
        const [key, ...rest] = pair.trim().split('=')
        if (key) req.cookies[key] = rest.join('=')
      }
      next()
    })

    // auth 라우트 + 미들웨어: Reader(AuthEnv) → .run(authEnv)
    const authEnv = {
      authProvider, tokenService, userStore,
      publicPaths: ['/auth/login', '/auth/refresh', '/auth/logout', '/instance'],
    }
    expressApp.post('/api/auth/login', express.json(), loginHandlerR.run(authEnv))
    expressApp.post('/api/auth/refresh', express.json(), refreshHandlerR.run(authEnv))
    expressApp.post('/api/auth/logout', express.json(), logoutHandlerR.run(authEnv))
    expressApp.use('/api', authMiddlewareR.run(authEnv))
  }

  // 인스턴스 헬스 엔드포인트 (public)
  expressApp.get('/api/instance', (_req, res) => {
    res.json({
      id: instanceId || 'standalone',
      status: 'running',
      uptime: Math.floor((Date.now() - serverStartedAt) / 1000),
      authRequired: authEnabled,
    })
  })

  // 레거시 라우트 (user-default)
  expressApp.use('/api', sessionRoutesR.run({ session: defaultSession, globalCtx }))

  // 세션별 라우트: /api/sessions/:sessionId/*
  expressApp.use('/api/sessions/:sessionId', express.json(), (req, res, next) => {
    const entry = sessionManager.get(req.params.sessionId)
    if (!entry) return res.status(404).json({ error: `Session not found: ${req.params.sessionId}` })
    req.presenceSession = entry
    next()
  })
  expressApp.post('/api/sessions/:sessionId/chat', async (req, res) => {
    const { session } = req.presenceSession
    const { input } = req.body
    if (!input || typeof input !== 'string') return res.status(400).json({ error: 'input (string) required' })
    if (input.startsWith('/')) {
      const cmd = handleSlashCommand(input, { state: session.state, tools: session.tools, memory: globalCtx.memory, mcpControl: globalCtx.mcpControl })
      if (cmd.handled) return res.json(cmd.result)
    }
    try {
      const result = await session.handleInput(input)
      res.json({ type: 'agent', content: result })
    } catch (err) {
      res.status(500).json({ type: 'error', content: err.message })
    }
  })
  expressApp.get('/api/sessions/:sessionId/state', (req, res) => res.json(req.presenceSession.session.state.snapshot()))
  expressApp.get('/api/sessions/:sessionId/tools', (req, res) => {
    const { session } = req.presenceSession
    res.json(session.tools.map(t => ({ name: t.name, description: t.description, source: t.source })))
  })
  expressApp.get('/api/sessions/:sessionId/agents', (req, res) => res.json(req.presenceSession.session.agents))
  expressApp.get('/api/sessions/:sessionId/config', (req, res) => {
    const { llm, ...rest } = globalCtx.config
    const { apiKey, ...safeLlm } = llm
    res.json({ ...rest, llm: safeLlm })
  })
  expressApp.post('/api/sessions/:sessionId/approve', (req, res) => {
    req.presenceSession.session.handleApproveResponse(!!req.body.approved)
    res.json({ ok: true })
  })
  expressApp.post('/api/sessions/:sessionId/cancel', (req, res) => {
    req.presenceSession.session.handleCancel()
    res.json({ ok: true })
  })

  // GET /api/sessions — 세션 목록
  expressApp.get('/api/sessions', (_req, res) => {
    res.json(sessionManager.list().map(({ id, type }) => ({ id, type })))
  })

  // POST /api/sessions — 새 세션 생성
  expressApp.post('/api/sessions', express.json(), (req, res) => {
    const { type = 'user', id } = req.body || {}
    const entry = sessionManager.create({ id, type })
    res.status(201).json({ id: entry.id, type: entry.type })
  })

  // DELETE /api/sessions/:sessionId — 세션 소멸
  expressApp.delete('/api/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params
    if (!sessionManager.get(sessionId)) return res.status(404).json({ error: `Session not found: ${sessionId}` })
    await sessionManager.destroy(sessionId)
    res.json({ ok: true })
  })

  // WebSocket: 연결 시 user-default 초기 상태 전송, join 메시지 처리
  wss.on('connection', (ws, req) => {
    // Origin 검사 — 쿠키 기반 WS 인증 시 CSRF 방지
    // Authorization 헤더가 없으면 브라우저 연결 → Origin 필수 확인
    if (authEnabled && !req.headers.authorization) {
      const origin = req.headers.origin
      if (origin) {
        const expectedHost = `${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`
        const allowed = origin === `http://${expectedHost}` || origin === `https://${expectedHost}`
          || origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`
        if (!allowed) {
          ws.close(4003, 'Origin not allowed')
          return
        }
      }
    }

    // WS 인증: Authorization 헤더 (TUI) 또는 쿠키 (브라우저)
    if (authEnabled) {
      let rejected = false
      Either.fold(
        () => { ws.close(4001, 'Unauthorized'); rejected = true },
        payload => { ws.user = payload },
        authenticateWsR(req).run({ tokenService, userStore }),
      )
      if (rejected) return
    }

    ws.send(JSON.stringify({ type: 'init', session_id: 'user-default', state: defaultSession.state.snapshot() }))

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'join') {
          const entry = sessionManager.get(msg.session_id)
          if (entry) {
            ws.send(JSON.stringify({ type: 'init', session_id: msg.session_id, state: entry.session.state.snapshot() }))
          }
        }
      } catch (_) {}
    })
  })

  // Background tasks
  if (globalCtx.config.scheduler.enabled) {
    globalSchedulerActor.send({ type: 'start' }).fork(() => {}, () => {})
  }
  defaultSession.delegateActor.send({ type: 'start' }).fork(() => {}, () => {})

  // Graceful shutdown
  const shutdown = async () => {
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
    globalSchedulerActor.send({ type: 'stop' }).fork(() => {}, () => {})
    await Promise.all(sessionManager.list().map(({ session }) => session.shutdown().catch(() => {})))
    await globalCtx.shutdown()
    await new Promise(r => wss.close(r))
    await new Promise(r => server.close(r))
  }
  const onSignal = async () => { await shutdown(); process.exit(0) }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  // 정적 파일 (web/ 빌드 결과) — API 라우트 이후 등록해야 GET /api/* 가 먼저 매칭됨
  let hasWebUI = false
  try {
    const { join } = await import('node:path')
    const { existsSync } = await import('node:fs')
    const webDist = join(import.meta.dirname, '../../../web/dist')
    if (existsSync(webDist)) {
      expressApp.use(express.static(webDist))
      expressApp.get('/{*splat}', (_req, res) => res.sendFile(join(webDist, 'index.html')))
      hasWebUI = true
    }
  } catch (_) {}

  await new Promise(resolve => server.listen(port, host, resolve))
  globalCtx.logger.info(`Server listening on http://${host}:${port}`)

  // 터미널 시작 요약
  const { config: cfg, mcpConnections, jobStore } = globalCtx
  const toolCount = defaultSession.tools.length
  const agentCount = globalCtx.agentRegistry.list().length
  const jobCount = jobStore.listJobs().filter(j => j.enabled).length

  console.log(`\nPresence server ready`)
  if (instanceId) console.log(`  Instance   : ${instanceId}`)
  console.log(`  URL        : http://${host}:${port}`)
  console.log(`  WebSocket  : ws://${host}:${port}`)
  console.log(`  Model      : ${cfg.llm.model}`)
  console.log(`  Memory     : ${globalCtx.memoryPath}`)
  console.log(`  Tools      : ${toolCount}`)
  console.log(`  Agents     : ${agentCount}`)
  if (mcpConnections.length > 0) console.log(`  MCP        : ${mcpConnections.length} server(s)`)
  console.log(`  Scheduler  : ${cfg.scheduler.enabled ? `enabled (${jobCount} active jobs)` : 'disabled'}`)
  if (hasWebUI) console.log(`  Web UI     : http://${host}:${port}`)
  console.log(`\n  CLI client : npm run start:cli`)
  console.log(`  Logs       : ~/.presence/logs/agent.log`)
  console.log()

  // app: 하위 호환용 래퍼 (기존 코드가 app.state, app.tools 등에 접근하는 경우)
  const app = {
    state: defaultSession.state,
    tools: defaultSession.tools,
    agents: defaultSession.agents,
    config: globalCtx.config,
    logger: globalCtx.logger,
    personaConfig: globalCtx.personaConfig,
    memory: globalCtx.memory,
    llm: globalCtx.llm,
    mcpControl: globalCtx.mcpControl,
    jobStore: globalCtx.jobStore,
    handleInput: defaultSession.handleInput,
    handleApproveResponse: defaultSession.handleApproveResponse,
    handleCancel: defaultSession.handleCancel,
    schedulerActor: globalSchedulerActor,
    delegateActor: defaultSession.delegateActor,
    shutdown,
  }

  return { server, wss, app, sessionManager, globalCtx, shutdown }
}

// 레거시 브릿지
const createSessionRoutes = (session, globalCtx) => sessionRoutesR.run({ session, globalCtx })
const createSessionBridge = (wss) => sessionBridgeR.run({ wss })

export { startServer, sessionRoutesR, sessionBridgeR, createSessionRoutes, createSessionBridge, handleSlashCommand }

// CLI 실행
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''))) {
  const instanceId = process.env.PRESENCE_INSTANCE_ID
  if (!instanceId) {
    console.error('PRESENCE_INSTANCE_ID environment variable is required.')
    console.error('Usage: PRESENCE_INSTANCE_ID=<id> PORT=<port> node packages/server/src/server/index.js')
    process.exit(1)
  }
  // 사용자 확인 (인증 필수)
  const userStore = createUserStore(instanceId)
  if (!userStore.hasUsers()) {
    console.error(`No users configured for instance '${instanceId}'.`)
    console.error(`Run: npm run user -- init --instance ${instanceId}`)
    process.exit(1)
  }

  const port = Number(process.env.PORT) || 3000
  const host = process.env.HOST || '127.0.0.1'
  const config = loadInstanceConfig(instanceId)
  console.log(`Starting Presence server [${instanceId}] on ${host}:${port}...`)
  startServer(config, { port, host, instanceId }).catch(err => {
    console.error(`\nFailed to start server [${instanceId}]: ${err.message}`)
    if (err.code === 'EADDRINUSE') {
      console.error(`  Port ${port} is already in use. Set a different port with PORT=<n>`)
    } else if (err.code === 'EACCES') {
      console.error(`  Permission denied. Try a port above 1024.`)
    }
    process.exit(1)
  })
}
