import { createServer } from 'node:http'
import express from 'express'
import { WebSocketServer } from 'ws'
import { bootstrap } from '../main.js'

// =============================================================================
// State → WebSocket Bridge
// state.hooks 변경을 연결된 모든 클라이언트에 push
// =============================================================================

const WATCHED_PATHS = [
  'turnState', 'lastTurn', 'turn',
  'context.memories', 'context.conversationHistory',
  '_streaming', '_retry', '_approve',
  '_debug.lastTurn', '_debug.opTrace', '_debug.recalledMemories',
  '_budgetWarning', '_toolResults',
  'todos', 'events', 'events.*', 'delegates', 'delegates.*',
]

const createStateBridge = (state, wss) => {
  const broadcast = (data) => {
    const msg = JSON.stringify(data)
    for (const ws of wss.clients) {
      if (ws.readyState === 1) ws.send(msg)
    }
  }

  for (const path of WATCHED_PATHS) {
    state.hooks.on(path, (value) => {
      broadcast({ type: 'state', path: path.replace('.*', ''), value })
    })
  }

  return { broadcast }
}

// =============================================================================
// Slash commands (App.js에서 UI 의존 없는 것만 추출)
// =============================================================================

const handleSlashCommand = (input, { state, tools, memory }) => {
  if (input === '/clear') {
    state.set('context.conversationHistory', [])
    state.set('_compactionEpoch', (state.get('_compactionEpoch') || 0) + 1)
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
// Express App + REST API
// =============================================================================

const createApp = (app) => {
  const router = express.Router()
  router.use(express.json())

  // POST /api/chat — 사용자 입력 → 에이전트 턴 실행
  router.post('/chat', async (req, res) => {
    const { input } = req.body
    if (!input || typeof input !== 'string') {
      return res.status(400).json({ error: 'input (string) required' })
    }

    // Slash command 처리
    if (input.startsWith('/')) {
      const cmd = handleSlashCommand(input, app)
      if (cmd.handled) return res.json(cmd.result)
    }

    try {
      const result = await app.handleInput(input)
      res.json({ type: 'agent', content: result })
    } catch (err) {
      res.status(500).json({ type: 'error', content: err.message })
    }
  })

  // GET /api/state — 현재 상태 스냅샷
  router.get('/state', (_req, res) => {
    res.json(app.state.snapshot())
  })

  // POST /api/approve — 도구 사용 승인/거부
  router.post('/approve', (req, res) => {
    const { approved } = req.body
    app.handleApproveResponse(!!approved)
    res.json({ ok: true })
  })

  // POST /api/cancel — 현재 턴 취소
  router.post('/cancel', (_req, res) => {
    app.handleCancel()
    res.json({ ok: true })
  })

  // GET /api/tools — 도구 목록
  router.get('/tools', (_req, res) => {
    res.json(app.tools.map(t => ({ name: t.name, description: t.description, source: t.source })))
  })

  // GET /api/agents — 에이전트 목록
  router.get('/agents', (_req, res) => {
    res.json(app.agents)
  })

  // GET /api/config — 설정 (apiKey 제외)
  router.get('/config', (_req, res) => {
    const { llm, ...rest } = app.config
    const { apiKey, ...safeLlm } = llm
    res.json({ ...rest, llm: safeLlm })
  })

  return router
}

// =============================================================================
// Server 시작
// =============================================================================

const startServer = async (configOverride, { port = 3000, host = '127.0.0.1', persistenceCwd } = {}) => {
  const app = await bootstrap(configOverride, { persistenceCwd })

  const expressApp = express()
  expressApp.use('/api', createApp(app))

  // 정적 파일 (web/ 빌드 결과)
  try {
    const { join } = await import('node:path')
    const { existsSync } = await import('node:fs')
    const webDist = join(import.meta.dirname, '../../web/dist')
    if (existsSync(webDist)) {
      expressApp.use(express.static(webDist))
      // SPA fallback
      expressApp.get('*', (_req, res) => res.sendFile(join(webDist, 'index.html')))
    }
  } catch (_) {}

  const server = createServer(expressApp)
  const wss = new WebSocketServer({ server })

  // State → WebSocket bridge
  const bridge = createStateBridge(app.state, wss)

  // WebSocket 연결 시 초기 상태 전송
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'init', state: app.state.snapshot() }))
  })

  // Background tasks
  if (app.config.heartbeat.enabled) app.heartbeat.start()
  app.delegateActor.send({ type: 'start' }).fork(() => {}, () => {})

  // Graceful shutdown
  const shutdown = async () => {
    await app.shutdown()
    wss.close()
    server.close()
  }
  process.on('SIGTERM', async () => { await shutdown(); process.exit(0) })
  process.on('SIGINT', async () => { await shutdown(); process.exit(0) })

  await new Promise(resolve => server.listen(port, host, resolve))
  app.logger.info(`Server listening on http://${host}:${port}`)

  return { server, wss, app, shutdown }
}

export { startServer, createApp, createStateBridge, handleSlashCommand }

// CLI 실행
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''))) {
  const port = Number(process.env.PORT) || 3000
  startServer(undefined, { port }).catch(err => { console.error('Fatal:', err); process.exit(1) })
}
