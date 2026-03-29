import { Free, Either, askLLM, respond, updateState, getState, pipe, runFreeWithStateT } from './op.js'
import { parsePlan, validateStep } from './plan.js'
import { assemblePrompt, buildRetryPrompt, summarizeResults } from './prompt.js'
import { DEBUG, HISTORY, MEMORY } from './policies.js'
import { getByPath } from '../lib/path.js'

// identity fallback: t를 주입받지 않으면 key를 그대로 반환
const _identityT = (key) => key

// history id: restore 후에도 충돌 없도록 timestamp + counter 조합
let _historyCounter = 0
const nextHistoryId = () => `h-${Date.now()}-${++_historyCounter}`
const truncate = (text, max) =>
  text.length > max ? text.slice(0, max) + '...(truncated)' : text

// --- 상태 ADT ---

/** Enum of agent lifecycle phases: IDLE | WORKING. */
const PHASE = Object.freeze({ IDLE: 'idle', WORKING: 'working' })

/** Enum of turn outcome tags: SUCCESS | FAILURE. */
const RESULT = Object.freeze({ SUCCESS: 'success', FAILURE: 'failure' })

/** Enum of structured error categories for planner and interpreter failures. */
const ERROR_KIND = Object.freeze({
  PLANNER_PARSE:   'planner_parse',
  PLANNER_SHAPE:   'planner_shape',
  INTERPRETER:     'interpreter',
  MAX_ITERATIONS:  'max_iterations',
})

/**
 * ADT constructors for the agent's current phase.
 * @type {{ idle: () => {tag: string}, working: (input: string) => {tag: string, input: string} }}
 */
const Phase = {
  idle:    ()      => ({ tag: PHASE.IDLE }),
  working: (input) => ({ tag: PHASE.WORKING, input }),
}

/**
 * ADT constructors for a completed turn result.
 * @type {{ success: (input, result) => object, failure: (input, error, response) => object }}
 */
const TurnResult = {
  success: (input, result)          => ({ tag: RESULT.SUCCESS, input, result }),
  failure: (input, error, response) => ({ tag: RESULT.FAILURE, input, error, response }),
}

/**
 * Constructs a structured error value carrying a message and an ERROR_KIND tag.
 * @param {string} message - Human-readable error description.
 * @param {string} kind - One of the ERROR_KIND constants.
 * @returns {{ message: string, kind: string }}
 */
const ErrorInfo = (message, kind) => ({ message, kind })

// --- 순수 파싱/검증 (Either) ---

/**
 * Strips non-JSON prefix from an LLM response string (e.g. `<think>` tags).
 * @param {string|*} str - Raw LLM output.
 * @returns {string|*} Substring starting at the first `{`, or the original value.
 */
// LLM 응답에서 JSON 부분만 추출 (Qwen 등 <think> 태그 포함 모델 대응)
const extractJson = (str) => {
  if (typeof str !== 'string') return str
  const idx = str.indexOf('{')
  if (idx <= 0) return str
  return str.slice(idx)
}

/**
 * Parses a JSON string (after stripping non-JSON prefix) into Either.
 * @param {string} str - String to parse.
 * @returns {Either} Right(parsed) or Left(ErrorInfo) with PLANNER_PARSE kind.
 */
const safeJsonParse = (str) =>
  Either.fold(
    e => Either.Left(ErrorInfo(e.message || String(e), ERROR_KIND.PLANNER_PARSE)),
    parsed => Either.Right(parsed),
    Either.catch(() => typeof str === 'string' ? JSON.parse(extractJson(str)) : str),
  )

// --- step 검증 (Either 기반) ---

/**
 * Validates that an EXEC step provides all required tool arguments.
 * @param {object} step - Plan step object.
 * @param {object[]} tools - Available tool definitions.
 * @returns {Either} Right(true) or Left(ErrorInfo) with PLANNER_SHAPE kind.
 */
