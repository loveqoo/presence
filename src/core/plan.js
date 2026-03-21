import {
  Free, Either, askLLM, executeTool, respond, approve, delegate, observe, getState
} from './op.js'
import fp from '../lib/fun-fp.js'

const { Maybe } = fp

// --- Reference resolution (Maybe로 안전한 lookup) ---

const safeLookup = (arr, index) =>
  Maybe.fromNullable(Array.isArray(arr) ? arr[index] : undefined)

const resolveRefs = (refs, results) => {
  if (!refs || !Array.isArray(refs)) return []
  return refs
    .map(i => safeLookup(results, i - 1))
    .filter(m => m.isJust())
    .map(m => m.value)
}

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

const resolveToolArgs = (args, results) => {
  if (!args || typeof args !== 'object') return args
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) =>
      [k, typeof v === 'string' ? resolveStringRefs(v, results) : v])
  )
}

// --- Step validation (Either) ---

// --- 공통 검증 헬퍼 ---

const isPositiveInt = (v) => Number.isInteger(v) && v >= 1

const isPositiveIntArray = (v) =>
  Array.isArray(v) && v.every(isPositiveInt)

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
    validateStep(step),
  )

// --- parsePlan ---
// 반환: Free<Either<string, results[]>>
// 잘못된 step이 있으면 즉시 Left로 short-circuit

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

export { parsePlan, stepToOp, opHandlers, validateStep, argValidators, isPositiveInt, isPositiveIntArray, resolveRefs, resolveStringRefs, resolveToolArgs, safeLookup }
