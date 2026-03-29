import { createReactiveState } from './state.js'
import { createToolRegistry } from './tools.js'
import { createPersistence, migrateHistoryIds } from './persistence.js'
import { createTracedInterpreter } from '@presence/core/interpreter/traced.js'
import { createProdInterpreter } from '../interpreter/prod.js'
import { createAgent, createAgentTurn, safeRunTurn, PHASE, Phase } from '@presence/core/core/agent.js'
import { PROMPT, SYSTEM_JOBS, SESSION_TYPE } from '@presence/core/core/policies.js'
import { createJobTools } from './job-tools.js'
import { createSchedulerActor, calcNextRun } from './scheduler-actor.js'
import { charsToTokens } from '@presence/core/lib/tokenizer.js'
import {
  memoryActorR, compactionActorR, persistenceActorR,
  turnActorR, eventActorR, emitR, budgetActorR, delegateActorR,
  applyCompaction, forkTask,
} from './actors.js'
import { formatTodosAsLines } from './events.js'
import { t } from '../i18n/index.js'
// t는 createAgent/createAgentTurn에 주입됨

/**
 * Converts prompt config to token budget, with backward-compatible chars fallback.
 * @param {{ maxContextTokens?: number, maxContextChars?: number, reservedOutputTokens?: number, reservedOutputChars?: number }} prompt
 * @returns {{ maxContextChars: number, reservedOutputChars: number }}
 */
const resolveBudget = (prompt) => {
  const maxContextTokens = prompt.maxContextTokens
    || (prompt.maxContextChars ? charsToTokens(prompt.maxContextChars) : PROMPT.DEFAULT_MAX_CONTEXT_TOKENS)
  const reservedOutputTokens = prompt.reservedOutputTokens
    || (prompt.reservedOutputChars ? charsToTokens(prompt.reservedOutputChars) : PROMPT.DEFAULT_RESERVED_OUTPUT_TOKENS)
  return { maxContextChars: maxContextTokens, reservedOutputChars: reservedOutputTokens }
}

// =============================================================================
// Session: globalCtx → 세션별 인프라 조립.
// ReactiveState, Actors, Agent 등 대화 세션마다 격리되는 자원.
// Phase B에서 SessionManager가 이 함수를 직접 호출.
// NOTE: jobTools / read_todos는 현재 globalCtx.toolRegistry에 등록됨.
//       Phase B 멀티 세션에서는 세션별 toolRegistry 사본으로 교체 필요.
// =============================================================================

/**
 * Creates a session with isolated state, actors, and agent wired from the shared global context.
 * @param {object} globalCtx - Shared infrastructure from createGlobalContext().
 * @param {{ persistenceCwd?: string, type?: string, onScheduledJobDone?: Function, idleTimeoutMs?: number, onIdle?: Function }} [options]
 * @returns {{ agent, state, tools, agents, handleInput, handleApproveResponse, handleCancel, schedulerActor, delegateActor, eventActor, emit, shutdown }}
 */