// EXEC: tool_args 필수 인자 확인
const validateExecArgs = (step, tools) => {
  if (step.op !== 'EXEC' || !tools || tools.length === 0) return Either.Right(true)
  const a = step.args || {}
  const toolDef = tools.find(t => t.name === a.tool)
  if (!toolDef) return Either.Left(ErrorInfo(`EXEC: unknown tool: ${a.tool}`, ERROR_KIND.PLANNER_SHAPE))

  const required = toolDef.parameters?.required || []
  if (required.length === 0) return Either.Right(true)

  const resolvedArgs = a.tool_args || (() => {
    const { tool, ...rest } = a
    return rest
  })()
  const missing = required.filter(r => resolvedArgs[r] == null && resolvedArgs[r] !== 0 && resolvedArgs[r] !== false)
  return missing.length === 0
    ? Either.Right(true)
    : Either.Left(ErrorInfo(`EXEC ${a.tool}: missing required args: ${missing.join(', ')}`, ERROR_KIND.PLANNER_SHAPE))
}

/**
 * Validates that RESPOND `ref` and ASK_LLM `ctx` indices are within the preceding step range.
 * @param {object} step - Plan step object.
 * @param {number} index - Zero-based index of this step in the plan.
 * @returns {Either} Right(true) or Left(ErrorInfo) with PLANNER_SHAPE kind.
 */
// RESPOND/ASK_LLM: ref/ctx 범위 확인
const validateRefRange = (step, index) => {
  const a = step.args || {}
  if (step.op === 'RESPOND' && a.ref != null && a.ref > index) {
    return Either.Left(ErrorInfo(
      `RESPOND ref=${a.ref} exceeds available steps (${index}). ref must be <= ${index}.`,
      ERROR_KIND.PLANNER_SHAPE))
  }
  if (step.op === 'ASK_LLM' && Array.isArray(a.ctx)) {
    const invalid = a.ctx.find(c => c > index)
    if (invalid != null) {
      return Either.Left(ErrorInfo(
        `ASK_LLM ctx=[${a.ctx}] references step ${invalid} but only ${index} steps precede it.`,
        ERROR_KIND.PLANNER_SHAPE))
    }
  }
  return Either.Right(true)
}

/**
 * Full validation for a single plan step: structure + args + ref range.
 * Composes validateStep, validateExecArgs, and validateRefRange via Either Kleisli chain.
 * @param {object} step - Plan step to validate.
 * @param {number} index - Zero-based position of the step.
 * @param {object[]} tools - Available tool definitions.
 * @returns {Either} Right(step) or Left(ErrorInfo).
 */
// 단일 step 전체 검증 (구조 + args + range) → Either Kleisli 합성
const validateStepFull = (step, index, tools) => {
  const pipeline = Either.pipeK(
    () => Either.fold(
      err => Either.Left(ErrorInfo(err, ERROR_KIND.PLANNER_SHAPE)),
      () => Either.Right(step),
      validateStep(step),
    ),
    () => validateExecArgs(step, tools),
    () => validateRefRange(step, index),
  )
  return pipeline(null)
}

/**
 * Validates a parsed LLM plan object: must be `direct_response` or `plan` with valid steps.
 * Short-circuits on the first invalid step.
 * @param {object} plan - Parsed plan from the LLM.
 * @param {{ tools?: object[] }} opts - Tool definitions for step-level validation.
 * @returns {Either} Right(plan) or Left(ErrorInfo).
 */
