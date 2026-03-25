import React from 'react'
import { render } from 'ink'
import { createReactiveState } from './infra/state.js'
import { createToolRegistry } from './infra/tools.js'
import { createPersistence, migrateHistoryIds } from './infra/persistence.js'
import { createPersona } from './infra/persona.js'
import { createMemoryGraph, defaultMemoryPath } from './infra/memory.js'
import { createLogger } from './infra/logger.js'
import { LLMClient } from './infra/llm.js'
import { createProdInterpreter } from './interpreter/prod.js'
import { createTracedInterpreter } from './interpreter/traced.js'
import { createAgent, safeRunTurn, PHASE, Phase } from './core/agent.js'
import { PROMPT } from './core/policies.js'
import { createAgentRegistry } from './infra/agent-registry.js'
import { connectMCPServer } from './infra/mcp.js'
import { createEmbedder } from './infra/embedding.js'
import { withEventMeta } from './infra/events.js'
import { createHeartbeat } from './infra/heartbeat.js'
import { loadConfig, validateConfig } from './infra/config.js'
import { createLocalTools } from './infra/local-tools.js'
import { initI18n, t } from './i18n/index.js'
import { charsToTokens } from './lib/tokenizer.js'
import { App } from './ui/App.js'
import {
  createMemoryActor, createCompactionActor, createPersistenceActor,
  createTurnActor, applyCompaction, forkTask,
  createEventActor, createEmit, createBudgetActor, createDelegateActor,
} from './infra/actors.js'

const h = React.createElement

// config.prompt → budget 변환 (chars 하위 호환)
const resolveBudget = (prompt) => {
  const maxContextTokens = prompt.maxContextTokens
    || (prompt.maxContextChars ? charsToTokens(prompt.maxContextChars) : PROMPT.DEFAULT_MAX_CONTEXT_TOKENS)
  const reservedOutputTokens = prompt.reservedOutputTokens
    || (prompt.reservedOutputChars ? charsToTokens(prompt.reservedOutputChars) : PROMPT.DEFAULT_RESERVED_OUTPUT_TOKENS)
  return { maxContextChars: maxContextTokens, reservedOutputChars: reservedOutputTokens }
}

// =============================================================================
// Bootstrap: config → infra → agent 조립. TTY/UI 의존 없음.
// e2e 테스트에서 직접 사용 가능: const app = await bootstrap(config)
// =============================================================================

