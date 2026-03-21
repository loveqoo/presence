import { Free, Either, askLLM, respond, updateState, getState, pipe } from './op.js'
import { parsePlan, validateStep } from './plan.js'
import { buildPlannerPrompt, buildFormatterPrompt, buildRetryPrompt } from './prompt.js'
import { t } from '../i18n/index.js'

// --- 상태 ADT ---

const PHASE = Object.freeze({ IDLE: 'idle', WORKING: 'working' })
const RESULT = Object.freeze({ SUCCESS: 'success', FAILURE: 'failure' })
const ERROR_KIND = Object.freeze({
  PLANNER_PARSE:   'planner_parse',
  PLANNER_SHAPE:   'planner_shape',
  INTERPRETER:     'interpreter',
  REACT_MAX_STEPS: 'react_max_steps',
  REACT_MULTI_TOOL:'react_multi_tool',
})

const Phase = {
  idle:    ()      => ({ tag: PHASE.IDLE }),
  working: (input) => ({ tag: PHASE.WORKING, input }),
}

const TurnResult = {
  success: (input, result)          => ({ tag: RESULT.SUCCESS, input, result }),
  failure: (input, error, response) => ({ tag: RESULT.FAILURE, input, error, response }),
}

const ErrorInfo = (message, kind) => ({ message, kind })

// --- 순수 파싱/검증 (Either) ---

const safeJsonParse = (str) =>
  Either.fold(
    e => Either.Left(ErrorInfo(e.message || String(e), ERROR_KIND.PLANNER_PARSE)),
    parsed => Either.Right(parsed),
    Either.catch(() => typeof str === 'string' ? JSON.parse(str) : str),
  )

// EXEC step의 tool_args를 도구 스키마 required와 대조
const validateExecArgs = (step, tools) => {
  if (step.op !== 'EXEC' || !tools || tools.length === 0) return null
  const a = step.args || {}
  const toolDef = tools.find(t => t.name === a.tool)
  if (!toolDef) return null // 도구 미등록은 실행 시 처리

  const required = toolDef.parameters?.required || []
  if (required.length === 0) return null

  // tool_args가 없으면 args에서 tool 제외한 나머지를 확인 (EXEC fallback과 동일 로직)
  const provided = Object.keys(a.tool_args || (() => {
    const { tool, ...rest } = a
    return rest
  })())
  const missing = required.filter(r => !provided.includes(r))
  return missing.length > 0
    ? `EXEC ${a.tool}: missing required args: ${missing.join(', ')}`
    : null
}

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
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]
      const result = validateStep(step)
      if (Either.isLeft(result)) {
        return Either.Left(ErrorInfo(result.value, ERROR_KIND.PLANNER_SHAPE))
      }
      // EXEC: tool_args 필수 인자 검증
      const execError = validateExecArgs(step, tools)
      if (execError) {
        return Either.Left(ErrorInfo(execError, ERROR_KIND.PLANNER_SHAPE))
      }
      // RESPOND/ASK_LLM: ref/ctx 범위 검증 (실행 전 정적 검증)
      const a = step.args || {}
      if (step.op === 'RESPOND' && a.ref != null && a.ref > i) {
        return Either.Left(ErrorInfo(
          `RESPOND ref=${a.ref} exceeds available steps (${i}). ref must be <= ${i}.`,
          ERROR_KIND.PLANNER_SHAPE))
      }
      if (step.op === 'ASK_LLM' && Array.isArray(a.ctx)) {
        const invalid = a.ctx.find(c => c > i)
        if (invalid != null) {
          return Either.Left(ErrorInfo(
            `ASK_LLM ctx=[${a.ctx}] references step ${invalid} but only ${i} steps precede it.`,
            ERROR_KIND.PLANNER_SHAPE))
        }
      }
    }
    return Either.Right(plan)
  }
  return Either.Left(ErrorInfo(
    `플래너 응답 형식이 잘못되었습니다 (type: ${plan.type ?? 'undefined'}). `
    + `"direct_response" 또는 steps가 포함된 "plan"이어야 합니다.`,
    ERROR_KIND.PLANNER_SHAPE))
}

// --- 상태 전이 함수 ---

