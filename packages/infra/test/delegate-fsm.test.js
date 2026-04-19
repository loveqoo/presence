import { step } from '@presence/core/core/fsm/fsm.js'
import { delegateFSM, DelegateState } from '@presence/infra/infra/fsm/delegate-fsm.js'
import { assert, assertDeepEqual, summary } from '../../../test/lib/assert.js'

console.log('delegateFSM tests')

const IDLE = DelegateState.idle()
const delegating = (n) => DelegateState.delegating(n)

// --- Accept paths ---

// A1. idle + submit → delegating(1)
{
  const r = step(delegateFSM, IDLE, { type: 'submit' })
  assert(r.isRight(), 'A1: idle+submit accept')
  assertDeepEqual(r.value.state, delegating(1), 'A1: state=delegating(1)')
  assertDeepEqual(r.value.events[0].topic, 'delegate.submitted', 'A1: topic')
  assertDeepEqual(r.value.events[0].payload.delegateState, delegating(1), 'A1: payload')
}

// A2. delegating(1) + submit → delegating(2)
{
  const r = step(delegateFSM, delegating(1), { type: 'submit' })
  assert(r.isRight(), 'A2: count 증가')
  assertDeepEqual(r.value.state, delegating(2), 'A2: state=delegating(2)')
}

// A3. delegating(3) + submit → delegating(4)
{
  const r = step(delegateFSM, delegating(3), { type: 'submit' })
  assertDeepEqual(r.value.state, delegating(4), 'A3: count 증가 3→4')
}

// A4. delegating(1) + resolve → idle
{
  const r = step(delegateFSM, delegating(1), { type: 'resolve' })
  assert(r.isRight(), 'A4: 마지막 resolve → idle')
  assertDeepEqual(r.value.state, IDLE, 'A4: state=idle')
  assertDeepEqual(r.value.events[0].topic, 'delegate.resolved', 'A4: topic')
  assertDeepEqual(r.value.events[0].payload.delegateState, IDLE, 'A4: payload idle')
}

// A5. delegating(2) + resolve → delegating(1)
{
  const r = step(delegateFSM, delegating(2), { type: 'resolve' })
  assertDeepEqual(r.value.state, delegating(1), 'A5: count 감소 2→1')
}

// A6. delegating(1) + fail → idle
{
  const r = step(delegateFSM, delegating(1), { type: 'fail' })
  assert(r.isRight(), 'A6: 마지막 fail → idle')
  assertDeepEqual(r.value.state, IDLE, 'A6: state=idle')
  assertDeepEqual(r.value.events[0].topic, 'delegate.failed', 'A6: topic')
}

// A7. delegating(3) + fail → delegating(2)
{
  const r = step(delegateFSM, delegating(3), { type: 'fail' })
  assertDeepEqual(r.value.state, delegating(2), 'A7: fail count 감소 3→2')
}

// --- Explicit rejections ---

// E1. idle + resolve → no-pending-delegation
{
  const r = step(delegateFSM, IDLE, { type: 'resolve' })
  assert(r.isLeft(), 'E1: idle+resolve reject')
  assertDeepEqual(r.value.primaryReason, 'no-pending-delegation', 'E1: primary')
  assertDeepEqual(r.value.reasons[0].kind, 'explicit', 'E1: kind=explicit')
}

// E2. idle + fail → no-pending-delegation
{
  const r = step(delegateFSM, IDLE, { type: 'fail' })
  assert(r.isLeft(), 'E2: idle+fail reject')
  assertDeepEqual(r.value.primaryReason, 'no-pending-delegation', 'E2: primary')
}

// --- no-match ---

// N1. unknown command
{
  const r = step(delegateFSM, IDLE, { type: 'unknown' })
  assert(r.isLeft() && r.value.primaryReason === 'unhandled', 'N1: unknown → unhandled')
}

// --- FSM metadata ---

// M1. id / initial / kind
{
  assertDeepEqual(delegateFSM.id, 'delegate', 'M1: id=delegate')
  assertDeepEqual(delegateFSM.initial, IDLE, 'M1: initial=idle')
  assertDeepEqual(delegateFSM.kind, 'atomic', 'M1: kind=atomic')
}

// --- 사이클 ---

// C1. idle → delegating(1) → delegating(2) → delegating(1) → idle
{
  let state = IDLE
  const events = []
  for (const cmd of [
    { type: 'submit' },
    { type: 'submit' },
    { type: 'resolve' },
    { type: 'resolve' },
  ]) {
    const r = step(delegateFSM, state, cmd)
    assert(r.isRight(), `C1: ${state.tag}(${state.count || 0}) + ${cmd.type}`)
    state = r.value.state
    for (const ev of r.value.events) events.push(ev.topic)
  }
  assertDeepEqual(state, IDLE, 'C1: 최종 idle 복귀')
  assertDeepEqual(
    events,
    ['delegate.submitted', 'delegate.submitted', 'delegate.resolved', 'delegate.resolved'],
    'C1: 이벤트 시퀀스'
  )
}

// C2. submit → fail (단일) → idle
{
  let state = IDLE
  const r1 = step(delegateFSM, state, { type: 'submit' })
  state = r1.value.state
  const r2 = step(delegateFSM, state, { type: 'fail' })
  assertDeepEqual(r2.value.state, IDLE, 'C2: submit → fail → idle')
}

summary()
