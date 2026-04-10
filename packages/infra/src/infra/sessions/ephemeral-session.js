import { createOriginState } from '../states/origin-state.js'
import { ToolRegistryView } from '../tools/tool-registry.js'
import { PROMPT, TurnState } from '@presence/core/core/policies.js'
import { Agent } from '@presence/core/core/agent.js'
import { charsToTokens } from '@presence/core/lib/tokenizer.js'
import { t } from '../../i18n/index.js'
import { TurnController } from './internal/turn-controller.js'
import { IdleMonitor } from './internal/idle-monitor.js'
import { sessionInterpreterR } from './internal/session-interpreter.js'
import { SessionActors } from './internal/session-actors.js'
import { Session } from './session.js'

const resolveBudget = (prompt) => {
  const maxContextTokens = prompt.maxContextTokens
    || (prompt.maxContextChars ? charsToTokens(prompt.maxContextChars) : PROMPT.DEFAULT_MAX_CONTEXT_TOKENS)
  const reservedOutputTokens = prompt.reservedOutputTokens
    || (prompt.reservedOutputChars ? charsToTokens(prompt.reservedOutputChars) : PROMPT.DEFAULT_RESERVED_OUTPUT_TOKENS)
  return { maxContextChars: maxContextTokens, reservedOutputChars: reservedOutputTokens }
}

const NOOP_TASK = { fork: (_err, res) => res('skip') }
const NOOP_PERSISTENCE_ACTOR = { send: () => NOOP_TASK, save: () => NOOP_TASK, flush: () => NOOP_TASK }

// =============================================================================
// EphemeralSession: 일회성 세션 (SCHEDULED, AGENT 공통).
// Session 알고리즘의 기본 구현. persistence 없음, scheduler 없음.
// =============================================================================

class EphemeralSession extends Session {

  // --- 생성 단계 구현 ---

  initState() {
    this.state = createOriginState({
      turnState: TurnState.idle(),
      lastTurn: null,
      turn: 0,
      context: { memories: [], conversationHistory: [] },
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      delegates: { pending: [] },
      todos: [],
    })
  }

  initTurnControl() {
    this.turnController = new TurnController(this.state, this.logger, () => this.actors.turnActor)
  }

  initPersistence() {
    this.persistenceActor = NOOP_PERSISTENCE_ACTOR
  }

  restoreState() {}

  initToolRegistry(userContext) {
    const personaFilter = (tool) => {
      const persona = userContext.persona.get()
      if (!persona.tools || persona.tools.length === 0) return true
      return new Set(persona.tools).has(tool.name)
    }
    this.toolView = new ToolRegistryView(userContext.toolRegistry, personaFilter)
    this.getTools = () => this.toolView.list()
  }

  initInterpreter(userContext) {
    this.interpreter = sessionInterpreterR.run({
      llm: userContext.llm,
      toolRegistry: this.toolView,
      userDataStore: userContext.userDataStore,
      state: this.state,
      agentRegistry: userContext.agentRegistry,
      turnController: this.turnController,
      logger: this.logger,
    })
  }

  initActors(userContext, opts) {
    this.actors = new SessionActors({
      userContext, state: this.state, logger: this.logger,
      persistenceActor: this.persistenceActor,
      userId: this.userId,
      dispatchTurn: (input, turnOpts) => this.runAgent(input, turnOpts),
      onScheduledJobDone: this.resolveJobDoneHandler(opts),
    })
  }

  resolveJobDoneHandler(opts) { return opts.onScheduledJobDone || null }

  initAgent(userContext) {
    this.agent = new Agent({
      resolveTools: this.getTools,
      resolveAgents: () => userContext.agentRegistry.list(),
      persona: userContext.persona.get(),
      responseFormatMode: userContext.config.llm.responseFormat,
      maxRetries: userContext.config.llm.maxRetries,
      maxIterations: userContext.config.maxIterations,
      budget: resolveBudget(userContext.config.prompt),
      t,
      interpret: this.interpreter.interpret,
      ST: this.interpreter.ST,
      state: this.state,
      actors: this.actors.forAgent(this.logger),
    })
  }

  initScheduler() {}

  initTools() {}

  initMonitor(opts) {
    this.idleMonitor = new IdleMonitor(this.state, {
      eventActor: this.actors.eventActor,
      delegateActor: this.actors.delegateActor,
      budgetActor: this.actors.budgetActor,
      resetTrace: this.interpreter.resetTrace,
      idleTimeoutMs: opts.idleTimeoutMs,
      onIdle: opts.onIdle,
    })
  }

  // --- Turn 실행: allowedTools로 Agent 툴 제한 ---

  runAgent(input, opts) {
    const { allowedTools = [] } = opts || {}
    if (allowedTools.length === 0) return this.agent.run(input, opts)

    const currentTools = this.getTools()
    const effectiveTools = currentTools.filter(tool =>
      allowedTools.some(pattern => { try { return new RegExp(pattern).test(tool.name) } catch (_unused) { return false } })
    )
    if (effectiveTools.length === currentTools.length) return this.agent.run(input, opts)
    return this.agent.withTools(effectiveTools).run(input, opts)
  }

  // --- Public 인터페이스 ---

  async handleInput(input) { return this.turnController.handleInput(input) }
  handleApproveResponse(approved) { this.turnController.handleApproveResponse(approved) }
  handleCancel() { this.turnController.handleCancel() }
  emit(event) { return this.actors.eventActor.emit(event) }

  get tools() { return this.getTools() }
  get eventActor() { return this.actors.eventActor }
  get delegateActor() { return this.actors.delegateActor }
  get schedulerActor() { return null }

  // --- 종료 단계 구현 ---

  shutdownScheduler() {}
  shutdownActors() { this.actors.shutdown() }
  clearTimers() { this.idleMonitor.clearTimer() }
  async flushPersistence() {}
}

export { EphemeralSession }