const validatePlan = (plan, { tools = [] } = {}) => {
  if (plan == null || typeof plan !== 'object' || Array.isArray(plan)) {
    return Either.Left(ErrorInfo(
      `플래너 응답이 올바른 객체가 아닙니다: ${String(plan)}`, ERROR_KIND.PLANNER_SHAPE))
  }
  if (plan.type === 'direct_response') {
    return typeof plan.message === 'string'
      ? Either.Right(plan)
      : Either.Left(ErrorInfo('direct_response에 유효한 message(string)가 필요합니다.', ERROR_KIND.PLANNER_SHAPE))
  }
  if (plan.type === 'plan') {
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
      return Either.Left(ErrorInfo('plan에 비어있지 않은 steps 배열이 필요합니다.', ERROR_KIND.PLANNER_SHAPE))
    }
    // RESPOND는 포함 시 반드시 마지막 step
    const respondIndex = plan.steps.findIndex(s => s?.op === 'RESPOND')
    if (respondIndex !== -1 && respondIndex !== plan.steps.length - 1) {
      return Either.Left(ErrorInfo(
        `RESPOND must be the last step in a plan (found at index ${respondIndex} of ${plan.steps.length}).`,
        ERROR_KIND.PLANNER_SHAPE))
    }
    // reduce + Either chain: 첫 번째 Left에서 short-circuit
    return plan.steps.reduce(
      (acc, step, i) => acc.chain(() => validateStepFull(step, i, tools)),
      Either.Right(true),
    ).chain(() => Either.Right(plan))
  }
  return Either.Left(ErrorInfo(
    `플래너 응답 형식이 잘못되었습니다 (type: ${plan.type ?? 'undefined'}). `
    + `"direct_response" 또는 steps가 포함된 "plan"이어야 합니다.`,
    ERROR_KIND.PLANNER_SHAPE))
}

// --- 상태 전이 함수 ---

/**
 * Free monad program that marks the start of a turn. Currently a no-op placeholder.
 * @param {string} _input - The user input (unused).
 * @returns {Free} Free.of(null)
 */
const beginTurn = (_input) => Free.of(null)

/**
 * Free monad program that commits a successful turn: clears streaming state,
 * appends conversation history (when source is 'user'), and transitions to idle.
 * @param {string} input - Original user input.
 * @param {string} result - The response text to record.
 * @param {{ source?: string }} opts
 * @returns {Free} Resolves to the result string.
 */
const finishSuccess = (input, result, { source } = {}) =>
  updateState('_streaming', null)
    .chain(() => {
      if (source === 'user') {
        return getState('context.conversationHistory').chain(history => {
          const entry = {
            id: nextHistoryId(),
            input: truncate(String(input), HISTORY.MAX_INPUT_CHARS),
            output: truncate(String(result), HISTORY.MAX_OUTPUT_CHARS),
            ts: Date.now(),
          }
          const updated = [...(history || []), entry]
          const trimmed = updated.length > HISTORY.MAX_CONVERSATION
            ? updated.slice(-HISTORY.MAX_CONVERSATION)
            : updated
          return updateState('context.conversationHistory', trimmed)
        })
      }
      return Free.of(null)
    })
    .chain(() => updateState('lastTurn', TurnResult.success(input, result)))
    .chain(() => updateState('turnState', Phase.idle()))
    .chain(() => Free.of(result))

/**
 * Free monad program that commits a failed turn: clears streaming state,
 * appends a failure entry to conversation history (when source is 'user'), and transitions to idle.
 * @param {string} input - Original user input.
 * @param {{ message: string, kind: string }} error - Structured error value.
 * @param {string} response - The error message shown to the user.
 * @param {{ source?: string }} opts
 * @returns {Free} Resolves to the response string.
 */
const finishFailure = (input, error, response, { source } = {}) =>
  updateState('_streaming', null)
    .chain(() => {
      if (source === 'user') {
        return getState('context.conversationHistory').chain(history => {
          const entry = {
            id: nextHistoryId(),
            input: truncate(String(input), HISTORY.MAX_INPUT_CHARS),
            output: truncate(String(response), HISTORY.MAX_OUTPUT_CHARS),
            failed: true,
            errorKind: error.kind || 'unknown',
            errorMessage: error.message || String(error),
            ts: Date.now(),
          }
          const updated = [...(history || []), entry]
          const trimmed = updated.length > HISTORY.MAX_CONVERSATION
            ? updated.slice(-HISTORY.MAX_CONVERSATION)
            : updated
          return updateState('context.conversationHistory', trimmed)
        })
      }
      return Free.of(null)
    })
    .chain(() => updateState('lastTurn', TurnResult.failure(input, error, response)))
    .chain(() => updateState('turnState', Phase.idle()))
    .chain(() => Free.of(response))

