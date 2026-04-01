import { askLLM, respond, updateState, getState } from './op.js'
import { ops } from './opHandler.js'
import { assemblePrompt, buildRetryPrompt, summarizeResults } from './prompt.js'
import { DEBUG, ERROR_KIND } from './policies.js'
import { safeJsonParse, validatePlan } from './validate.js'
import { ErrorInfo, finishSuccess, respondAndFail } from './turn.js'
import fp from '../lib/fun-fp.js'

const { Free, Either, identity } = fp

const normalizeStep = (step) => {
  if (step.op !== 'EXEC') return step
  const a = step.args || {}
  if (a.tool === 'delegate') {
    const target = a.target || a.tool_args?.target
    const task = a.task || a.tool_args?.task
    if (target) return { op: 'DELEGATE', args: { target, task } }
  }
  if (a.tool === 'approve') {
    const description = a.description || a.tool_args?.description
    if (description) return { op: 'APPROVE', args: { description } }
  }
  return step
}

const parsePlan = (plan) => {
  if (plan.type === 'direct_response') {
    return respond(plan.message).chain(r => Free.of(Either.Right(r)))
  }

  const steps = plan.steps || []
  if (steps.length === 0) return Free.of(Either.Right([]))

  return steps.reduce(
    (program, step) => program.chain(acc => {
      if (Either.isLeft(acc)) return Free.of(acc)
      const normalized = normalizeStep(step)
      const op = ops[normalized.op]
      if (!op) return Free.of(Either.Left(`알 수 없는 op: ${normalized.op}`))
      return op.run(normalized, acc.value).chain(stepResult =>
        Either.fold(
          err => Free.of(Either.Left(err)),
          val => Free.of(Either.Right([...acc.value, val])),
          stepResult,
        )
      )
    }),
    Free.of(Either.Right([])),
  )
}

class Planner {
  constructor({
    resolveTools = () => [],
    resolveAgents = () => [],
    persona = {},
    responseFormatMode,
    maxRetries = 0,
    maxIterations = 10,
    budget,
    t = identity,
  }) {
    this.resolveTools = resolveTools
    this.resolveAgents = resolveAgents
    this.persona = persona
    this.responseFormatMode = responseFormatMode
    this.maxRetries = maxRetries
    this.maxIterations = maxIterations
    this.budget = budget
    this.t = t
  }

  withTools(tools) {
    return new Planner({
      resolveTools: () => tools,
      resolveAgents: this.resolveAgents,
      persona: this.persona,
      responseFormatMode: this.responseFormatMode,
      maxRetries: this.maxRetries,
      maxIterations: this.maxIterations,
      budget: this.budget,
      t: this.t,
    })
  }

  program(input, { source } = {}) {
    return this.loadContext(input, source)
      .chain(turn => this.planCycle(turn, 0))
  }

  loadContext(input, source) {
    return getState('context.memories')
      .chain(memories => getState('context.conversationHistory').chain(history =>
        Free.of({
          input, source,
          tools: this.resolveTools(),
          agents: this.resolveAgents(),
          memories: memories || [],
          history: history || [],
          previousPlan: null,
          previousResults: null,
        })
      ))
  }

  planCycle(turn, n) {
    if (n >= this.maxIterations) {
      return respondAndFail(turn.input, ErrorInfo(
        `Max iterations (${this.maxIterations}) exceeded`,
        ERROR_KIND.MAX_ITERATIONS,
      ), this.t, { source: turn.source })
    }
    return this.executeCycle(turn, n, this.maxRetries)
  }

  executeCycle(turn, n, retriesLeft) {
    const prompt = this.buildPrompt(turn)
    return askLLM({
      messages: prompt.messages,
      responseFormat: prompt.response_format,
    }).chain(planJson => {
      const parsed = Either.pipeK(safeJsonParse, p => validatePlan(p, { tools: turn.tools }))(planJson)
      const rawResponse = typeof planJson === 'string' ? planJson : JSON.stringify(planJson)
      return this.recordDebug(turn, n, prompt, rawResponse, parsed)
        .chain(() => this.resolveParseResult(turn, n, parsed, prompt, retriesLeft))
    })
  }

