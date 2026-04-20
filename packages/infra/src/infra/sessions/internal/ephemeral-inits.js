import { createOriginState } from '../../states/origin-state.js'
import { ToolRegistryView } from '../../tools/tool-registry.js'
import { PROMPT, TurnState } from '@presence/core/core/policies.js'
import { Agent } from '@presence/core/core/agent.js'
import { TurnLifecycle } from '@presence/core/core/turn-lifecycle.js'
import { charsToTokens } from '@presence/core/lib/tokenizer.js'
import { makeSessionFsm } from './session-fsm-init.js'
import { t } from '../../../i18n/index.js'
import { TurnController } from './turn-controller.js'
import { IdleMonitor } from './idle-monitor.js'
import { sessionInterpreterR } from './session-interpreter.js'
import { SessionActors } from './session-actors.js'

// =============================================================================
// EphemeralSession 의 init 단계 구현.
// 복잡도 상한 (Fn≤25) 유지를 위해 prototype extension 으로 분리.
// UserSession 등 파생 클래스의 `super.initX()` 는 EphemeralSession.prototype 에
// 부착된 이 메서드들을 prototype chain 으로 해석한다.
// =============================================================================

const resolveBudget = (prompt) => {
  const maxContextTokens = prompt.maxContextTokens
    || (prompt.maxContextChars ? charsToTokens(prompt.maxContextChars) : PROMPT.DEFAULT_MAX_CONTEXT_TOKENS)
  const reservedOutputTokens = prompt.reservedOutputTokens
    || (prompt.reservedOutputChars ? charsToTokens(prompt.reservedOutputChars) : PROMPT.DEFAULT_RESERVED_OUTPUT_TOKENS)
  return { maxContextChars: maxContextTokens, reservedOutputChars: reservedOutputTokens }
}

const NOOP_TASK = { fork: (_err, res) => res('skip') }
const NOOP_PERSISTENCE_ACTOR = { send: () => NOOP_TASK, save: () => NOOP_TASK, flush: () => NOOP_TASK }

// 각 init 은 prototype 에 Object.assign 으로 부착. `this` 는 EphemeralSession 인스턴스.
const ephemeralInits = {
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
  },

  initTurnControl() {
    // Session 이 소유하는 단일 TurnLifecycle. planner/executor/turn-controller 가 공유.
    this.turnLifecycle = new TurnLifecycle(t)
    this.turnController = new TurnController(this.state, this.logger, () => this.actors.turnActor, this.turnLifecycle)
  },

  initFsm() {
    // 단일 bus — turnGate / approve / delegate 모두 공유. 각 bridge 는 exact topic 구독.
    // turnAbort 은 handleInput 안에서 늦게 생성되므로 bridge 는 closure 로 지연 접근.
    const fsm = makeSessionFsm({ state: this.state, turnController: this.turnController })
    this.fsmBus = fsm.fsmBus
    this.turnGateRuntime = fsm.turnGateRuntime
    this.approveRuntime = fsm.approveRuntime
    this.delegateRuntime = fsm.delegateRuntime
    this.sessionFsmDispose = fsm.disposeAll
    // 늦은 주입 — initTurnControl 이 먼저 실행되어 turnController 는 이미 존재.
    this.turnController.setTurnGateRuntime(this.turnGateRuntime)
    this.turnController.setApproveRuntime(this.approveRuntime)
  },

  shutdownFsm() {
    if (this.sessionFsmDispose) {
      this.sessionFsmDispose()
      this.sessionFsmDispose = null
    }
  },

  initPersistence() { this.persistenceActor = NOOP_PERSISTENCE_ACTOR },

  initToolRegistry(userContext) {
    const personaFilter = (tool) => {
      const persona = userContext.persona.get()
      if (!persona.tools || persona.tools.length === 0) return true
      return new Set(persona.tools).has(tool.name)
    }
    this.toolView = new ToolRegistryView(userContext.toolRegistry, personaFilter)
    this.getTools = () => this.toolView.list()
  },

  initInterpreter(userContext) {
    this.interpreter = sessionInterpreterR.run({
      llm: userContext.llm,
      toolRegistry: this.toolView,
      userDataStore: userContext.userDataStore,
      state: this.state,
      agentRegistry: userContext.agentRegistry,
      turnController: this.turnController,
      delegateRuntime: this.delegateRuntime,
      logger: this.logger,
    })
  },

  initActors(userContext, opts) {
    this.actors = new SessionActors({
      userContext, state: this.state, logger: this.logger,
      persistenceActor: this.persistenceActor,
      userId: this.userId,
      turnLifecycle: this.turnLifecycle,
      turnController: this.turnController,
      delegateRuntime: this.delegateRuntime,
      dispatchTurn: (input, turnOpts) => this.runAgent(input, turnOpts),
      onScheduledJobDone: this.resolveJobDoneHandler(opts),
    })
  },

  resolveJobDoneHandler(opts) { return opts.onScheduledJobDone || null },

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
      lifecycle: this.turnLifecycle,
      interpret: this.interpreter.interpret,
      ST: this.interpreter.ST,
      state: this.state,
      actors: this.actors.forAgent(this.logger),
      turnGateRuntime: this.turnGateRuntime,
    })
  },

  initMonitor(opts) {
    this.idleMonitor = new IdleMonitor(this.state, {
      eventActor: this.actors.eventActor,
      delegateActor: this.actors.delegateActor,
      budgetActor: this.actors.budgetActor,
      resetTrace: this.interpreter.resetTrace,
      idleTimeoutMs: opts.idleTimeoutMs,
      onIdle: opts.onIdle,
    })
  },

  // allowedTools 로 Agent 툴 제한. turnActor 가 호출.
  runAgent(input, opts) {
    const { allowedTools = [] } = opts || {}
    if (allowedTools.length === 0) return this.agent.run(input, opts)

    const currentTools = this.getTools()
    const effectiveTools = currentTools.filter(tool =>
      allowedTools.some(pattern => { try { return new RegExp(pattern).test(tool.name) } catch (_unused) { return false } })
    )
    if (effectiveTools.length === currentTools.length) return this.agent.run(input, opts)
    return this.agent.withTools(effectiveTools).run(input, opts)
  },
}

export { ephemeralInits }