/**
 * Sends an error response to the user and then commits the turn as a failure.
 * Combines `respond` + `finishFailure` into a single Free program.
 * @param {string} input - Original user input.
 * @param {{ message: string, kind: string }} error - Structured error value.
 * @param {Function} [t] - i18n translation function; falls back to identity.
 * @param {{ source?: string }} opts
 * @returns {Free}
 */
// --- 에러 → 실패 턴 종료 (공통 패턴) ---
// t: 번역 함수 (주입 없으면 identity fallback)
const respondAndFail = (input, error, t = _identityT, { source } = {}) =>
  respond(t('error.agent_error', { message: error.message }))
    .chain(msg => finishFailure(input, error, msg, { source }))

// --- Incremental Planning Engine ---
// Plan-Validate-Execute-Observe-Repeat
//
// 매 iteration마다:
//   direct_response     → respond → finishSuccess
//   plan + RESPOND      → execute → finishSuccess (RESPOND이 빠른 종료)
//   plan - RESPOND      → execute → 결과를 rolling context에 추가 → 다음 iteration

/**
 * Builds an Incremental Planning Engine turn as a curried Free monad program.
 * Each call to the returned function runs one full Plan-Validate-Execute-Observe cycle,
 * iterating up to maxIterations times before giving up.
 *
 * @param opts - tools, getTools, agents, getAgents, persona, responseFormatMode,
 *               maxRetries (default 0), maxIterations (default 10), budget, t (i18n fn)
 * @returns A function (input, opts?) => Free that executes one agent turn.
 */
const createAgentTurn = ({ tools = [], getTools, agents = [], getAgents, persona = {}, responseFormatMode, maxRetries = 0, maxIterations = 10, budget, t = _identityT } = {}) => {
  return (input, { source } = {}) =>
    getState('context.memories')
      .chain(memories => getState('context.conversationHistory').chain(history => {
        const conversationHistory = history || []
        const resolvedTools = getTools ? getTools() : tools
        const resolvedAgents = getAgents ? getAgents() : agents
        const baseContext = {
          tools: resolvedTools, agents: resolvedAgents, memories: memories || [], input, persona, responseFormatMode,
          previousPlan: null, previousResults: null,
        }

        const iterate = (context, n) => {
          if (n >= maxIterations) {
            return respondAndFail(input, ErrorInfo(
              `Max iterations (${maxIterations}) exceeded`,
              ERROR_KIND.MAX_ITERATIONS,
            ), t, { source })
          }

          const iterationContext = context.previousPlan
            ? { previousPlan: context.previousPlan, previousResults: context.previousResults }
            : null

          const assembled = assemblePrompt({
            persona: context.persona,
            tools: context.tools,
            agents: context.agents,
            memories: context.memories,
            history: conversationHistory,
            input: context.input,
            iterationContext,
            budget,
            responseFormatMode: context.responseFormatMode,
          })

          const attemptPlan = (currentPrompt, retriesLeft) =>
            askLLM({
              messages: currentPrompt.messages,
              responseFormat: currentPrompt.response_format,
            }).chain(planJson => {
              const parseThenValidate = Either.pipeK(safeJsonParse, p => validatePlan(p, { tools }))
              const parsed = parseThenValidate(planJson)

              // Debug: 턴 디버깅 정보 캡처
              const rawResponse = typeof planJson === 'string' ? planJson : JSON.stringify(planJson)
              const debugInfo = {
                input,
                iteration: n,
                memories: (context.memories || []).slice(0, 20),
                prompt: {
                  systemLength: currentPrompt.messages[0]?.content?.length || 0,
                  messageCount: currentPrompt.messages.length,
                  hasRollingContext: context.previousPlan != null,
                },
                llmResponseLength: rawResponse.length,
                parsedType: Either.fold(() => null, p => p.type, parsed),
                stepCount: Either.fold(() => null, p => p.steps?.length || 0, parsed),
                error: Either.fold(e => e.message, () => null, parsed),
                assembly: assembled._assembly,
                timestamp: Date.now(),
              }

              const iterEntry = {
                ...debugInfo,
                promptMessages: currentPrompt.messages.length,
                promptChars: currentPrompt.messages.reduce((s, m) => s + (m.content?.length || 0), 0),
                response: rawResponse,
              }

              return updateState('_debug.lastTurn', debugInfo)
                .chain(() => updateState('_debug.lastPrompt', currentPrompt.messages))
                .chain(() => updateState('_debug.lastResponse', rawResponse))
                .chain(() => getState('_debug.iterationHistory').chain(prev => {
                  const history = [...(prev || []), iterEntry]
                  const capped = history.length > DEBUG.MAX_ITERATION_HISTORY
                    ? history.slice(-DEBUG.MAX_ITERATION_HISTORY)
                    : history
                  return updateState('_debug.iterationHistory', capped)
                }))
                .chain(() => Either.fold(
                error => {
                  if (retriesLeft <= 0) return respondAndFail(input, error, t, { source })
                  return updateState('_retry', {
                    attempt: maxRetries - retriesLeft + 1,
                    maxRetries,
                    error: error.message,
                  }).chain(() =>
                    attemptPlan(buildRetryPrompt(currentPrompt, error.message), retriesLeft - 1)
                  )
                },
                plan => {
                  if (plan.type === 'direct_response') {
                    return respond(plan.message).chain(msg => finishSuccess(input, msg, { source }))
                  }
                  // plan.type === 'plan'
                  const hasRespond = plan.steps.some(s => s.op === 'RESPOND')

                  return parsePlan(plan).chain(either => Either.fold(
                    err => respondAndFail(input, ErrorInfo(err, ERROR_KIND.PLANNER_SHAPE), t, { source }),
                    results => {
                      if (hasRespond) {
                        // RESPOND가 이미 respond() op을 실행함 → 바로 종료
                        const lastResult = results[results.length - 1]
                        return finishSuccess(input, lastResult, { source })
                      }
                      // 중간 결과 → rolling context로 다음 iteration
                      return iterate({
                        ...context,
                        previousPlan: plan,
                        previousResults: summarizeResults(results),
                      }, n + 1)
                    },
                    either,
                  ))
                },
                parsed,
              ))
            })

          return attemptPlan(assembled, maxRetries)
        }

        return iterate(baseContext, 0)
      }))
}