const bootstrap = async (configOverride, { persistenceCwd } = {}) => {
  const config = configOverride || loadConfig()
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
    context: { memories: [], conversationHistory: [] },
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
  const embedEnabled = embedApiKey || config.embed.baseUrl
  const embedder = embedEnabled
    ? createEmbedder({
        provider: config.embed.provider,
        baseUrl: config.embed.baseUrl,
        apiKey: embedApiKey,
        model: config.embed.model,
        dimensions: config.embed.dimensions,
      })
    : null

  // --- Persistence (restore + connect) ---
  const persistence = createPersistence(persistenceCwd ? { cwd: persistenceCwd } : {})
  const restored = persistence.restore()
  if (restored && typeof restored === 'object') {
    try {
      if (typeof restored.turn === 'number') state.set('turn', restored.turn)
      if (restored.context && typeof restored.context === 'object') state.set('context', restored.context)
      if (Array.isArray(restored.todos)) state.set('todos', restored.todos)
      if (Array.isArray(restored.context?.conversationHistory)) {
        const migrated = migrateHistoryIds(restored.context.conversationHistory)
        state.set('context.conversationHistory', migrated)
        state.set('_compactionEpoch', (state.get('_compactionEpoch') || 0) + 1)
      }
      logger.info(`State restored (turn: ${restored.turn || 0})`)
    } catch (e) {
      logger.warn('State restore failed, starting fresh', { error: e.message })
    }
  }

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
    timeoutMs: config.llm.timeoutMs,
  })

  // --- Approve channel ---
  let _approveResolve = null
  let _interactive = false

  const onApprove = async (description) => {
    if (!_interactive) {
      logger.warn(t('error.approve_rejected_bg'), { description })
      return false
    }
    return new Promise(resolve => {
      _approveResolve = resolve
      state.set('_approve', { description })
    })
  }

  const handleApproveResponse = (approved) => {
    if (_approveResolve) {
      _approveResolve(approved)
      _approveResolve = null
      state.set('_approve', null)
    }
  }

  // --- Abort ---
  let _turnAbort = null

  const getAbortSignal = () => _turnAbort?.signal

  const handleCancel = () => {
    if (_turnAbort && !_turnAbort.signal.aborted) {
      _turnAbort.abort()
      logger.info('Turn cancelled by user')
    }
  }

  const prodInterpreter = createProdInterpreter({ llm, toolRegistry, reactiveState: state, agentRegistry, onApprove, getAbortSignal })
  const { interpret: tracedInterpret, ST, trace } = createTracedInterpreter(prodInterpreter, {
    logger,
    onOp: (event, _entry) => {
      if (event !== 'start') {
        state.set('_debug.opTrace', trace.map(e => ({ ...e })))
      }
    },
  })

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

  // --- Actors ---
  const memoryActor = createMemoryActor({ graph: memory, embedder, logger })
  const compactionActor = createCompactionActor({ llm, logger })
  const persistenceActor = createPersistenceActor({ store: persistence.store })

  compactionActor.subscribe((result) => {
    if (result === 'skip') return
    const { summary, extractedIds, epoch } = result
    const currentEpoch = state.get('_compactionEpoch') || 0
    if (epoch !== undefined && epoch !== currentEpoch) {
      logger.info('Compaction result discarded (epoch mismatch)')
      return
    }
    applyCompaction(state, { summary, extractedIds })
  })

  // --- Agent ---
  const tools = persona.filterTools(toolRegistry.list())
  const agents = agentRegistry.list()
  const responseFormatMode = config.llm.responseFormat

  const execute = safeRunTurn({ interpret: tracedInterpret, ST }, state, {
    memoryActor, compactionActor, persistenceActor, logger,
  })
  const agent = createAgent({
    tools, agents, persona: personaConfig,
    responseFormatMode,
    maxRetries: config.llm.maxRetries,
    maxIterations: config.maxIterations,
    interpret: tracedInterpret, ST,
    state,
    budget: resolveBudget(config.prompt),
    execute,
  })

  // --- TurnActor: 모든 턴 요청 직렬화 ---
  const turnActor = createTurnActor((input, opts) => agent.run(input, opts))

  // --- Actors (비동기 비즈니스 로직 통합) ---
  const eventActor = createEventActor({ turnActor, state, logger })
  const budgetActor = createBudgetActor({ state })
  const delegateActor = createDelegateActor({
    state, eventActor, agentRegistry, logger,
    pollIntervalMs: config.delegatePolling.intervalMs,
  })

  // --- emit (EventActor 경유) ---
  const emit = createEmit(eventActor)

  // --- 브릿지 Hook (로직 없음) ---
  state.hooks.on('turnState', (phase) => {
    if (phase.tag === 'idle') {
      eventActor.send({ type: 'drain' }).fork(() => {}, () => {})
      delegateActor.send({ type: 'poll' }).fork(() => {}, () => {})
    }
    if (phase.tag === PHASE.WORKING) {
      trace.length = 0
      state.set('_debug.opTrace', [])
    }
  })
  state.hooks.on('_debug.lastTurn', (debug, s) => {
    budgetActor.send({ type: 'check', debug, turn: s.get('turn') }).fork(() => {}, () => {})
  })

  const heartbeat = createHeartbeat({
    eventActor, state,
    intervalMs: config.heartbeat.intervalMs,
    prompt: config.heartbeat.prompt,
    onError: (e) => logger.warn('Heartbeat emit failed', { error: e.message }),
  })

  // --- Controller: Input handler (TurnActor 경유) ---
  const handleInput = async (input) => {
    _interactive = true
    _turnAbort = new AbortController()
    try {
      const result = await forkTask(turnActor.send({ input, source: 'user' }))
      if (result?._turnError) throw new Error(result.message)
      return result
    } catch (err) {
      logger.error('Turn failed', { error: err.message })
      throw err
    } finally {
      _turnAbort = null
      _interactive = false
      if (_approveResolve) {
        _approveResolve(false)
        _approveResolve = null
        state.set('_approve', null)
      }
    }
  }

  // --- Startup summary ---
  logger.info('Startup complete', {
    model: config.llm.model,
    responseFormat: config.llm.responseFormat,
    maxRetries: config.llm.maxRetries,
    maxIterations: config.maxIterations,
    timeoutMs: config.llm.timeoutMs,
    tools: tools.length,
    agents: agents.length,
    mcpServers: mcpConnections.length,
    embedder: embedder ? config.embed.provider : 'none',
    heartbeat: config.heartbeat.enabled,
    memory: memory.allNodes().length + ' nodes',
  })

  // --- Shutdown ---
  const shutdown = async () => {
    heartbeat.stop()
    delegateActor.send({ type: 'stop' }).fork(() => {}, () => {})
    try {
      await forkTask(persistenceActor.send({ type: 'flush', snapshot: state.snapshot() }))
    } catch (_) {}
    for (const conn of mcpConnections) {
      try { await conn.close() } catch (_) {}
    }
  }

  return {
    agent, state, config, logger,
    tools, agents, personaConfig,
    handleInput, handleApproveResponse, handleCancel,
    heartbeat, delegateActor,
    memory, llm,
    shutdown,
  }
}

// =============================================================================
// View: Ink 렌더링. TTY 필요.
// =============================================================================

const main = async () => {
  const app = await bootstrap()

  process.on('SIGTERM', async () => { await app.shutdown().catch(() => {}); process.exit(0) })
  process.on('SIGINT', async () => { await app.shutdown().catch(() => {}); process.exit(0) })

  const cwd = process.cwd()
  let gitBranch = ''
  try {
    const { execSync } = await import('child_process')
    gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
  } catch (_) {}

  const { waitUntilExit } = render(
    h(App, {
      state: app.state,
      onInput: app.handleInput,
      onApprove: app.handleApproveResponse,
      onCancel: app.handleCancel,
      agentName: app.personaConfig.name,
      tools: app.tools,
      agents: app.agents,
      cwd,
      gitBranch,
      model: app.config.llm.model,
      config: app.config,
      memory: app.memory,
      llm: app.llm,
      initialMessages: [],
    })
  )

  if (app.config.heartbeat.enabled) app.heartbeat.start()
  app.delegateActor.send({ type: 'start' }).fork(() => {}, () => {})

  await waitUntilExit()
  await app.shutdown()
}

export { main, bootstrap }

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''))) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1) })
}