const beginTurn = (input) =>
  updateState('turnState', Phase.working(input))

const finishSuccess = (input, result) =>
  updateState('lastTurn', TurnResult.success(input, result))
    .chain(() => updateState('turnState', Phase.idle()))
    .chain(() => Free.of(result))

const finishFailure = (input, error, response) =>
  updateState('lastTurn', TurnResult.failure(input, error, response))
    .chain(() => updateState('turnState', Phase.idle()))
    .chain(() => Free.of(response))

// --- 에러 → 실패 턴 종료 (공통 패턴) ---
const respondAndFail = (input, error) =>
  respond(t('error.agent_error', { message: error.message }))
    .chain(msg => finishFailure(input, error, msg))

// --- 플랜 실행 ---
const executePlan = (input, plan) => {
  if (plan.type === 'direct_response') {
    return respond(plan.message).chain(msg => finishSuccess(input, msg))
  }
  return parsePlan(plan)
    .chain(either => Either.fold(
      err => respondAndFail(input, ErrorInfo(err, ERROR_KIND.PLANNER_SHAPE)),
      results => {
        const formatterPrompt = buildFormatterPrompt(input, results)
        return askLLM({ messages: formatterPrompt.messages })
          .chain(response => respond(response))
          .chain(msg => finishSuccess(input, msg))
      },
      either,
    ))
}

const createAgentTurn = ({ tools = [], agents = [], persona = {}, responseFormatMode, maxRetries = 0 } = {}) => {
  return (input) =>
    beginTurn(input)
      .chain(() => getState('context.memories'))
      .chain(memories => {
        const prompt = buildPlannerPrompt({
          tools, agents, memories: memories || [], input, persona, responseFormatMode,
        })

        const attemptPlan = (currentPrompt, retriesLeft) =>
          askLLM({
            messages: currentPrompt.messages,
            responseFormat: currentPrompt.response_format,
          }).chain(planJson => {
            const parsed = safeJsonParse(planJson).chain(p => validatePlan(p, { tools }))

            return Either.fold(
              error => {
                if (retriesLeft <= 0) return respondAndFail(input, error)
                // 재시도: 상태로 진행 알림 → 수정 프롬프트로 재호출
                return updateState('_retry', {
                  attempt: maxRetries - retriesLeft + 1,
                  maxRetries,
                  error: error.message,
                }).chain(() =>
                  attemptPlan(buildRetryPrompt(currentPrompt, error.message), retriesLeft - 1)
                )
              },
              plan => executePlan(input, plan),
              parsed,
            )
          })

        return attemptPlan(prompt, maxRetries)
      })
}

// 인터프리터 예외 시 상태 복구 (순수 전이 함수)
const recoverFromFailure = (input, err) => ({
  lastTurn: TurnResult.failure(input, ErrorInfo(err.message || String(err), ERROR_KIND.INTERPRETER), null),
  turnState: Phase.idle(),
})

const applyRecovery = (state, recovery) => {
  for (const [key, value] of Object.entries(recovery)) state.set(key, value)
}

// 인터프리터 레벨 실패에 대한 안전망
const safeRunTurn = (interpreter, state) => async (program, input) => {
  try {
    return await Free.runWithTask(interpreter)(program)
  } catch (err) {
    if (state) applyRecovery(state, recoverFromFailure(input, err))
    throw err
  }
}

// --- 조립된 에이전트 ---
const createAgent = ({ buildTurn, tools, agents, persona, responseFormatMode, maxRetries, interpreter, state }) => {
  const turnBuilder = buildTurn || createAgentTurn({ tools, agents, persona, responseFormatMode, maxRetries })
  const execute = safeRunTurn(interpreter, state)

  const run = (input) => execute(turnBuilder(input), input)
  const program = (input) => turnBuilder(input)

  return { run, program }
}

export {
  createAgentTurn, safeRunTurn, createAgent, validatePlan, validateExecArgs, safeJsonParse,
  beginTurn, finishSuccess, finishFailure, respondAndFail,
  recoverFromFailure, applyRecovery,
  PHASE, RESULT, ERROR_KIND, Phase, TurnResult, ErrorInfo,
}
