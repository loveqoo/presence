import { Free, Either, askLLM, executeTool, respond, getState } from './op.js'
import { beginTurn, finishSuccess, finishFailure, ErrorInfo, ERROR_KIND } from './agent.js'
import { buildMemoryPrompt } from './prompt.js'
import { t } from '../i18n/index.js'

// --- 메시지 포맷 헬퍼 ---

const appendToolRound = (messages, toolCalls, result) => [
  ...messages,
  { role: 'assistant', tool_calls: toolCalls },
  {
    role: 'tool',
    tool_call_id: toolCalls[0].id,
    content: typeof result === 'string' ? result : JSON.stringify(result),
  },
]

const buildInitialMessages = (input, memories) => {
  const memorySection = buildMemoryPrompt(memories)
  const messages = []
  if (memorySection) {
    messages.push({ role: 'system', content: memorySection })
  }
  messages.push({ role: 'user', content: input })
  return messages
}

// --- response 분류 (Either로 분기) ---
// Right(text)   → 최종 답변
// Left(ErrorInfo) → 실패
// null           → tool call을 담은 중간 상태 (loop 계속)

const classifyResponse = (response) => {
  if (response?.type !== 'tool_calls') {
    const text = typeof response === 'string' ? response : String(response)
    return Either.Right(text)
  }
  if (!Array.isArray(response.toolCalls) || response.toolCalls.length !== 1) {
    const count = response.toolCalls?.length ?? 0
    return Either.Left(ErrorInfo(
      `ReAct는 현재 단일 tool call만 지원합니다. (받은 수: ${count})`,
      ERROR_KIND.REACT_MULTI_TOOL,
    ))
  }
  return null // valid tool call → loop continues
}

// --- ReAct 루프 (순수 Free 프로그램) ---
// 반환: Free<Either<ErrorInfo, string>>

const createReactLoop = ({ tools = [], maxSteps = 10 } = {}) => (input, memories) => {
  const loop = (messages, step) => {
    if (step >= maxSteps) {
      return Free.of(Either.Left(
        ErrorInfo('최대 실행 단계에 도달했습니다.', ERROR_KIND.REACT_MAX_STEPS),
      ))
    }

    return askLLM({ messages, tools }).chain(response => {
      const classified = classifyResponse(response)

      // Either.Left (실패) 또는 Either.Right (최종 답변) → 루프 종료
      if (classified !== null) return Free.of(classified)

      // tool call 실행 → 다음 iteration
      const call = response.toolCalls[0]
      const name = call.function.name
      const args = JSON.parse(call.function.arguments || '{}')

      return executeTool(name, args)
        .chain(result => loop(appendToolRound(messages, response.toolCalls, result), step + 1))
    })
  }

  return loop(buildInitialMessages(input, memories), 0)
}

// --- ReAct 턴 (상태 전이 포함) ---

const createReactTurn = ({ tools = [], maxSteps = 10 } = {}) => {
  const runLoop = createReactLoop({ tools, maxSteps })

  return (input) =>
    beginTurn(input)
      .chain(() => getState('context.memories'))
      .chain(memories => runLoop(input, memories || []))
      .chain(either => Either.fold(
        error => respond(t('error.agent_error', { message: error.message }))
          .chain(msg => finishFailure(input, error, msg)),
        value => respond(value)
          .chain(msg => finishSuccess(input, msg)),
        either,
      ))
}

export { createReactLoop, createReactTurn, appendToolRound, buildInitialMessages, classifyResponse }
