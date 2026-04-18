import { step } from '@presence/core/core/fsm/fsm.js'
import { turnGateFSM } from '@presence/infra/infra/fsm/turn-gate-fsm.js'
import { assert, assertDeepEqual, summary } from '../../../test/lib/assert.js'

console.log('turnGateFSM tests')

// 실제 runtime 관찰 일치는 Phase 4 swap 시점 책임.
// 이 테스트는 FSM 의 도메인 논리만 검증한다.

// --- Accept paths ---

// A1. idle + chat → working + turn.started
{
  const r = step(turnGateFSM, 'idle', { type: 'chat' })
  assert(r.isRight(), 'A1: idle+chat accept')
  assertDeepEqual(r.value.state, 'working', 'A1: state=working')
  assertDeepEqual(r.value.events, [{ topic: 'turn.started' }], 'A1: turn.started')
}

// A2. working + cancel → cancelling + cancel.requested
{
  const r = step(turnGateFSM, 'working', { type: 'cancel' })
  assert(r.isRight(), 'A2: working+cancel accept')
  assertDeepEqual(r.value.state, 'cancelling', 'A2: state=cancelling')
  assertDeepEqual(r.value.events, [{ topic: 'cancel.requested' }], 'A2: cancel.requested')
}

// A3. working + complete → idle + turn.completed
{
  const r = step(turnGateFSM, 'working', { type: 'complete' })
  assert(r.isRight(), 'A3: working+complete accept')
  assertDeepEqual(r.value.state, 'idle', 'A3: state=idle')
  assertDeepEqual(r.value.events, [{ topic: 'turn.completed' }], 'A3: turn.completed')
}

// A4. working + failure → idle + turn.failed
{
  const r = step(turnGateFSM, 'working', { type: 'failure' })
  assert(r.isRight(), 'A4: working+failure accept')
  assertDeepEqual(r.value.state, 'idle', 'A4: state=idle')
  assertDeepEqual(r.value.events, [{ topic: 'turn.failed' }], 'A4: turn.failed')
}

// A5. cancelling + abort_complete → idle + turn.cancelled
{
  const r = step(turnGateFSM, 'cancelling', { type: 'abort_complete' })
  assert(r.isRight(), 'A5: cancelling+abort_complete accept')
  assertDeepEqual(r.value.state, 'idle', 'A5: state=idle')
  assertDeepEqual(r.value.events, [{ topic: 'turn.cancelled' }], 'A5: turn.cancelled')
}

// --- Explicit rejections ---

// E1. working + chat → Left session-busy
{
  const r = step(turnGateFSM, 'working', { type: 'chat' })
  assert(r.isLeft(), 'E1: working+chat reject')
  assertDeepEqual(r.value.primaryReason, 'session-busy', 'E1: primary=session-busy')
  assertDeepEqual(r.value.reasons[0].kind, 'explicit', 'E1: kind=explicit')
}

// E2. cancelling + chat → Left cancelling-in-progress
{
  const r = step(turnGateFSM, 'cancelling', { type: 'chat' })
  assert(r.isLeft(), 'E2: cancelling+chat reject')
  assertDeepEqual(r.value.primaryReason, 'cancelling-in-progress',
    'E2: primary=cancelling-in-progress')
  assertDeepEqual(r.value.reasons[0].kind, 'explicit', 'E2: kind=explicit')
}

// E3. cancelling + cancel → Left already-cancelling
{
  const r = step(turnGateFSM, 'cancelling', { type: 'cancel' })
  assert(r.isLeft(), 'E3: cancelling+cancel reject')
  assertDeepEqual(r.value.primaryReason, 'already-cancelling',
    'E3: primary=already-cancelling')
  assertDeepEqual(r.value.reasons[0].kind, 'explicit', 'E3: kind=explicit')
}

// --- no-match ---

// N1. idle + unknown → Left unhandled
{
  const r = step(turnGateFSM, 'idle', { type: 'unknown' })
  assert(r.isLeft(), 'N1: idle+unknown → Left')
  assertDeepEqual(r.value.primaryReason, 'unhandled', 'N1: primary=unhandled')
  assertDeepEqual(r.value.reasons[0].kind, 'no-match', 'N1: kind=no-match')
}

// N2. idle + cancel → Left unhandled (idle 에서 cancel 정의 없음)
{
  const r = step(turnGateFSM, 'idle', { type: 'cancel' })
  assert(r.isLeft(), 'N2: idle+cancel → Left')
  assertDeepEqual(r.value.primaryReason, 'unhandled', 'N2: primary=unhandled')
}

// N3. idle + complete / failure / abort_complete 도 unhandled
{
  for (const type of ['complete', 'failure', 'abort_complete']) {
    const r = step(turnGateFSM, 'idle', { type })
    assert(r.isLeft() && r.value.primaryReason === 'unhandled',
      `N3: idle+${type} → unhandled`)
  }
}

// --- FSM metadata ---

// M1. id / initial / kind
{
  assertDeepEqual(turnGateFSM.id, 'turnGate', 'M1: id=turnGate')
  assertDeepEqual(turnGateFSM.initial, 'idle', 'M1: initial=idle')
  assertDeepEqual(turnGateFSM.kind, 'atomic', 'M1: kind=atomic')
}

// --- 전이 사이클 시나리오 ---

// C1. idle → working → cancelling → idle (취소 사이클)
{
  let state = 'idle'
  const allEvents = []
  for (const cmd of [{ type: 'chat' }, { type: 'cancel' }, { type: 'abort_complete' }]) {
    const r = step(turnGateFSM, state, cmd)
    assert(r.isRight(), `C1: ${state} + ${cmd.type} accept`)
    state = r.value.state
    for (const ev of r.value.events) allEvents.push(ev)
  }
  assertDeepEqual(state, 'idle', 'C1: 최종 idle 복귀')
  assertDeepEqual(
    allEvents.map((e) => e.topic),
    ['turn.started', 'cancel.requested', 'turn.cancelled'],
    'C1: 이벤트 시퀀스'
  )
}

// C2. idle → working → idle (정상 완료 사이클)
{
  let state = 'idle'
  const allEvents = []
  for (const cmd of [{ type: 'chat' }, { type: 'complete' }]) {
    const r = step(turnGateFSM, state, cmd)
    assert(r.isRight(), `C2: ${state} + ${cmd.type} accept`)
    state = r.value.state
    for (const ev of r.value.events) allEvents.push(ev)
  }
  assertDeepEqual(state, 'idle', 'C2: idle 복귀')
  assertDeepEqual(
    allEvents.map((e) => e.topic),
    ['turn.started', 'turn.completed'],
    'C2: 이벤트 시퀀스'
  )
}

summary()
