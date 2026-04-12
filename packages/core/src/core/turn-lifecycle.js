/**
 * Turn Lifecycle — 턴 완료/실패 처리 + 대화 히스토리 기록
 *
 * planner.js에서 분리. Planner가 소유하여 사용.
 */
import { respond, updateState, getState } from './op.js'
import { HISTORY, TurnState, TurnOutcome, TURN_SOURCE } from './policies.js'
import fp from '../lib/fun-fp.js'

const { Free, identity } = fp

class TurnLifecycle {
  constructor() { this.historySeq = 0 }

  truncate(text, max) {
    return text.length > max ? text.slice(0, max) + '...(truncated)' : text
  }

  finish(turn, turnResult, response, historyExtra = {}) {
    return updateState('_streaming', null)
      .chain(() => turn.source === TURN_SOURCE.USER
        ? getState('context.conversationHistory').chain(history => {
            const entry = {
              id: `h-${Date.now()}-${++this.historySeq}`,
              input: this.truncate(String(turn.input), HISTORY.MAX_INPUT_CHARS),
              output: this.truncate(String(response), HISTORY.MAX_OUTPUT_CHARS),
              ts: Date.now(),
              ...historyExtra,
            }
            const updated = [...(history || []), entry]
            const trimmed = updated.length > HISTORY.MAX_CONVERSATION
              ? updated.slice(-HISTORY.MAX_CONVERSATION)
              : updated
            return updateState('context.conversationHistory', trimmed)
          })
        : Free.of(null))
      .chain(() => updateState('lastTurn', turnResult))
      .chain(() => updateState('turnState', TurnState.idle()))
      .chain(() => Free.of(response))
  }

  success(turn, result) {
    return this.finish(turn, TurnOutcome.success(turn.input, result), result)
  }

  failure(turn, error, response) {
    return this.finish(turn, TurnOutcome.failure(turn.input, error, response), response, {
      failed: true, errorKind: error.kind || 'unknown', errorMessage: error.message || String(error),
    })
  }

  respondAndFail(turn, error, t = identity) {
    return respond(t('error.agent_error', { message: error.message }))
      .chain(msg => this.failure(turn, error, msg))
  }
}

export { TurnLifecycle }