/**
 * Computes a minimal state patch to recover from an interpreter-level exception.
 * Returns a plain object (not a Free program) for direct application via applyRecovery.
 * @param {string} input - The input that was being processed when the error occurred.
 * @param {Error} err - The caught exception.
 * @returns {{ _streaming: null, lastTurn: object, turnState: object }}
 */
// 인터프리터 예외 시 상태 복구 (순수 전이 함수)
const recoverFromFailure = (input, err) => ({
  _streaming: null,
  lastTurn: TurnResult.failure(input, ErrorInfo(err.message || String(err), ERROR_KIND.INTERPRETER), null),
  turnState: Phase.idle(),
})

/**
 * Applies a recovery patch (from recoverFromFailure) directly to a reactive state object.
 * @param {object} state - Reactive state with a `.set(path, value)` interface.
 * @param {object} recovery - Key/value pairs to write into state.
 */
const applyRecovery = (state, recovery) => {
  for (const [key, value] of Object.entries(recovery)) state.set(key, value)
}

// Task → Promise 변환 헬퍼
const forkTask = (task) => new Promise((resolve, reject) => task.fork(reject, resolve))

/**
 * Ordered list of reactive state paths committed atomically after each turn.
 * `turnState` is always last so that the idle hook fires after all other state is current.
 */
// --- StateT → reactive state 원자적 커밋 ---
// Free 실행 완료 후 StateT의 최종 상태를 reactive state에 반영.
// epoch 기반 경합 방어: /clear 또는 compaction이 턴 실행 중 발생하면 conversationHistory 스킵.
// turnState는 반드시 마지막: idle 전이 시 hook이 발동되어 다음 턴이 시작될 수 있으므로,
// 그 시점에 conversationHistory, lastTurn 등이 이미 최신이어야 한다.
const MANAGED_PATHS = [
  '_streaming', 'lastTurn',
  'context.conversationHistory',
  '_debug.lastTurn', '_debug.lastPrompt', '_debug.lastResponse', '_debug.iterationHistory', '_retry',
  'turnState',
]

