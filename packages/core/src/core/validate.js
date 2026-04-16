import fp from '../lib/fun-fp.js'
const { Either } = fp
import { ops } from './op-handler.js'
import { ERROR_KIND, TurnError } from './policies.js'

const validateStep = (step) => {
  if (!step || typeof step !== 'object') return Either.Left(`invalid step: ${String(step)}`)
  if (!step.op || typeof step.op !== 'string') return Either.Left('step.op must be a non-empty string')
  if (!ops[step.op]) return Either.Left(`unknown op: ${step.op}`)
  return ops[step.op].validate(step.args || {}).chain(() => Either.Right(step))
}

// LLM 응답에서 JSON 부분만 추출 (Qwen 등 <think> 태그 포함 모델 대응)
const extractJson = (str) => {
  if (typeof str !== 'string') return str
  const idx = str.indexOf('{')
  if (idx <= 0) return str
  return str.slice(idx)
}

const safeJsonParse = (str) =>
  Either.fold(
    e => Either.Left(TurnError(e.message || String(e), ERROR_KIND.PLANNER_PARSE)),
    parsed => Either.Right(parsed),
    Either.catch(() => typeof str === 'string' ? JSON.parse(extractJson(str)) : str),
  )

const validateExecArgs = (step, tools) => {
  if (step.op !== 'EXEC' || !tools || tools.length === 0) return Either.Right(true)
  const a = step.args || {}
  const toolDef = tools.find(t => t.name === a.tool)
  if (!toolDef) return Either.Left(TurnError(`EXEC: unknown tool: ${a.tool}`, ERROR_KIND.PLANNER_SHAPE))

  const required = toolDef.parameters?.required || []
  if (required.length === 0) return Either.Right(true)

  const resolvedArgs = a.tool_args || (() => {
    const { tool, ...rest } = a
    return rest
  })()
  const missing = required.filter(r => resolvedArgs[r] == null && resolvedArgs[r] !== 0 && resolvedArgs[r] !== false)
  return missing.length === 0
    ? Either.Right(true)
    : Either.Left(TurnError(`EXEC ${a.tool}: missing required args: ${missing.join(', ')}`, ERROR_KIND.PLANNER_SHAPE))
}

const validateRefRange = (step, index) => {
  const a = step.args || {}
  if (step.op === 'RESPOND' && a.ref != null && a.ref > index) {
    return Either.Left(TurnError(
      `RESPOND ref=${a.ref} exceeds available steps (${index}). ref must be <= ${index}.`,
      ERROR_KIND.PLANNER_SHAPE))
  }
  if (step.op === 'ASK_LLM' && Array.isArray(a.ctx)) {
    const invalid = a.ctx.find(c => c > index)
    if (invalid != null) {
      return Either.Left(TurnError(
        `ASK_LLM ctx=[${a.ctx}] references step ${invalid} but only ${index} steps precede it.`,
        ERROR_KIND.PLANNER_SHAPE))
    }
  }
  return Either.Right(true)
}

// 구조 + args + range → Either Kleisli 합성
const validateStepFull = (step, index, tools) => {
  const pipeline = Either.pipeK(
    () => Either.fold(
      err => Either.Left(TurnError(err, ERROR_KIND.PLANNER_SHAPE)),
      () => Either.Right(step),
      validateStep(step),
    ),
    () => validateExecArgs(step, tools),
    () => validateRefRange(step, index),
  )
  return pipeline(null)
}

const validatePlan = (plan, { tools = [] } = {}) => {
  if (plan == null || typeof plan !== 'object' || Array.isArray(plan)) {
    return Either.Left(TurnError(
      `planner response is not a valid object: ${String(plan)}`, ERROR_KIND.PLANNER_SHAPE))
  }
  if (plan.type === 'direct_response') {
    return typeof plan.message === 'string'
      ? Either.Right(plan)
      : Either.Left(TurnError('direct_response requires a valid message (string)', ERROR_KIND.PLANNER_SHAPE))
  }
  if (plan.type === 'plan') {
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
      return Either.Left(TurnError('plan requires a non-empty steps array', ERROR_KIND.PLANNER_SHAPE))
    }
    const respondIndex = plan.steps.findIndex(s => s?.op === 'RESPOND')
    if (respondIndex !== -1 && respondIndex !== plan.steps.length - 1) {
      return Either.Left(TurnError(
        `RESPOND must be the last step in a plan (found at index ${respondIndex} of ${plan.steps.length}).`,
        ERROR_KIND.PLANNER_SHAPE))
    }
    // KG-13: ASK_LLM 이 마지막 스텝이면 RESPOND 로 결과를 전달해야 한다.
    // RESPOND 없으면 ASK_LLM 출력이 폐기되고 재계획 iteration 이 시작되어 낭비.
    const lastStep = plan.steps[plan.steps.length - 1]
    if (lastStep?.op === 'ASK_LLM' && respondIndex === -1) {
      return Either.Left(TurnError(
        'Plan ends with ASK_LLM but has no RESPOND. Add RESPOND as the last step to deliver the ASK_LLM result, or use direct_response instead.',
        ERROR_KIND.PLANNER_SHAPE))
    }
    return plan.steps.reduce(
      (acc, step, i) => acc.chain(() => validateStepFull(step, i, tools)),
      Either.Right(true),
    ).chain(() => Either.Right(plan))
  }
  return Either.Left(TurnError(
    `invalid planner response type: ${plan.type ?? 'undefined'}. Expected "direct_response" or "plan" with steps.`,
    ERROR_KIND.PLANNER_SHAPE))
}

export {
  extractJson, safeJsonParse, validateStep,
  validateExecArgs, validateRefRange, validateStepFull, validatePlan,
}
