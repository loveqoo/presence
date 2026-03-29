import {
  Free, Either, askLLM, executeTool, respond, approve, delegate, observe, getState
} from './op.js'
import fp from '../lib/fun-fp.js'

const { Maybe } = fp

// --- Reference resolution (Maybe로 안전한 lookup) ---

/**
 * Safely retrieves an element from an array by index, returning a Maybe.
 * @param {Array} arr - Source array
 * @param {number} index - Zero-based index
 * @returns {Maybe}
 */
const safeLookup = (arr, index) =>
  Maybe.fromNullable(Array.isArray(arr) ? arr[index] : undefined)

/**
 * Resolves a list of 1-based step reference indices to their actual result values.
 * @param {number[]} refs - 1-based indices into results
 * @param {Array} results - Accumulated step results
 * @returns {Array} Resolved values (missing refs are omitted)
 */
const resolveRefs = (refs, results) => {
  if (!refs || !Array.isArray(refs)) return []
  return refs
    .map(i => safeLookup(results, i - 1))
    .filter(m => m.isJust())
    .map(m => m.value)
}

/**
 * Replaces `$N` placeholders in a string with corresponding step results.
 * @param {string} str - Template string with optional `$N` references
 * @param {Array} results - Accumulated step results
 * @returns {string} String with placeholders substituted
 */
const resolveStringRefs = (str, results) => {
  if (typeof str !== 'string') return str
  return str.replace(/\$(\d+)/g, (_, n) =>
    Maybe.fold(
      () => `$${n}`,
      val => typeof val === 'string' ? val : JSON.stringify(val),
      safeLookup(results, Number(n) - 1),
    )
  )
}

/**
 * Resolves `$N` placeholders inside string-valued tool argument fields.
 * @param {Object} args - Tool arguments object
 * @param {Array} results - Accumulated step results
 * @returns {Object} New args object with string values resolved
 */
const resolveToolArgs = (args, results) => {
  if (!args || typeof args !== 'object') return args
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) =>
      [k, typeof v === 'string' ? resolveStringRefs(v, results) : v])
  )
}

// --- Step validation (Either) ---

// --- 공통 검증 헬퍼 ---

/**
 * Returns true if v is an integer greater than or equal to 1.
 * @param {*} v
 * @returns {boolean}
 */
const isPositiveInt = (v) => Number.isInteger(v) && v >= 1

/**
 * Returns true if v is a non-empty array where every element satisfies {@link isPositiveInt}.
 * @param {*} v
 * @returns {boolean}
 */
const isPositiveIntArray = (v) =>
  Array.isArray(v) && v.every(isPositiveInt)

/**
 * Per-op argument validators. Each function receives the step's `args` object
 * and returns `Either.Right(true)` on success or `Either.Left(errorMessage)` on failure.
 * @type {Object.<string, function(Object): Either>}
 */
const argValidators = {
  LOOKUP_MEMORY: (a) => (a.query == null || typeof a.query === 'string')
    ? Either.Right(true)
    : Either.Left('LOOKUP_MEMORY: query는 string이거나 생략해야 합니다.'),
  ASK_LLM: (a) => {
    if (typeof a.prompt !== 'string') return Either.Left('ASK_LLM: prompt(string)가 필요합니다.')
    if (a.ctx != null && !isPositiveIntArray(a.ctx)) {
      return Either.Left('ASK_LLM: ctx는 양의 정수 배열이어야 합니다.')
    }
    return Either.Right(true)
  },
  EXEC: (a) => typeof a.tool === 'string'
    ? Either.Right(true)
    : Either.Left('EXEC: tool(string)이 필요합니다.'),
  RESPOND: (a) => {
    if (a.ref != null) {
      return isPositiveInt(a.ref)
        ? Either.Right(true)
        : Either.Left('RESPOND: ref는 양의 정수(1-based)여야 합니다.')
    }
    return typeof a.message === 'string'
      ? Either.Right(true)
      : Either.Left('RESPOND: ref(positive integer) 또는 message(string)가 필요합니다.')
  },
  APPROVE: (a) => typeof a.description === 'string'
    ? Either.Right(true)
    : Either.Left('APPROVE: description(string)이 필요합니다.'),
  DELEGATE: (a) => (typeof a.target === 'string' && typeof a.task === 'string')
    ? Either.Right(true)
    : Either.Left('DELEGATE: target(string)과 task(string)가 필요합니다.'),
}

/**
 * Validates a raw plan step object: checks structure, known op name, and op-specific args.
 * @param {Object} step - Raw step from the plan JSON
 * @returns {Either} `Either.Right(step)` if valid, `Either.Left(errorMessage)` otherwise
 */
const validateStep = (step) => {
  if (!step || typeof step !== 'object') {
    return Either.Left(`유효하지 않은 step: ${String(step)}`)
  }
  if (!step.op || typeof step.op !== 'string') {
    return Either.Left(`step에 op이 없거나 문자열이 아닙니다.`)
  }
  if (!opHandlers[step.op]) {
    return Either.Left(`알 수 없는 op: ${step.op}`)
  }
  return argValidators[step.op](step.args || {})
    .chain(() => Either.Right(step))
}

// --- Step → Op (dispatch object) ---
// 반환: Free<Either<string, value>>

/**
 * Dispatch table mapping op names to their Free monad execution handlers.
 * Each handler receives `(args, results)` and returns `Free<value>`.
 * @type {Object.<string, function(Object, Array): Free>}
 */