  buildPrompt(turn) {
    const iterationContext = turn.previousPlan
      ? { previousPlan: turn.previousPlan, previousResults: turn.previousResults }
      : null
    return assemblePrompt({
      persona: this.persona,
      tools: turn.tools,
      agents: turn.agents,
      memories: turn.memories,
      history: turn.history,
      input: turn.input,
      iterationContext,
      budget: this.budget,
      responseFormatMode: this.responseFormatMode,
    })
  }

  recordDebug(turn, n, prompt, rawResponse, parsed) {
    const debugInfo = {
      input: turn.input,
      iteration: n,
      memories: turn.memories.slice(0, 20),
      prompt: {
        systemLength: prompt.messages[0]?.content?.length || 0,
        messageCount: prompt.messages.length,
        hasRollingContext: turn.previousPlan != null,
      },
      llmResponseLength: rawResponse.length,
      parsedType: Either.fold(() => null, p => p.type, parsed),
      stepCount: Either.fold(() => null, p => p.steps?.length || 0, parsed),
      error: Either.fold(e => e.message, () => null, parsed),
      assembly: prompt._assembly,
      timestamp: Date.now(),
    }
    const iterEntry = {
      ...debugInfo,
      promptMessages: prompt.messages.length,
      promptChars: prompt.messages.reduce((s, m) => s + (m.content?.length || 0), 0),
      response: rawResponse,
    }
    return updateState('_debug.lastTurn', debugInfo)
      .chain(() => updateState('_debug.lastPrompt', prompt.messages))
      .chain(() => updateState('_debug.lastResponse', rawResponse))
      .chain(() => getState('_debug.iterationHistory').chain(prev => {
        const history = [...(prev || []), iterEntry]
        const capped = history.length > DEBUG.MAX_ITERATION_HISTORY
          ? history.slice(-DEBUG.MAX_ITERATION_HISTORY)
          : history
        return updateState('_debug.iterationHistory', capped)
      }))
  }

  resolveParseResult(turn, n, parsed, prompt, retriesLeft) {
    return Either.fold(
      error => this.retryOrFail(turn, n, error, prompt, retriesLeft),
      plan  => this.executePlan(turn, n, plan),
      parsed,
    )
  }

  retryOrFail(turn, n, error, prompt, retriesLeft) {
    if (retriesLeft <= 0) return respondAndFail(turn.input, error, this.t, { source: turn.source })
    return updateState('_retry', {
      attempt: this.maxRetries - retriesLeft + 1,
      maxRetries: this.maxRetries,
      error: error.message,
    }).chain(() => {
      const retryPrompt = buildRetryPrompt(prompt, error.message)
      return askLLM({
        messages: retryPrompt.messages,
        responseFormat: retryPrompt.response_format,
      }).chain(planJson => {
        const parsed = Either.pipeK(safeJsonParse, p => validatePlan(p, { tools: turn.tools }))(planJson)
        const rawResponse = typeof planJson === 'string' ? planJson : JSON.stringify(planJson)
        return this.recordDebug(turn, n, retryPrompt, rawResponse, parsed)
          .chain(() => this.resolveParseResult(turn, n, parsed, retryPrompt, retriesLeft - 1))
      })
    })
  }

  executePlan(turn, n, plan) {
    if (plan.type === 'direct_response') {
      return respond(plan.message).chain(msg => finishSuccess(turn.input, msg, { source: turn.source }))
    }
    const hasRespond = plan.steps.some(s => s.op === 'RESPOND')
    return parsePlan(plan).chain(either => Either.fold(
      err => respondAndFail(turn.input, ErrorInfo(err, ERROR_KIND.PLANNER_SHAPE), this.t, { source: turn.source }),
      results => {
        if (hasRespond) {
          return finishSuccess(turn.input, results[results.length - 1], { source: turn.source })
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

export { Planner, parsePlan }