/**
 * Resets conversation and debug state on the reactive state object (e.g. on /clear).
 * Increments `_compactionEpoch` so that in-flight turns skip their conversationHistory commit.
 * @param {object} state - Reactive state with `.set(path, value)` and `.get(path)` interface.
 */
const clearDebugState = (state) => {
  state.set('context.conversationHistory', [])
  state.set('context.memories', [])
  state.set('_compactionEpoch', (state.get('_compactionEpoch') || 0) + 1)
  state.set('_debug.lastTurn', null)
  state.set('_debug.lastPrompt', null)
  state.set('_debug.lastResponse', null)
  state.set('_debug.opTrace', [])
  state.set('_debug.recalledMemories', [])
  state.set('_debug.iterationHistory', [])
}

/**
 * Atomically commits the StateT final state to the reactive state after a turn completes.
 * Skips `context.conversationHistory` when the compaction epoch changed mid-turn.
 * @param {object|null} reactiveState - Target reactive state; no-op if falsy.
 * @param {object} finalState - Plain snapshot produced by the Free interpreter.
 * @param {{ initialEpoch?: number }} opts - Epoch at turn start for conflict detection.
 */
const applyFinalState = (reactiveState, finalState, { initialEpoch } = {}) => {
  if (!reactiveState) return
  const currentEpoch = reactiveState.get('_compactionEpoch') || 0
  const epochChanged = initialEpoch !== undefined && initialEpoch !== currentEpoch

  for (const path of MANAGED_PATHS) {
    if (epochChanged && path === 'context.conversationHistory') continue
    const value = getByPath(finalState, path)
    if (value !== undefined) reactiveState.set(path, value)
  }
}

/**
 * Wraps a Free monad turn program with lifecycle management: memory recall before,
 * memory/compaction/persistence Actor messages after, and interpreter-exception recovery.
 * Returns an async function that resolves to the turn result.
 *
 * @param interpret - StateT(Task) interpreter function.
 * @param ST - StateT constructor used for the interpreter.
 * @param reactiveState - Shared reactive state for the server instance.
 * @param actors - Optional memoryActor, compactionActor, persistenceActor, logger.
 * @returns async (program: Free, input: string) => Promise<string>
 */
