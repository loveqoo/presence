import { step } from '@presence/core/core/fsm/fsm.js'
import { approveFSM, ApproveState } from '@presence/infra/infra/fsm/approve-fsm.js'
import { assert, assertDeepEqual, summary } from '../../../test/lib/assert.js'

console.log('approveFSM tests')

const IDLE = ApproveState.idle()
const awaiting = (desc) => ApproveState.awaitingApproval(desc)

// --- Accept paths ---

// A1. idle + request_approval(description) → awaitingApproval(description)
{
  const r = step(approveFSM, IDLE, { type: 'request_approval', payload: { description: '파일 삭제' } })
  assert(r.isRight(), 'A1: idle+request_approval accept')
  assertDeepEqual(r.value.state, awaiting('파일 삭제'), 'A1: state=awaitingApproval(파일 삭제)')
  assertDeepEqual(
    r.value.events,
    [{ topic: 'approve.requested', payload: { approveState: awaiting('파일 삭제') } }],
    'A1: approve.requested payload'
  )
}

// A2. awaitingApproval + approve → idle (approved: true)
{
  const r = step(approveFSM, awaiting('tool xyz'), { type: 'approve' })
  assert(r.isRight(), 'A2: awaitingApproval+approve accept')
  assertDeepEqual(r.value.state, IDLE, 'A2: state=idle')
  assertDeepEqual(
    r.value.events,
    [{ topic: 'approve.resolved', payload: { approveState: IDLE, approved: true } }],
    'A2: approve.resolved approved=true'
  )
}

// A3. awaitingApproval + reject → idle (approved: false)
{
  const r = step(approveFSM, awaiting('xyz'), { type: 'reject' })
  assert(r.isRight(), 'A3: awaitingApproval+reject accept')
  assertDeepEqual(r.value.state, IDLE, 'A3: state=idle')
  assertDeepEqual(
    r.value.events,
    [{ topic: 'approve.resolved', payload: { approveState: IDLE, approved: false } }],
    'A3: approve.resolved approved=false'
  )
}

// A4. awaitingApproval + cancel_approval → idle (approved: false, cancelled)
{
  const r = step(approveFSM, awaiting('xyz'), { type: 'cancel_approval' })
  assert(r.isRight(), 'A4: awaitingApproval+cancel_approval accept')
  assertDeepEqual(r.value.state, IDLE, 'A4: state=idle')
  assertDeepEqual(
    r.value.events,
    [{ topic: 'approve.cancelled', payload: { approveState: IDLE, approved: false } }],
    'A4: approve.cancelled'
  )
}

// --- Explicit rejections ---

// E1. awaitingApproval + request_approval → Left nested-approval (single-pending 방어)
{
  const r = step(approveFSM, awaiting('old'), { type: 'request_approval', payload: { description: 'new' } })
  assert(r.isLeft(), 'E1: awaitingApproval+request_approval reject')
  assertDeepEqual(r.value.primaryReason, 'nested-approval', 'E1: primary=nested-approval')
  assertDeepEqual(r.value.reasons[0].kind, 'explicit', 'E1: kind=explicit')
}

// --- no-match ---

// N1. idle + approve → Left unhandled (pending 없음)
{
  const r = step(approveFSM, IDLE, { type: 'approve' })
  assert(r.isLeft(), 'N1: idle+approve → Left')
  assertDeepEqual(r.value.primaryReason, 'unhandled', 'N1: primary=unhandled')
  assertDeepEqual(r.value.reasons[0].kind, 'no-match', 'N1: kind=no-match')
}

// N2. idle + reject / cancel_approval 도 unhandled
{
  for (const type of ['reject', 'cancel_approval']) {
    const r = step(approveFSM, IDLE, { type })
    assert(r.isLeft() && r.value.primaryReason === 'unhandled',
      `N2: idle+${type} → unhandled`)
  }
}

// N3. idle + unknown command
{
  const r = step(approveFSM, IDLE, { type: 'something_else' })
  assert(r.isLeft(), 'N3: idle+unknown → Left')
  assertDeepEqual(r.value.primaryReason, 'unhandled', 'N3: primary=unhandled')
}

// --- FSM metadata ---

// M1. id / initial / kind
{
  assertDeepEqual(approveFSM.id, 'approve', 'M1: id=approve')
  assertDeepEqual(approveFSM.initial, IDLE, 'M1: initial=idle')
  assertDeepEqual(approveFSM.kind, 'atomic', 'M1: kind=atomic')
}

// --- 사이클 시나리오 ---

// C1. idle → awaitingApproval → idle (approved)
{
  let state = IDLE
  const events = []
  for (const cmd of [
    { type: 'request_approval', payload: { description: 'rm file' } },
    { type: 'approve' },
  ]) {
    const r = step(approveFSM, state, cmd)
    assert(r.isRight(), `C1: ${state.tag} + ${cmd.type} accept`)
    state = r.value.state
    for (const ev of r.value.events) events.push(ev)
  }
  assertDeepEqual(state, IDLE, 'C1: idle 복귀')
  assertDeepEqual(
    events.map((e) => e.topic),
    ['approve.requested', 'approve.resolved'],
    'C1: 이벤트 시퀀스'
  )
  assertDeepEqual(events[1].payload.approved, true, 'C1: approved=true')
}

// C2. idle → awaitingApproval → idle (cancelled via cancel_approval)
{
  let state = IDLE
  const events = []
  for (const cmd of [
    { type: 'request_approval', payload: { description: 'dangerous' } },
    { type: 'cancel_approval' },
  ]) {
    const r = step(approveFSM, state, cmd)
    assert(r.isRight(), `C2: ${state.tag} + ${cmd.type} accept`)
    state = r.value.state
    for (const ev of r.value.events) events.push(ev)
  }
  assertDeepEqual(state, IDLE, 'C2: cancel 사이클 후 idle 복귀')
  assertDeepEqual(events[1].topic, 'approve.cancelled', 'C2: 마지막 이벤트는 cancelled')
  assertDeepEqual(events[1].payload.approved, false, 'C2: approved=false')
}

summary()
