import fp from '../lib/fun-fp.js'
const { Either } = fp
import { ops } from './opHandler.js'
import { ERROR_KIND, TurnError } from './policies.js'

const validateStep = (step) => {
  if (!step || typeof step !== 'object') return Either.Left(`유효하지 않은 step: ${String(step)}`)
  if (!step.op || typeof step.op !== 'string') return Either.Left(`step에 op이 없거나 문자열이 아닙니다.`)
  if (!ops[step.op]) return Either.Left(`알 수 없는 op: ${step.op}`)
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
      `플래너 응답이 올바른 객체가 아닙니다: ${String(plan)}`, ERROR_KIND.PLANNER_SHAPE))
  }
  if (plan.type === 'direct_response') {
    return typeof plan.message === 'string'
      ? Either.Right(plan)
      : Either.Left(TurnError('direct_response에 유효한 message(string)가 필요합니다.', ERROR_KIND.PLANNER_SHAPE))
  }
  if (plan.type === 'plan') {
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
      return Either.Left(TurnError('plan에 비어있지 않은 steps 배열이 필요합니다.', ERROR_KIND.PLANNER_SHAPE))
    }
    const respondIndex = plan.steps.findIndex(s => s?.op === 'RESPOND')
    if (respondIndex !== -1 && respondIndex !== plan.steps.length - 1) {
      return Either.Left(TurnError(
        `RESPOND must be the last step in a plan (found at index ${respondIndex} of ${plan.steps.length}).`,
        ERROR_KIND.PLANNER_SHAPE))
    }
    return plan.steps.reduce(
      (acc, step, i) => acc.chain(() => validateStepFull(step, i, tools)),
      Either.Right(true),
    ).chain(() => Either.Right(plan))
  }
  return Either.Left(TurnError(
    `플래너 응답 형식이 잘못되었습니다 (type: ${plan.type ?? 'undefined'}). `
    + `"direct_response" 또는 steps가 포함된 "plan"이어야 합니다.`,
    ERROR_KIND.PLANNER_SHAPE))
}

export {
  extractJson, safeJsonParse, validateStep,
  validateExecArgs, validateRefRange, validateStepFull, validatePlan,
}
