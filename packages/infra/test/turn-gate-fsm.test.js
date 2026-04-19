import { step } from '@presence/core/core/fsm/fsm.js'
import { turnGateFSM, cancelling } from '@presence/infra/infra/fsm/turn-gate-fsm.js'
import { TurnState } from '@presence/core/core/policies.js'
import { assert, assertDeepEqual, summary } from '../../../test/lib/assert.js'

console.log('turnGateFSM tests')

// 실제 runtime 관찰 일치는 Phase 4 swap 시점 책임.
// 이 테스트는 FSM 의 도메인 논리만 검증한다.
// 상태 shape 은 TurnState ADT + 내부 전용 cancelling 태그.

const IDLE = TurnState.idle()
const working = (input) => TurnState.working(input)

// --- Accept paths ---

// A1. idle + chat → working + turn.started (payload 에 turnState 포함)
{
  const r = step(turnGateFSM, IDLE, { type: 'chat', payload: { input: 'hi' } })
  assert(r.isRight(), 'A1: idle+chat accept')
  assertDeepEqual(r.value.state, working('hi'), 'A1: state=working(hi)')
  assertDeepEqual(
    r.value.events,
    [{ topic: 'turn.started', payload: { turnState: working('hi') } }],
    'A1: turn.started payload 에 turnState'
  )
}

// A2. working + cancel → cancelling + cancel.requested (payload: turnState + abort)
{
  const r = step(turnGateFSM, working('q'), { type: 'cancel' })
  assert(r.isRight(), 'A2: working+cancel accept')
  assertDeepEqual(r.value.state, cancelling('q'), 'A2: state=cancelling(q)')
  assertDeepEqual(
    r.value.events,
    [{ topic: 'cancel.requested', payload: { turnState: cancelling('q'), abort: true } }],
    'A2: cancel.requested payload 에 turnState + abort'
  )
}

// A3. working + complete → idle + turn.completed
{
  const r = step(turnGateFSM, working('q'), { type: 'complete' })
  assert(r.isRight(), 'A3: working+complete accept')
  assertDeepEqual(r.value.state, IDLE, 'A3: state=idle')
  assertDeepEqual(
    r.value.events,
    [{ topic: 'turn.completed', payload: { turnState: IDLE } }],
    'A3: turn.completed payload'
  )
}

// A4. working + failure → idle + turn.failed
{
  const r = step(turnGateFSM, working('q'), { type: 'failure' })
  assert(r.isRight(), 'A4: working+failure accept')
  assertDeepEqual(r.value.state, IDLE, 'A4: state=idle')
  assertDeepEqual(
    r.value.events,
    [{ topic: 'turn.failed', payload: { turnState: IDLE } }],
    'A4: turn.failed payload'
  )
}

// A5. cancelling + abort_complete → idle + turn.cancelled
{
  const r = step(turnGateFSM, cancelling('q'), { type: 'abort_complete' })
  assert(r.isRight(), 'A5: cancelling+abort_complete accept')
  assertDeepEqual(r.value.state, IDLE, 'A5: state=idle')
  assertDeepEqual(
    r.value.events,
    [{ topic: 'turn.cancelled', payload: { turnState: IDLE } }],
    'A5: turn.cancelled payload'
  )
}

// --- Explicit rejections ---

// E1. working + chat → Left session-busy
{
  const r = step(turnGateFSM, working('q'), { type: 'chat' })
  assert(r.isLeft(), 'E1: working+chat reject')
  assertDeepEqual(r.value.primaryReason, 'session-busy', 'E1: primary=session-busy')
  assertDeepEqual(r.value.reasons[0].kind, 'explicit', 'E1: kind=explicit')
}

// E2. cancelling + chat → Left cancelling-in-progress
{
  const r = step(turnGateFSM, cancelling('q'), { type: 'chat' })
  assert(r.isLeft(), 'E2: cancelling+chat reject')
  assertDeepEqual(r.value.primaryReason, 'cancelling-in-progress',
    'E2: primary=cancelling-in-progress')
  assertDeepEqual(r.value.reasons[0].kind, 'explicit', 'E2: kind=explicit')
}

// E3. cancelling + cancel → Left already-cancelling
{
  const r = step(turnGateFSM, cancelling('q'), { type: 'cancel' })
  assert(r.isLeft(), 'E3: cancelling+cancel reject')
  assertDeepEqual(r.value.primaryReason, 'already-cancelling',
    'E3: primary=already-cancelling')
  assertDeepEqual(r.value.reasons[0].kind, 'explicit', 'E3: kind=explicit')
}

// --- no-match ---

// N1. idle + unknown → Left unhandled
{
  const r = step(turnGateFSM, IDLE, { type: 'unknown' })
  assert(r.isLeft(), 'N1: idle+unknown → Left')
  assertDeepEqual(r.value.primaryReason, 'unhandled', 'N1: primary=unhandled')
  assertDeepEqual(r.value.reasons[0].kind, 'no-match', 'N1: kind=no-match')
}

// N2. idle + cancel → Left unhandled
{
  const r = step(turnGateFSM, IDLE, { type: 'cancel' })
  assert(r.isLeft(), 'N2: idle+cancel → Left')
  assertDeepEqual(r.value.primaryReason, 'unhandled', 'N2: primary=unhandled')
}

// N3. idle + complete / failure / abort_complete 도 unhandled
{
  for (const type of ['complete', 'failure', 'abort_complete']) {
    const r = step(turnGateFSM, IDLE, { type })
    assert(r.isLeft() && r.value.primaryReason === 'unhandled',
      `N3: idle+${type} → unhandled`)
  }
}

// --- FSM metadata ---

// M1. id / initial / kind
{
  assertDeepEqual(turnGateFSM.id, 'turnGate', 'M1: id=turnGate')
  assertDeepEqual(turnGateFSM.initial, IDLE, 'M1: initial=idle (TurnState ADT)')
  assertDeepEqual(turnGateFSM.kind, 'atomic', 'M1: kind=atomic')
}

// --- 전이 사이클 시나리오 ---

// C1. idle → working → cancelling → idle (취소 사이클)
{
  let state = IDLE
  const allEvents = []
  for (const cmd of [
    { type: 'chat', payload: { input: 'hi' } },
    { type: 'cancel' },
    { type: 'abort_complete' },
  ]) {
    const r = step(turnGateFSM, state, cmd)
    assert(r.isRight(), `C1: ${state.tag} + ${cmd.type} accept`)
    state = r.value.state
    for (const ev of r.value.events) allEvents.push(ev)
  }
  assertDeepEqual(state, IDLE, 'C1: 최종 idle 복귀')
  assertDeepEqual(
    allEvents.map((e) => e.topic),
    ['turn.started', 'cancel.requested', 'turn.cancelled'],
    'C1: 이벤트 시퀀스'
  )
}

// C2. idle → working → idle (정상 완료 사이클)
{
  let state = IDLE
  const allEvents = []
  for (const cmd of [
    { type: 'chat', payload: { input: 'hi' } },
    { type: 'complete' },
  ]) {
    const r = step(turnGateFSM, state, cmd)
    assert(r.isRight(), `C2: ${state.tag} + ${cmd.type} accept`)
    state = r.value.state
    for (const ev of r.value.events) allEvents.push(ev)
  }
  assertDeepEqual(state, IDLE, 'C2: idle 복귀')
  assertDeepEqual(
    allEvents.map((e) => e.topic),
    ['turn.started', 'turn.completed'],
    'C2: 이벤트 시퀀스'
  )
}

summary()
