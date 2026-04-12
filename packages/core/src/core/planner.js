import { askLLM, respond, updateState, getState } from './op.js'
import { parsePlan, normalizeStep, summarizeResults } from './plan-executor.js'
import { assemblePrompt, buildRetryPrompt } from './prompt/assembly.js'
import { ERROR_KIND, TurnError } from './policies.js'
import { safeJsonParse, validatePlan } from './validate.js'
import { TurnLifecycle } from './turn-lifecycle.js'
import { DebugRecorder } from './debug-recorder.js'
import fp from '../lib/fun-fp.js'

const { Free, Either, identity } = fp


const PLANNER_DEFAULTS = Object.freeze({
  resolveTools: () => [],
  resolveAgents: () => [],
  persona: {},
  maxRetries: 0,
  maxIterations: 10,
  t: identity,
})

class Planner {
  constructor(config = {}) {
    // undefined 값은 기본값으로 대체 (spread는 undefined를 보존하므로 명시적 필터링)
    const merged = { ...PLANNER_DEFAULTS }
    for (const key of Object.keys(config)) {
      if (config[key] !== undefined) merged[key] = config[key]
    }
    this.config = merged
    this.lifecycle = new TurnLifecycle()
    this.debug = new DebugRecorder()
  }

  withTools(tools) {
    return new Planner({ ...this.config, resolveTools: () => tools })
  }

  // --- 플래닝 엔진 ---

  program(input, { source } = {}) {
    return this.loadContext(input, source)
      .chain(turn => this.planCycle(turn, 0))
  }

  loadContext(input, source) {
    return getState('context.memories')
      .chain(memories => getState('context.conversationHistory').chain(history =>
        Free.of({
          input, source,
          tools: this.config.resolveTools(),
          agents: this.config.resolveAgents(),
          memories: memories || [],
          history: history || [],
          previousPlan: null,
          previousResults: null,
        })
      ))
  }

  planCycle(turn, n) {
    if (n >= this.config.maxIterations) {
      return this.lifecycle.respondAndFail(turn, TurnError(
        `Max iterations (${this.config.maxIterations}) exceeded`,
        ERROR_KIND.MAX_ITERATIONS,
      ), this.config.t)
    }
    return this.executeCycle(turn, n, this.config.maxRetries)
  }

  executeCycle(turn, n, retriesLeft) {
    const prompt = this.buildPrompt(turn)
    return askLLM({
      messages: prompt.messages,
      responseFormat: prompt.response_format,
      maxTokens: prompt.maxTokens,
    }).chain(planJson => {
      const parsed = Either.pipeK(safeJsonParse, p => validatePlan(p, { tools: turn.tools }))(planJson)
      const rawResponse = typeof planJson === 'string' ? planJson : JSON.stringify(planJson)
      return this.debug.record(turn, prompt, rawResponse, parsed, { iteration: n })
        .chain(() => this.resolveParseResult(turn, n, parsed, prompt, retriesLeft))
    })
  }

  buildPrompt(turn) {
    const iterationContext = turn.previousPlan
      ? { previousPlan: turn.previousPlan, previousResults: turn.previousResults }
      : null
    return assemblePrompt({
      persona: this.config.persona,
      tools: turn.tools,
      agents: turn.agents,
      memories: turn.memories,
      history: turn.history,
      input: turn.input,
      iterationContext,
      budget: this.config.budget,
      responseFormatMode: this.config.responseFormatMode,
    })
  }

  resolveParseResult(turn, n, parsed, prompt, retriesLeft) {
    return Either.fold(
      error => this.retryOrFail(turn, n, error, prompt, retriesLeft),
      plan  => this.executePlan(turn, n, plan),
      parsed,
    )
  }

  retryOrFail(turn, n, error, prompt, retriesLeft) {
    if (retriesLeft <= 0) return this.lifecycle.respondAndFail(turn, error, this.config.t)
    return updateState('_retry', {
      attempt: this.config.maxRetries - retriesLeft + 1,
      maxRetries: this.config.maxRetries,
      error: error.message,
    }).chain(() => {
      const retryPrompt = buildRetryPrompt(prompt, error.message)
      return askLLM({
        messages: retryPrompt.messages,
        responseFormat: retryPrompt.response_format,
        maxTokens: retryPrompt.maxTokens,
      }).chain(planJson => {
        const parsed = Either.pipeK(safeJsonParse, p => validatePlan(p, { tools: turn.tools }))(planJson)
        const rawResponse = typeof planJson === 'string' ? planJson : JSON.stringify(planJson)
        const retryAttempt = this.config.maxRetries - retriesLeft + 1
        return this.debug.record(turn, retryPrompt, rawResponse, parsed, { iteration: n, retryAttempt })
          .chain(() => this.resolveParseResult(turn, n, parsed, retryPrompt, retriesLeft - 1))
      })
    })
  }

  executePlan(turn, n, plan) {
    if (plan.type === 'direct_response') {
      return respond(plan.message).chain(msg => this.lifecycle.success(turn, msg))
    }
    const hasRespond = plan.steps.some(s => s.op === 'RESPOND')
    return parsePlan(plan, normalizeStep).chain(either => Either.fold(
      err => this.lifecycle.respondAndFail(turn, TurnError(err, ERROR_KIND.PLANNER_SHAPE), this.config.t),
      results => {
        if (hasRespond) {
          return this.lifecycle.success(turn, results[results.length - 1])
        }
        return this.planCycle({
          ...turn,
          previousPlan: plan,
          previousResults: summarizeResults(results),
        }, n + 1)
      },
      either,
    ))
  }

}

export { Planner }
