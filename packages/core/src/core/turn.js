import fp from '../lib/fun-fp.js'
const { Free, identity } = fp
import { respond, updateState, getState } from './op.js'
import { HISTORY, PHASE, RESULT, ERROR_KIND } from './policies.js'

let _historyCounter = 0
const nextHistoryId = () => `h-${Date.now()}-${++_historyCounter}`
const truncate = (text, max) =>
  text.length > max ? text.slice(0, max) + '...(truncated)' : text

const Phase = {
  idle:    ()      => ({ tag: PHASE.IDLE }),
  working: (input) => ({ tag: PHASE.WORKING, input }),
}

const TurnResult = {
  success: (input, result)          => ({ tag: RESULT.SUCCESS, input, result }),
  failure: (input, error, response) => ({ tag: RESULT.FAILURE, input, error, response }),
}

const ErrorInfo = (message, kind) => ({ message, kind })

// --- 턴 상태 전이 (Free 프로그램) ---

const beginTurn = (_input) => Free.of(null)

const appendHistory = (input, output, extra = {}) =>
  getState('context.conversationHistory').chain(history => {
    const entry = {
      id: nextHistoryId(),
      input: truncate(String(input), HISTORY.MAX_INPUT_CHARS),
      output: truncate(String(output), HISTORY.MAX_OUTPUT_CHARS),
      ts: Date.now(),
      ...extra,
    }
    const updated = [...(history || []), entry]
    const trimmed = updated.length > HISTORY.MAX_CONVERSATION
      ? updated.slice(-HISTORY.MAX_CONVERSATION)
      : updated
    return updateState('context.conversationHistory', trimmed)
  })

const finishSuccess = (input, result, { source } = {}) =>
  updateState('_streaming', null)
    .chain(() => source === 'user' ? appendHistory(input, result) : Free.of(null))
    .chain(() => updateState('lastTurn', TurnResult.success(input, result)))
    .chain(() => updateState('turnState', Phase.idle()))
    .chain(() => Free.of(result))

const finishFailure = (input, error, response, { source } = {}) =>
  updateState('_streaming', null)
    .chain(() => source === 'user'
      ? appendHistory(input, response, { failed: true, errorKind: error.kind || 'unknown', errorMessage: error.message || String(error) })
      : Free.of(null))
    .chain(() => updateState('lastTurn', TurnResult.failure(input, error, response)))
    .chain(() => updateState('turnState', Phase.idle()))
    .chain(() => Free.of(response))

const respondAndFail = (input, error, t = identity, { source } = {}) =>
  respond(t('error.agent_error', { message: error.message }))
    .chain(msg => finishFailure(input, error, msg, { source }))

export {
  PHASE, RESULT, ERROR_KIND,
  Phase, TurnResult, ErrorInfo,
  beginTurn, appendHistory, finishSuccess, finishFailure, respondAndFail,
  truncate,
}
