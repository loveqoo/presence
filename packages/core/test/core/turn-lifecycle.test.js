import { initI18n } from '@presence/infra/i18n'
await initI18n('ko')
import { TurnLifecycle } from '@presence/core/core/turn-lifecycle.js'
import { STATE_PATH, HISTORY_ENTRY_TYPE, ERROR_KIND, TURN_SOURCE } from '@presence/core/core/policies.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { assert, summary } from '../../../../test/lib/assert.js'

console.log('TurnLifecycle tests')

const makeState = (history = []) => createOriginState({
  turnState: { tag: 'idle' },
  context: { conversationHistory: history },
})

// --- recordAbortSync ---

// A1. empty history → turn cancelled + SYSTEM cancel
{
  const state = makeState()
  const lifecycle = new TurnLifecycle(k => k === 'history.cancel_notice' ? '사용자가 응답을 취소했습니다.' : k)
  lifecycle.recordAbortSync(state, { input: 'hello' })
  const history = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
  assert(history.length === 2, 'recordAbortSync: 2 entries added')
  assert(history[0].input === 'hello', 'recordAbortSync: turn entry input')
  assert(history[0].cancelled === true, 'recordAbortSync: turn cancelled=true')
  assert(history[0].failed === true, 'recordAbortSync: turn failed=true')
  assert(history[0].errorKind === ERROR_KIND.ABORTED, 'recordAbortSync: errorKind=ABORTED')
  assert(history[1].type === HISTORY_ENTRY_TYPE.SYSTEM, 'recordAbortSync: SYSTEM entry appended after')
  assert(history[1].tag === 'cancel', 'recordAbortSync: SYSTEM tag=cancel')
}

// A2. seq 연속성 (같은 인스턴스)
{
  const state = makeState()
  const lifecycle = new TurnLifecycle()
  lifecycle.recordAbortSync(state, { input: 'a' })
  lifecycle.recordAbortSync(state, { input: 'b' })
  const history = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
  const ids = history.map(e => e.id)
  const uniqueIds = new Set(ids)
  assert(uniqueIds.size === ids.length, 'recordAbortSync: ids unique across calls')
}

// --- recordFailureSync ---

// F1. 일반 실패 → turn entry 만 (SYSTEM 없음)
{
  const state = makeState()
  const lifecycle = new TurnLifecycle()
  lifecycle.recordFailureSync(state, { input: 'q' }, { kind: 'interpreter', message: 'boom' })
  const history = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
  assert(history.length === 1, 'recordFailureSync: 1 entry (no SYSTEM)')
  assert(history[0].failed === true, 'recordFailureSync: failed=true')
  assert(history[0].errorKind === 'interpreter', 'recordFailureSync: errorKind preserved')
  assert(history[0].cancelled === undefined, 'recordFailureSync: not cancelled')
}

// --- appendSystemEntrySync ---

// S1. SYSTEM entry append
{
  const state = makeState()
  const lifecycle = new TurnLifecycle()
  lifecycle.appendSystemEntrySync(state, { content: 'approved: write', tag: 'approve' })
  const history = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
  assert(history.length === 1, 'appendSystemEntrySync: 1 entry')
  assert(history[0].type === HISTORY_ENTRY_TYPE.SYSTEM, 'appendSystemEntrySync: type=system')
  assert(history[0].content === 'approved: write', 'appendSystemEntrySync: content preserved')
  assert(history[0].tag === 'approve', 'appendSystemEntrySync: tag preserved')
}

// --- markLastTurnCancelledSync ---

// M1. 뒤에서부터 첫 turn 탐색 (INV-CNC-1)
{
  const state = makeState([
    { id: 'h-1', input: 'q1', output: 'a1' },
    { id: 'h-2', type: HISTORY_ENTRY_TYPE.SYSTEM, content: 'approved', tag: 'approve' },
  ])
  const lifecycle = new TurnLifecycle()
  lifecycle.markLastTurnCancelledSync(state)
  const history = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
  assert(history[0].cancelled === true, 'markLastTurnCancelledSync: turn marked even when SYSTEM is last')
  assert(history[1].cancelled === undefined, 'markLastTurnCancelledSync: SYSTEM unchanged')
}

// M2. 이미 cancelled → no-op
{
  const state = makeState([{ id: 'h-1', input: 'q', output: 'a', cancelled: true }])
  const lifecycle = new TurnLifecycle()
  const before = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
  lifecycle.markLastTurnCancelledSync(state)
  const after = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
  assert(after === before, 'markLastTurnCancelledSync: already cancelled → no state change')
}

// M3. turn 없음 → no-op
{
  const state = makeState([
    { id: 'h-1', type: HISTORY_ENTRY_TYPE.SYSTEM, content: 's1' },
  ])
  const lifecycle = new TurnLifecycle()
  const before = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
  lifecycle.markLastTurnCancelledSync(state)
  const after = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
  assert(after === before, 'markLastTurnCancelledSync: no turn → no change')
}

// --- Free API 호환성 (기존 success/failure) ---

// L1. success Free program returns response
{
  const lifecycle = new TurnLifecycle()
  const turn = { input: 'hi', source: TURN_SOURCE.USER }
  const program = lifecycle.success(turn, 'hello back')
  assert(program && typeof program.chain === 'function', 'success: returns Free program')
}

// L2. failure Free program returns response
{
  const lifecycle = new TurnLifecycle()
  const turn = { input: 'hi', source: TURN_SOURCE.USER }
  const program = lifecycle.failure(turn, { kind: 'test', message: 'err' }, 'fallback')
  assert(program && typeof program.chain === 'function', 'failure: returns Free program')
}

summary()
