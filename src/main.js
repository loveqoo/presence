import { createReactiveState } from './infra/state.js'
import { createToolRegistry } from './infra/tools.js'
import { createPersistence } from './infra/persistence.js'
import { createPersona } from './infra/persona.js'
import { createMemoryGraph, TIERS, defaultMemoryPath } from './infra/memory.js'
import { createLogger } from './infra/logger.js'
import { LLMClient } from './infra/llm.js'
import { createProdInterpreter } from './interpreter/prod.js'
import { createTracedInterpreter } from './interpreter/traced.js'
import { createAgent, PHASE, RESULT, Phase } from './core/agent.js'
import { createReactTurn } from './core/react.js'
import { createAgentRegistry } from './infra/agent-registry.js'
import { connectMCPServer } from './infra/mcp.js'
import { createEmbedder } from './infra/embedding.js'
import { createEventReceiver, wireEventHooks, wireTodoHooks } from './infra/events.js'
import { wireDelegatePolling } from './infra/a2a-client.js'
import { createHeartbeat } from './infra/heartbeat.js'
import { loadConfig, validateConfig } from './infra/config.js'
import { createLocalTools } from './infra/local-tools.js'
import { initI18n, t } from './i18n/index.js'
import { createRepl } from './core/repl.js'

// --- Hook 조립 함수 ---

const wireMemoryHooks = ({ state, memory, embedder, logger }) => {
  state.hooks.on('turnState', async (phase, s) => {
    if (phase.tag === PHASE.WORKING && phase.input) {
      try {
        const memories = await memory.recall(phase.input, { embedder, logger })
        s.set('context.memories', memories.map(n => n.label))
        s.set('turn', (s.get('turn') || 0) + 1)
      } catch (e) {
        if (logger) logger.warn('Memory recall failed', { error: e.message })
      }
    }
  })

  state.hooks.on('turnState', async (phase, s) => {
    if (phase.tag !== PHASE.IDLE) return
    memory.removeNodesByTier(TIERS.WORKING)
    const lastTurn = s.get('lastTurn')
    if (lastTurn && lastTurn.tag === RESULT.SUCCESS) {
      memory.addNode({
        label: lastTurn.input || 'unknown',
        type: 'conversation',
        tier: TIERS.EPISODIC,
        data: { input: lastTurn.input, output: lastTurn.result },
      })
    }
    try {
      await memory.save()
      await memory.embedPending(embedder, { logger })
    } catch (e) {
      if (logger) logger.warn('Memory save/embed failed', { error: e.message })
    }
  })
}

// --- Main ---