const opHandlers = {
  LOOKUP_MEMORY: (a) =>
    getState('context.memories').chain(memories => {
      if (!Array.isArray(memories) || memories.length === 0) return Free.of([])
      const q = (a.query || '').toLowerCase()
      if (!q) return Free.of(memories)
      return Free.of(memories.filter(m => String(m).toLowerCase().includes(q)))
    }),

  ASK_LLM: (a, results) => {
    const ctx = resolveRefs(a.ctx, results)
    return askLLM({
      messages: [{ role: 'user', content: a.prompt }],
      context: ctx.length > 0 ? ctx : undefined,
    })
  },

  EXEC: (a, results) => {
    // LLM이 tool_args 대신 args에 직접 넣는 경우 fallback
    const toolArgs = a.tool_args || (() => {
      const { tool, ...rest } = a
      return Object.keys(rest).length > 0 ? rest : {}
    })()
    return executeTool(a.tool, resolveToolArgs(toolArgs, results))
  },

  RESPOND: (a, results) =>
    respond(a.ref != null
      ? Maybe.fold(() => null, v => v, safeLookup(results, a.ref - 1))
      : a.message),

  APPROVE: (a) =>
    approve(a.description),

  DELEGATE: (a) =>
    delegate(a.target, a.task),
}

// --- Normalization rules ---
// 각 규칙: step → step (불변). 매칭 안 되면 원본 반환.

/**
 * Converts `EXEC { tool: "delegate" }` steps to the canonical `DELEGATE` op.
 * Corrects LLM output that uses EXEC instead of the dedicated DELEGATE op.
 * @param {Object} step - Raw plan step
 * @returns {Object} Normalized step
 */
const normalizeExecToDelegate = (step) => {
  if (!step || step.op !== 'EXEC') return step
  const a = step.args || {}
  if (a.tool !== 'delegate') return step
  const target = a.target || a.tool_args?.target
  const task = a.task || a.tool_args?.task
  if (target) return { op: 'DELEGATE', args: { target, task } }
  return step
}

/**
 * Converts `EXEC { tool: "approve" }` steps to the canonical `APPROVE` op.
 * Corrects LLM output that uses EXEC instead of the dedicated APPROVE op.
 * @param {Object} step - Raw plan step
 * @returns {Object} Normalized step
 */
const normalizeExecToApprove = (step) => {
  if (!step || step.op !== 'EXEC') return step
  const a = step.args || {}
  if (a.tool !== 'approve') return step
  const description = a.description || a.tool_args?.description
  if (description) return { op: 'APPROVE', args: { description } }
  return step
}

// --- Pipeline ---
/**
 * Default normalization rule pipeline applied to every step before validation.
 * @type {Array<function(Object): Object>}
 */
const defaultRules = [
  normalizeExecToDelegate,
  normalizeExecToApprove,
]

/**
 * Applies a sequence of normalization rules to a step in order.
 * @param {Object} step - Raw plan step
 * @param {Array<function(Object): Object>} [rules=defaultRules] - Rule functions to apply
 * @returns {Object} Normalized step
 */
const normalizeStep = (step, rules = defaultRules) =>
  rules.reduce((s, rule) => rule(s), step)

/**
 * Normalizes, validates, and executes a single plan step, returning its result wrapped in Either.
 * Short-circuits to `Free.of(Either.Left(err))` on validation failure or out-of-range ref.
 * @param {Object} step - Raw plan step
 * @param {Array} results - Accumulated results from prior steps (used for ref resolution)
 * @returns {Free<Either<string, *>>}
 */
const stepToOp = (step, results) =>
  Either.fold(
    err => Free.of(Either.Left(err)),
    validStep => {
      const a = validStep.args || {}

      // RESPOND ref 범위 검증
      if (validStep.op === 'RESPOND' && a.ref != null && safeLookup(results, a.ref - 1).isNothing()) {
        return Free.of(Either.Left(`RESPOND: 참조 인덱스 ${a.ref}에 해당하는 결과가 없습니다.`))
      }

      return opHandlers[validStep.op](a, results)
        .chain(value => Free.of(Either.Right(value)))
    },
    validateStep(normalizeStep(step)),
  )

// --- parsePlan ---
// 반환: Free<Either<string, results[]>>
// 잘못된 step이 있으면 즉시 Left로 short-circuit

/**
 * Converts a plan object (from LLM output) into a sequential Free monad program.
 * Handles `direct_response` plans and multi-step plans; short-circuits on the first invalid step.
 * @param {{ type?: string, message?: string, steps?: Object[] }} plan - Parsed plan JSON
 * @returns {Free<Either<string, Array>>} Program yielding all step results or the first error
 */
const parsePlan = (plan) => {
  if (plan.type === 'direct_response') {
    return respond(plan.message).chain(r => Free.of(Either.Right(r)))
  }

  const steps = plan.steps || []
  if (steps.length === 0) return Free.of(Either.Right([]))

  return steps.reduce(
    (program, step) => program.chain(acc => {
      // 이미 실패 → 나머지 step 건너뜀
      if (Either.isLeft(acc)) return Free.of(acc)

      return stepToOp(step, acc.value).chain(stepResult =>
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

export {
  parsePlan, stepToOp, normalizeStep, defaultRules,
  normalizeExecToDelegate, normalizeExecToApprove,
  opHandlers, validateStep, argValidators,
  isPositiveInt, isPositiveIntArray, resolveRefs, resolveStringRefs, resolveToolArgs, safeLookup,
}
