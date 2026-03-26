import React from 'react'
import { render } from 'ink'
import { createReactiveState } from './infra/state.js'
import { createToolRegistry } from './infra/tools.js'
import { createPersistence, migrateHistoryIds } from './infra/persistence.js'
import { createPersona } from './infra/persona.js'
import { defaultMemoryPath } from './infra/memory.js'
import { createMem0Memory } from './infra/mem0-memory.js'
import { createLogger } from './infra/logger.js'
import { LLMClient } from './infra/llm.js'
import { createProdInterpreter } from './interpreter/prod.js'
import { createTracedInterpreter } from './interpreter/traced.js'
import { createAgent, createAgentTurn, safeRunTurn, PHASE, Phase } from './core/agent.js'
import { PROMPT, SYSTEM_JOBS } from './core/policies.js'
import { createAgentRegistry } from './infra/agent-registry.js'
import { connectMCPServer } from './infra/mcp.js'
import { createEmbedder } from './infra/embedding.js'
import { createJobStore, defaultJobDbPath } from './infra/job-store.js'
import { createSchedulerActor, calcNextRun } from './infra/scheduler-actor.js'
import { createJobTools } from './infra/job-tools.js'
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
import { formatTodosAsLines } from './infra/events.js'

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
  const mem0Result = await createMem0Memory(config, { memoryPath }).catch(e => {
    logger.warn('mem0 init failed, memory disabled', { error: e.message })
    return null
  })
  const mem0 = mem0Result?.mem0 || null
  const memory = mem0Result?.adapter || null
  logger.info(t('startup.memory_loaded', { path: memoryPath, count: memory?.allNodes().length ?? 0 }))

  // --- Embedder (LLM용 recall 문맥 구성에 필요, mem0와 별도) ---
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
      if (Array.isArray(restored.todos)) state.set('todos', restored.todos)
      if (restored.context && typeof restored.context === 'object') {
        // migrateHistoryIds handles non-array input → always apply
        const migrated = migrateHistoryIds(restored.context.conversationHistory)
        state.set('context', { ...restored.context, conversationHistory: migrated })
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
  // MCP 툴은 프롬프트에 직접 노출하지 않음.
  // mcp_search_tools / mcp_call_tool 메타 툴 2개만 등록 → 프롬프트 컨텍스트 절약.
  const mcpConnections = []
  const allMcpTools = []       // 전체 툴 (prefix 포함)
  const mcpServers = []         // { prefix, serverName, toolCount }
  const enabledPrefixes = new Set()  // 런타임 enable/disable
  let mcpIdx = 0
  for (const server of config.mcp) {
    if (!server.enabled) continue
    try {
      const conn = await connectMCPServer(server)
      const prefix = `mcp${mcpIdx++}`
      for (const tool of conn.tools) {
        allMcpTools.push({ ...tool, name: `${prefix}__${tool.name}` })
      }
      mcpServers.push({ prefix, serverName: server.serverName, toolCount: conn.tools.length })
      enabledPrefixes.add(prefix)
      mcpConnections.push(conn)
      logger.info(`MCP connected: ${server.serverName} (${conn.tools.length} tools)`)
    } catch (e) {
      logger.warn(`MCP 연결 실패: ${server.serverName}`, { error: e.message })
    }
  }

  if (allMcpTools.length > 0) {
    const mcpToolIndex = new Map(allMcpTools.map(t => [t.name, t]))
    const getPrefix = (name) => name.split('__')[0]
    const visibleTools = () => allMcpTools.filter(t => enabledPrefixes.has(getPrefix(t.name)))

    toolRegistry.register({
      name: 'mcp_search_tools',
      description: 'Search available MCP tools by keyword. Returns matching tool names and descriptions. Use this before mcp_call_tool to find the right tool.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search term (e.g. "calendar", "github issue", "slack"). Omit to list all available tools.' } },
      },
      handler: ({ query }) => {
        const tools = visibleTools()
        if (!query) return `${tools.length} MCP tools available. Provide a query to search.`
        const q = query.toLowerCase()
        const matches = tools.filter(t =>
          t.name.toLowerCase().includes(q) ||
          (t.description || '').toLowerCase().includes(q)
        )
        if (matches.length === 0) return `No MCP tools found matching: "${query}"`
        return matches.map(t => `${t.name}: ${t.description || '(no description)'}`).join('\n')
      },
    })

    toolRegistry.register({
      name: 'mcp_call_tool',
      description: 'Call a specific MCP tool by its exact name. Use mcp_search_tools first to find the tool name and understand its parameters.',
      parameters: {
        type: 'object',
        properties: {
          tool_name: { type: 'string', description: 'Exact tool name from mcp_search_tools result' },
          tool_args: { type: 'object', description: 'Arguments for the tool (check tool description for required fields)' },
        },
        required: ['tool_name'],
      },
      handler: async ({ tool_name, tool_args = {} }) => {
        const tool = mcpToolIndex.get(tool_name)
        if (!tool) throw new Error(`MCP tool not found: "${tool_name}". Use mcp_search_tools to find available tools.`)
        if (!enabledPrefixes.has(getPrefix(tool_name))) throw new Error(`MCP server disabled: "${getPrefix(tool_name)}". Use /mcp enable to re-enable.`)
        return await tool.handler(tool_args)
      },
    })
  }

  // MCP 런타임 enable/disable 컨트롤
  const mcpControl = {
    list: () => mcpServers.map(s => ({ ...s, enabled: enabledPrefixes.has(s.prefix) })),
    enable:  (prefix) => { const ok = mcpServers.some(s => s.prefix === prefix); if (ok) enabledPrefixes.add(prefix);    return ok },
    disable: (prefix) => { const ok = mcpServers.some(s => s.prefix === prefix); if (ok) enabledPrefixes.delete(prefix); return ok },
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
  const memoryActor = createMemoryActor({ mem0, adapter: memory, logger })
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
  const turnActor = createTurnActor((input, opts) => {
    const { allowedTools = [] } = opts || {}
    if (allowedTools.length === 0) return agent.run(input, opts)

    const effectiveTools = tools.filter(t =>
      allowedTools.some(p => { try { return new RegExp(p).test(t.name) } catch (_) { return false } })
    )
    if (effectiveTools.length === tools.length) return agent.run(input, opts)

    const filteredTurn = createAgentTurn({
      tools: effectiveTools, agents, persona: personaConfig,
      responseFormatMode,
      maxRetries: config.llm.maxRetries,
      maxIterations: config.maxIterations,
      budget: resolveBudget(config.prompt),
    })
    return execute(filteredTurn(input, opts), input)
  })

  // --- Job Store ---
  const jobStore = createJobStore(defaultJobDbPath(memoryPath))

  // --- Actors (비동기 비즈니스 로직 통합) ---
  // schedulerActor는 eventActor 이후 생성되므로 forward reference 패턴
  let schedulerActor
  const eventActor = createEventActor({
    turnActor, state, logger,
    todoReviewJobName: SYSTEM_JOBS.TODO_REVIEW,
    onEventDone: (event, { success, result, error }) => {
      if (event.type !== 'scheduled_job' || !schedulerActor) return
      if (success) {
        schedulerActor.send({ type: 'job_done', runId: event.runId, jobId: event.jobId, result }).fork(() => {}, () => {})
      } else {
        schedulerActor.send({
          type: 'job_fail', runId: event.runId, jobId: event.jobId,
          attempt: event.attempt ?? 1, error,
        }).fork(() => {}, () => {})
      }
    },
  })
  const budgetActor = createBudgetActor({ state })
  const delegateActor = createDelegateActor({
    state, eventActor, agentRegistry, logger,
    pollIntervalMs: config.delegatePolling.intervalMs,
  })
  schedulerActor = createSchedulerActor({
    store: jobStore, eventActor, logger,
    pollIntervalMs: config.scheduler.pollIntervalMs,
  })

  // --- Job 툴 등록 ---
  const jobTools = createJobTools({ store: jobStore, eventActor })
  for (const tool of jobTools) toolRegistry.register(tool)

  // --- read_todos 툴 ---
  toolRegistry.register({
    name: 'read_todos',
    description: '현재 대기 중인 TODO 항목 목록을 반환합니다.',
    parameters: { type: 'object', properties: {} },
    handler: () => {
      const todos = (state.get('todos') || []).filter(t => !t.done)
      if (todos.length === 0) return '대기 중인 TODO 항목이 없습니다.'
      return formatTodosAsLines(todos).join('\n')
    },
  })

  // --- Todo Review 시스템 Job ---
  if (config.scheduler.todoReview.enabled) {
    const exists = jobStore.listJobs().find(j => j.name === SYSTEM_JOBS.TODO_REVIEW)
    if (!exists) {
      const cron = config.scheduler.todoReview.cron
      jobStore.createJob({
        name: SYSTEM_JOBS.TODO_REVIEW,
        prompt: SYSTEM_JOBS.TODO_REVIEW,  // EventActor drain에서 감지 후 동적 프롬프트로 교체
        cron,
        maxRetries: 1,
        nextRun: calcNextRun(cron),
      })
    }
  }

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
    scheduler: config.scheduler.enabled ? `enabled (poll: ${config.scheduler.pollIntervalMs}ms)` : 'disabled',
    scheduledJobs: jobStore.listJobs().filter(j => j.enabled).length,
    memory: mem0 ? `mem0 (${memory?.allNodes().length ?? 0} cached)` : 'disabled',
  })

  // --- Shutdown ---
  const shutdown = async () => {
    schedulerActor.send({ type: 'stop' }).fork(() => {}, () => {})
    delegateActor.send({ type: 'stop' }).fork(() => {}, () => {})
    try {
      await forkTask(persistenceActor.send({ type: 'flush', snapshot: state.snapshot() }))
    } catch (_) {}
    jobStore.close()
    for (const conn of mcpConnections) {
      try { await conn.close() } catch (_) {}
    }
  }

  return {
    agent, state, config, logger,
    tools, agents, personaConfig,
    handleInput, handleApproveResponse, handleCancel,
    schedulerActor, delegateActor, jobStore,
    memory, llm, mcpControl,
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
      mcpControl: app.mcpControl,
      initialMessages: [],
    })
  )

  if (app.config.scheduler.enabled) app.schedulerActor.send({ type: 'start' }).fork(() => {}, () => {})
  app.delegateActor.send({ type: 'start' }).fork(() => {}, () => {})

  await waitUntilExit()
  await app.shutdown()
}

export { main, bootstrap }

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''))) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1) })
}