const createSession = (globalCtx, { persistenceCwd, type = SESSION_TYPE.USER, onScheduledJobDone, idleTimeoutMs, onIdle } = {}) => {
  const {
    config, logger, persona, personaConfig,
    mem0, memory,
    toolRegistry, agentRegistry, llm, jobStore,
  } = globalCtx

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

  // --- Persistence (restore + connect) ---
  // ephemeral 세션(scheduled) 및 서브 에이전트 세션(agent)은 restore/flush 없음
  const isEphemeral = type === SESSION_TYPE.SCHEDULED || type === SESSION_TYPE.AGENT
  const persistence = isEphemeral ? null : createPersistence(persistenceCwd ? { cwd: persistenceCwd } : {})
  if (!isEphemeral) {
    const restored = persistence.restore()
    if (restored && typeof restored === 'object') {
      try {
        if (typeof restored.turn === 'number') state.set('turn', restored.turn)
        if (Array.isArray(restored.todos)) state.set('todos', restored.todos)
        if (restored.context && typeof restored.context === 'object') {
          const migrated = migrateHistoryIds(restored.context.conversationHistory)
          state.set('context', { ...restored.context, conversationHistory: migrated })
          state.set('_compactionEpoch', (state.get('_compactionEpoch') || 0) + 1)
        }
        logger.info(`State restored (turn: ${restored.turn || 0})`)
      } catch (e) {
        logger.warn('State restore failed, starting fresh', { error: e.message })
      }
    }
  }

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

  // --- Session-local tool registry ---
  // 글로벌 registry(MCP 툴 등)를 복사. job/todo 툴은 이 세션 전용 registry에만 등록.
  // 이렇게 하면: (1) USER 세션은 자신의 job 툴을 즉시 볼 수 있고,
  //             (2) AGENT 세션은 job 툴을 물려받지 않으며,
  //             (3) 글로벌 registry가 오염되지 않는다.
  const sessionToolRegistry = createToolRegistry()
  for (const tool of toolRegistry.list()) sessionToolRegistry.register(tool)

  // --- Interpreter ---
  const prodInterpreter = createProdInterpreter({ llm, toolRegistry: sessionToolRegistry, reactiveState: state, agentRegistry, onApprove, getAbortSignal })
  const { interpret: tracedInterpret, ST, getTrace, resetTrace } = createTracedInterpreter(prodInterpreter, {
    logger,
    onOp: (event, _entry) => {
      if (event !== 'start') {
        state.set('_debug.opTrace', getTrace())
      }
    },
  })

  // --- Actors (Reader.run) ---
  const sessionEnv = { mem0, adapter: memory, logger, llm, state }
  const memoryActor = memoryActorR.run(sessionEnv)
  const compactionActor = compactionActorR.run(sessionEnv)
  const persistenceActor = isEphemeral
    ? { send: () => ({ fork: (_e, r) => r('skip') }) }
    : persistenceActorR.run({ store: persistence.store })

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
  // getTools/getAgents는 매 턴마다 현재 registry를 읽음.
  // 이렇게 하면 세션 생성 이후 등록된 툴(job 툴 등)도 바로 반영된다.
  const getTools = () => persona.filterTools(sessionToolRegistry.list())
  const getAgents = () => agentRegistry.list()
  const responseFormatMode = config.llm.responseFormat

  const execute = safeRunTurn({ interpret: tracedInterpret, ST }, state, {
    memoryActor, compactionActor, persistenceActor, logger,
  })
  const agent = createAgent({
    getTools, getAgents, persona: personaConfig,
    responseFormatMode,
    maxRetries: config.llm.maxRetries,
    maxIterations: config.maxIterations,
    interpret: tracedInterpret, ST,
    state,
    budget: resolveBudget(config.prompt),
    execute,
    t,
  })

  // --- TurnActor: 모든 턴 요청 직렬화 (Reader.run) ---
  const turnActor = turnActorR.run({ runTurn: (input, opts) => {
    const { allowedTools = [] } = opts || {}
    if (allowedTools.length === 0) return agent.run(input, opts)

    const currentTools = getTools()
    const effectiveTools = currentTools.filter(t =>
      allowedTools.some(p => { try { return new RegExp(p).test(t.name) } catch (_) { return false } })
    )
    if (effectiveTools.length === currentTools.length) return agent.run(input, opts)

    const filteredTurn = createAgentTurn({
      tools: effectiveTools, getAgents, persona: personaConfig,
      responseFormatMode,
      maxRetries: config.llm.maxRetries,
      maxIterations: config.maxIterations,
      budget: resolveBudget(config.prompt),
      t,
    })
    return execute(filteredTurn(input, opts), input)
  } })

  // --- Actors (비동기 비즈니스 로직 통합) ---
  let schedulerActor
  const eventActor = eventActorR.run({
    turnActor, state, logger,
    todoReviewJobName: SYSTEM_JOBS.TODO_REVIEW,
    onEventDone: (event, { success, result, error }) => {
      if (event.type !== 'scheduled_job') return
      if (onScheduledJobDone) {
        onScheduledJobDone(event, { success, result, error })
      } else if (schedulerActor) {
        if (success) {
          schedulerActor.send({ type: 'job_done', runId: event.runId, jobId: event.jobId, result }).fork(() => {}, () => {})
        } else {
          schedulerActor.send({
            type: 'job_fail', runId: event.runId, jobId: event.jobId,
            attempt: event.attempt ?? 1, error,
          }).fork(() => {}, () => {})
        }
      }
    },
  })
  const budgetActor = budgetActorR.run({ state })
  const delegateActor = delegateActorR.run({
    state, eventActor, agentRegistry, logger,
    pollIntervalMs: config.delegatePolling.intervalMs,
  })
  // ephemeral 세션이거나 외부 스케줄러(onScheduledJobDone)가 제공되면 로컬 스케줄러 생성 안 함
  schedulerActor = (isEphemeral || onScheduledJobDone) ? null : createSchedulerActor({
    store: jobStore,
    onDispatch: (event) => eventActor.send({ type: 'enqueue', event }).fork(() => {}, () => {}),
    logger,
    pollIntervalMs: config.scheduler.pollIntervalMs,
  })

  // --- Job 툴 등록 (USER 세션만, 세션 로컬 registry에만 등록) ---
  if (type === SESSION_TYPE.USER) {
    const jobTools = createJobTools({ store: jobStore, eventActor })
    for (const tool of jobTools) sessionToolRegistry.register(tool)

    sessionToolRegistry.register({
      name: 'read_todos',
      description: '현재 대기 중인 TODO 항목 목록을 반환합니다.',
      parameters: { type: 'object', properties: {} },
      handler: () => {
        const todos = (state.get('todos') || []).filter(t => !t.done)
        if (todos.length === 0) return '대기 중인 TODO 항목이 없습니다.'
        return formatTodosAsLines(todos).join('\n')
      },
    })

    if (config.scheduler.todoReview.enabled) {
      const exists = jobStore.listJobs().find(j => j.name === SYSTEM_JOBS.TODO_REVIEW)
      if (!exists) {
        const cron = config.scheduler.todoReview.cron
        jobStore.createJob({
          name: SYSTEM_JOBS.TODO_REVIEW,
          prompt: SYSTEM_JOBS.TODO_REVIEW,
          cron,
          maxRetries: 1,
          nextRun: calcNextRun(cron),
        })
      }
    }
  }

  // --- emit (EventActor 경유) ---
  const emit = emitR.run({ eventActor })

  // --- 브릿지 Hook (로직 없음) ---
  let _idleTimer = null
  state.hooks.on('turnState', (phase) => {
    if (phase.tag === 'idle') {
      eventActor.send({ type: 'drain' }).fork(() => {}, () => {})
      delegateActor.send({ type: 'poll' }).fork(() => {}, () => {})
      if (idleTimeoutMs && onIdle) {
        _idleTimer = setTimeout(() => {
          const events = state.get('events')
          if (!events?.queue?.length && !events?.inFlight) onIdle()
        }, idleTimeoutMs)
      }
    } else {
      if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null }
    }
    if (phase.tag === PHASE.WORKING) {
      resetTrace()
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

  // --- Shutdown (세션 자원만. jobStore/MCP는 globalCtx.shutdown이 처리) ---
  const shutdown = async () => {
    schedulerActor?.send({ type: 'stop' }).fork(() => {}, () => {})
    delegateActor.send({ type: 'stop' }).fork(() => {}, () => {})
    if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null }
    if (!isEphemeral) {
      try {
        await forkTask(persistenceActor.send({ type: 'flush', snapshot: state.snapshot() }))
      } catch (_) {}
    }
  }

  return {
    agent, state,
    get tools() { return getTools() },
    get agents() { return agentRegistry.list() },
    handleInput, handleApproveResponse, handleCancel,
    schedulerActor, delegateActor, eventActor, emit,
    shutdown,
  }
}

export { createSession }