// 인터프리터 레벨 실패에 대한 안전망 + Actor 기반 턴 전후 처리
// { interpret, ST }: StateT(Task) 인터프리터 번들
const safeRunTurn = ({ interpret, ST }, reactiveState, { memoryActor, compactionActor, persistenceActor, logger } = {}) =>
  async (program, input) => {
    // 턴 시작: lifecycle (turnState → working, turn 증가)
    if (reactiveState) {
      reactiveState.set('turnState', Phase.working(input))
      reactiveState.set('turn', (reactiveState.get('turn') || 0) + 1)
      reactiveState.set('_debug.iterationHistory', [])
    }

    // 턴 시작: memory recall (Actor, 명시적 비동기)
    if (memoryActor && reactiveState) {
      try {
        const memories = await forkTask(memoryActor.send({ type: 'recall', input }))
        reactiveState.set('context.memories', memories.map(n => n.label))
        reactiveState.set('_debug.recalledMemories', memories.map(n => ({
          label: n.label, type: n.type, tier: n.tier,
          createdAt: n.createdAt, embeddedAt: n.embeddedAt,
        })))
      } catch (e) {
        reactiveState.set('context.memories', [])
        reactiveState.set('_debug.recalledMemories', [])
        ;(logger || console).warn('Memory recall failed', { error: e.message })
      }
    }

    // StateT 실행을 위한 스냅샷 (recall 이후, 최신 memories 포함)
    const initialSnapshot = reactiveState ? reactiveState.snapshot() : {}
    const initialEpoch = initialSnapshot._compactionEpoch || 0

    try {
      const [result, finalState] = await runFreeWithStateT(interpret, ST)(program)(initialSnapshot)

      // 턴 종료: 후처리 메시지를 applyFinalState **이전에** 큐잉.
      // idle hook이 다음 턴을 시작해도 cleanup이 먼저 Actor 큐에 있으므로 순서 보장.
      // finalState에서 lastTurn을 읽음 (reactive state는 아직 미커밋).
      if (memoryActor) {
        const lastTurn = getByPath(finalState, 'lastTurn')
        if (lastTurn?.tag === RESULT.SUCCESS) {
          memoryActor.send({ type: 'save', node: {
            label: lastTurn.input || 'unknown',
            type: 'conversation', tier: 'episodic',
            data: { input: lastTurn.input, output: lastTurn.result },
          }}).fork(() => {}, () => {})
        }
        memoryActor.send({ type: 'removeWorking' }).fork(() => {}, () => {})
        memoryActor.send({ type: 'embed' }).fork(() => {}, () => {})
        memoryActor.send({ type: 'prune', tier: 'episodic', max: MEMORY.MAX_EPISODIC }).fork(() => {}, () => {})
        memoryActor.send({ type: 'promote' }).fork(() => {}, () => {})
        memoryActor.send({ type: 'saveDisk' }).fork(() => {}, () => {})
      }
      if (compactionActor) {
        const history = getByPath(finalState, 'context.conversationHistory') || []
        compactionActor.send({ type: 'check', history, epoch: initialEpoch }).fork(() => {}, () => {})
      }

      // 원자적 커밋: StateT 최종 상태 → reactive state
      // turnState=idle이 마지막 → idle hook 발동 시 cleanup 메시지가 이미 Actor 큐에 있음
      applyFinalState(reactiveState, finalState, { initialEpoch })

      if (persistenceActor && reactiveState) {
        persistenceActor.send({ type: 'save', snapshot: reactiveState.snapshot() }).fork(() => {}, () => {})
      }

      return result
    } catch (err) {
      if (reactiveState) applyRecovery(reactiveState, recoverFromFailure(input, err))
      if (persistenceActor && reactiveState) {
        persistenceActor.send({ type: 'save', snapshot: reactiveState.snapshot() }).fork(() => {}, () => {})
      }
      throw err
    }
  }

/**
 * Assembles a complete agent from a turn builder and an execution wrapper.
 * Returns `{ run, program }` where `run` executes a turn end-to-end
 * and `program` returns the raw Free monad program for testing or composition.
 *
 * @param opts - buildTurn?, tools?, getTools?, agents?, getAgents?, persona?,
 *               responseFormatMode?, maxRetries?, maxIterations?, interpret, ST,
 *               state (reactiveState), budget?, execute? (injected executor), t?
 * @returns An agent object with `run(input, opts?) => Promise<string>` and `program(input, opts?) => Free`.
 */
// --- 조립된 에이전트 ---
const createAgent = ({ buildTurn, tools, getTools, agents, getAgents, persona, responseFormatMode, maxRetries, maxIterations, interpret, ST, state, budget, execute: injectedExecute, t = _identityT }) => {
  const turnBuilder = buildTurn || createAgentTurn({ tools, getTools, agents, getAgents, persona, responseFormatMode, maxRetries, maxIterations, budget, t })
  const execute = injectedExecute || safeRunTurn({ interpret, ST }, state)

  const run = (input, opts) => execute(turnBuilder(input, opts), input)
  const program = (input, opts) => turnBuilder(input, opts)

  return { run, program }
}

export {
  createAgentTurn, safeRunTurn, createAgent, applyFinalState, validatePlan, validateExecArgs, validateRefRange, validateStepFull, safeJsonParse, extractJson,
  beginTurn, finishSuccess, finishFailure, respondAndFail,
  recoverFromFailure, applyRecovery, MANAGED_PATHS, clearDebugState,
  PHASE, RESULT, ERROR_KIND, Phase, TurnResult, ErrorInfo,
}