const main = async () => {
  const config = loadConfig()
  initI18n(config.locale)
  const { logger } = createLogger()

  // --- Startup validation ---
  const warnings = validateConfig(config)
  for (const w of warnings) logger.warn(`[config] ${w}`)

  const persona = createPersona()
  const personaConfig = persona.get()

  // --- State ---
  const state = createReactiveState({
    turnState: Phase.idle(),
    lastTurn: null,
    turn: 0,
    context: { memories: [] },
    events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    delegates: { pending: [] },
    todos: [],
  })

  // --- Memory ---
  const memoryPath = config.memory.path || defaultMemoryPath()
  const memory = await createMemoryGraph(memoryPath)
  logger.info(t('startup.memory_loaded', { path: memoryPath, count: memory.allNodes().length }))

  // --- Embedder ---
  const embedApiKey = config.embed.apiKey
    || (config.embed.provider === 'openai' ? config.llm.apiKey : null)
  const embedder = embedApiKey
    ? createEmbedder({
        provider: config.embed.provider,
        apiKey: embedApiKey,
        model: config.embed.model,
        dimensions: config.embed.dimensions,
      })
    : null

  // --- Persistence (restore + connect) ---
  const persistence = createPersistence()
  const restored = persistence.restore()
  if (restored && typeof restored === 'object') {
    try {
      if (typeof restored.turn === 'number') state.set('turn', restored.turn)
      if (restored.context && typeof restored.context === 'object') state.set('context', restored.context)
      if (Array.isArray(restored.todos)) state.set('todos', restored.todos)
      logger.info(`State restored (turn: ${restored.turn || 0})`)
    } catch (e) {
      logger.warn('State restore failed, starting fresh', { error: e.message })
    }
  }
  persistence.connectToState(state)

  // --- Tools ---
  const toolRegistry = createToolRegistry()
  const localTools = createLocalTools({
    allowedDirs: config.tools?.allowedDirs || [process.cwd()],
  })
  for (const tool of localTools) toolRegistry.register(tool)

  // --- MCP ---
  const mcpConnections = []
  for (const server of config.mcp) {
    if (!server.enabled) continue
    try {
      const conn = await connectMCPServer(server)
      for (const tool of conn.tools) toolRegistry.register(tool)
      mcpConnections.push(conn)
      logger.info(`MCP connected: ${server.serverName} (${conn.tools.length} tools)`)
    } catch (e) {
      logger.warn(`MCP 연결 실패: ${server.serverName}`, { error: e.message })
    }
  }

  // --- Agent Registry ---
  const agentRegistry = createAgentRegistry()

  // --- LLM + Interpreter ---
  const llm = new LLMClient({
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    apiKey: config.llm.apiKey,
  })

  // Approve: REPL 턴에서만 interactive, 백그라운드(heartbeat/event)에서는 자동 거부.
  let _rl = null
  let _interactive = false
  const onApprove = async (description) => {
    if (!_interactive || !_rl) {
      logger.warn(t('error.approve_rejected_bg'), { description })
      return false
    }
    return new Promise(resolve => {
      _rl.question(t('approve.prompt', { description }), (answer) => {
        resolve(answer.trim().toLowerCase() === 'y')
      })
    })
  }

  const prodInterpreter = createProdInterpreter({ llm, toolRegistry, state, agentRegistry, onApprove })
  const { interpreter } = createTracedInterpreter(prodInterpreter, { logger })

  // --- Local sub-agents ---
  agentRegistry.register({
    name: 'summarizer',
    description: '텍스트 요약 에이전트. 긴 내용을 간결하게 정리할 때 위임하세요.',
    capabilities: ['summarize'],
    type: 'local',
    run: async (task) => {
      const result = await llm.chat({
        messages: [
          { role: 'system', content: '주어진 내용을 간결하게 요약하세요. 핵심만 남기세요.' },
          { role: 'user', content: task },
        ],
      })
      return result.content
    },
  })

  // --- Agent ---
  const tools = persona.filterTools(toolRegistry.list())
  const agents = agentRegistry.list()
  const responseFormatMode = config.llm.responseFormat
  const buildTurn = config.strategy === 'react'
    ? createReactTurn({ tools, maxSteps: 10 })
    : undefined

  const agent = createAgent({
    buildTurn, tools, agents, persona: personaConfig,
    responseFormatMode,
    maxRetries: config.llm.maxRetries,
    interpreter, state,
  })

  // --- Events ---
  const { emit } = createEventReceiver(state)

  // --- Hooks 조립 ---
  state.hooks.on('_retry', (info) => {
    console.log(t('status.retry_notice', { attempt: info.attempt, max: info.maxRetries }))
  })
  wireMemoryHooks({ state, memory, embedder, logger })
  wireEventHooks({ state, agent, logger })
  wireTodoHooks({ state, logger })
  const delegatePoller = wireDelegatePolling({
    state, emit, agentRegistry, logger,
    pollIntervalMs: config.delegatePolling.intervalMs,
  })
  const heartbeat = createHeartbeat({
    emit, state,
    intervalMs: config.heartbeat.intervalMs,
    prompt: config.heartbeat.prompt,
    onError: (e) => logger.warn('Heartbeat emit failed', { error: e.message }),
  })

  // --- REPL ---
  const repl = createRepl({
    agent, state, toolRegistry, agentRegistry, memory,
    onOutput: (result) => console.log(`\nAgent: ${result}\n`),
    onError: (err) => {
      logger.error('Turn failed', { error: err.message })
      console.error(`\nError: ${err.message}\n`)
    },
  })
  const replHandleInput = repl.handleInput
  repl.handleInput = async (input) => {
    _interactive = true
    try { return await replHandleInput(input) }
    finally { _interactive = false }
  }

  // --- Readline ---
  const { createInterface } = await import('readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  _rl = rl
  // --- Startup summary ---
  logger.info('Startup complete', {
    model: config.llm.model,
    responseFormat: config.llm.responseFormat,
    strategy: config.strategy,
    tools: tools.length,
    agents: agents.length,
    mcpServers: mcpConnections.length,
    embedder: embedder ? config.embed.provider : 'none',
    heartbeat: config.heartbeat.enabled,
    memory: memory.allNodes().length + ' nodes',
  })
  console.log(t('startup.ready', { name: personaConfig.name }) + '\n')

  // --- Shutdown ---
  const shutdown = async () => {
    heartbeat.stop()
    delegatePoller.stop()
    for (const conn of mcpConnections) {
      try { await conn.close() } catch (_) {}
    }
    rl.close()
  }
  process.on('SIGINT', async () => { await shutdown().catch(() => {}); process.exit(0) })
  process.on('SIGTERM', async () => { await shutdown().catch(() => {}); process.exit(0) })

  // --- Start ---
  if (config.heartbeat.enabled) heartbeat.start()
  delegatePoller.start()

  const prompt = async () => {
    if (!repl.running) { await shutdown().catch(() => {}); return }
    rl.question('> ', async (input) => {
      if (!input.trim()) { prompt(); return }
      await repl.handleInput(input.trim())
      prompt()
    })
  }
  prompt()
}

export { main, wireMemoryHooks }

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''))) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1) })
}
