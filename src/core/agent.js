import { Free, askLLM, respond, updateState, getState } from './op.js'
import { parsePlan } from './plan.js'
import { buildPlannerPrompt, buildFormatterPrompt } from './prompt.js'

// --- idle 복구 체인 (성공/실패 양쪽에서 재사용) ---
const settle = (response) =>
  updateState('lastResult', response)
    .chain(() => updateState('status', 'idle'))
    .chain(() => Free.of(response))

const settleError = (err) =>
  updateState('lastError', err.message || String(err))
    .chain(() => respond(`오류가 발생했습니다: ${err.message || err}`))
    .chain(msg => settle(msg))

const createAgentTurn = ({ tools = [], agents = [], persona = {} } = {}) => {
  return (input) =>
    updateState('status', 'working')
      .chain(() => updateState('currentInput', input))
      .chain(() => getState('context.memories'))
      .chain(memories => {
        const prompt = buildPlannerPrompt({
          tools, agents, memories: memories || [], input, persona
        })
        return askLLM({
          messages: prompt.messages,
          responseFormat: prompt.response_format,
        })
      })
      .chain(planJson => {
        let plan
        try {
          plan = typeof planJson === 'string' ? JSON.parse(planJson) : planJson
        } catch (e) {
          return settleError(e)
        }

        if (plan.type === 'direct_response') {
          return respond(plan.message).chain(settle)
        }

        return parsePlan(plan)
          .chain(results => {
            const formatterPrompt = buildFormatterPrompt(input, results)
            return askLLM({ messages: formatterPrompt.messages })
          })
          .chain(response => respond(response))
          .chain(settle)
      })
}

// 인터프리터 레벨 실패에 대한 안전망
const safeRunTurn = (interpreter, state) => async (program) => {
  try {
    return await Free.runWithTask(interpreter)(program)
  } catch (err) {
    if (state) {
      state.set('status', 'idle')
      state.set('lastError', err.message || String(err))
    }
    throw err
  }
}

// --- 조립된 에이전트: safeRunTurn이 항상 적용되는 유일한 실행 경로 ---
const createAgent = ({ tools, agents, persona, interpreter, state }) => {
  const buildTurn = createAgentTurn({ tools, agents, persona })
  const execute = safeRunTurn(interpreter, state)

  const run = (input) => execute(buildTurn(input))
  const program = (input) => buildTurn(input) // dry-run/테스트용 Free 프로그램 접근

  return { run, program }
}

export { createAgentTurn, safeRunTurn, createAgent }
