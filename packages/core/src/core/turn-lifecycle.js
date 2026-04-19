/**
 * Turn Lifecycle — 턴 완료/실패 처리 + 대화 히스토리 기록.
 *
 * Free API (planner 경로): recordSuccess, recordFailure, finish.
 * Imperative API (executor.recover / turn-controller 경로):
 *   recordAbortSync, recordFailureSync, appendSystemEntrySync, markLastTurnCancelledSync.
 *
 * 두 경로 모두 history-writer 의 pure helper (makeEntry/appendAndTrim/markLastTurnCancelled)
 * 를 공유해서 id/ts/truncate/trim 규칙을 단일화한다.
 *
 * 인스턴스 소유권: Session 생성자 최상단에서 1회 생성 → planner/executor/turn-controller 주입.
 */
import { respond, updateState, getState } from './op.js'
import { STATE_PATH, TurnState, TurnOutcome, TURN_SOURCE, HISTORY_ENTRY_TYPE, HISTORY_TAG, ERROR_KIND } from './policies.js'
import { makeEntry, appendAndTrim, markLastTurnCancelled, createSeq } from './history-writer.js'
import fp from '../lib/fun-fp.js'

const { Free, identity } = fp

class TurnLifecycle {
  constructor(t = identity) {
    this.seq = createSeq()
    this.t = t
  }

  // --- Free API (planner 경로) ---

  finish(turn, turnResult, response, historyExtra = {}) {
    // TURN_STATE 는 이 Free chain 이 쓰지 않는다 — executor.afterTurn 이
    // applyFinalState 후 turnGateRuntime.submit 을 호출하고 bridge 가 commit.
    return updateState(STATE_PATH.STREAMING, null)
      .chain(() => turn.source === TURN_SOURCE.USER
        ? this.#appendTurnEntryFree(turn, response, historyExtra)
        : Free.of(null))
      .chain(() => updateState(STATE_PATH.LAST_TURN, turnResult))
      .chain(() => updateState(STATE_PATH.PENDING_INPUT, null))
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

  respondAndFail(turn, error) {
    return respond(this.t('error.agent_error', { message: error.message }))
      .chain(msg => this.failure(turn, error, msg))
  }

  #appendTurnEntryFree(turn, response, extra) {
    return getState(STATE_PATH.CONTEXT_CONVERSATION_HISTORY).chain(history => {
      const entry = makeEntry({ input: turn.input, output: response, extra, seq: this.seq })
      return updateState(STATE_PATH.CONTEXT_CONVERSATION_HISTORY, appendAndTrim(history, entry))
    })
  }

  // --- Imperative API (executor.recover, turn-controller 경로) ---

  recordAbortSync(state, turn) {
    const history = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY) || []
    const turnEntry = makeEntry({
      input: turn.input, output: '',
      extra: { cancelled: true, failed: true, errorKind: ERROR_KIND.ABORTED },
      seq: this.seq,
    })
    const systemEntry = makeEntry({
      type: HISTORY_ENTRY_TYPE.SYSTEM,
      content: this.t('history.cancel_notice'),
      tag: HISTORY_TAG.CANCEL,
      seq: this.seq,
    })
    const withTurn = appendAndTrim(history, turnEntry)
    const withSystem = appendAndTrim(withTurn, systemEntry)
    state.set(STATE_PATH.CONTEXT_CONVERSATION_HISTORY, withSystem)
  }

  recordFailureSync(state, turn, error) {
    const history = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY) || []
    const entry = makeEntry({
      input: turn.input, output: '',
      extra: {
        failed: true,
        errorKind: error?.kind || ERROR_KIND.INTERPRETER,
        errorMessage: error?.message || String(error),
      },
      seq: this.seq,
    })
    state.set(STATE_PATH.CONTEXT_CONVERSATION_HISTORY, appendAndTrim(history, entry))
  }

  appendSystemEntrySync(state, params) {
    const { content, tag } = params
    const history = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY) || []
    const entry = makeEntry({ type: HISTORY_ENTRY_TYPE.SYSTEM, content, tag, seq: this.seq })
    state.set(STATE_PATH.CONTEXT_CONVERSATION_HISTORY, appendAndTrim(history, entry))
  }

  markLastTurnCancelledSync(state) {
    const history = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
    const next = markLastTurnCancelled(history)
    if (next !== history) state.set(STATE_PATH.CONTEXT_CONVERSATION_HISTORY, next)
  }
}

export { TurnLifecycle }
