import { step } from '@presence/core/core/fsm/fsm.js'
import { sessionFSM } from '@presence/infra/infra/fsm/session-fsm.js'
import { TurnState } from '@presence/core/core/policies.js'
import { ApproveState } from '@presence/infra/infra/fsm/approve-fsm.js'
import { DelegateState } from '@presence/infra/infra/fsm/delegate-fsm.js'
import { assert, assertDeepEqual, summary } from '../../../test/lib/assert.js'

console.log('sessionFSM tests')

const INITIAL = sessionFSM.initial

// --- 초기 상태 ---

// I1. initial state shape
{
  assertDeepEqual(INITIAL, {
    turnGate: TurnState.idle(),
    approve: ApproveState.idle(),
    delegate: DelegateState.idle(),
  }, 'I1: 초기 상태 = 모든 축 idle')
  assertDeepEqual(sessionFSM.kind, 'product', 'I1: kind=product')
  assertDeepEqual(sessionFSM.keys, ['turnGate', 'approve', 'delegate'], 'I1: keys 순서')
}

// --- 단일 축 command dispatch (product dispatch 검증) ---

// D1. chat → turnGate 만 accept
{
  const r = step(sessionFSM, INITIAL, { type: 'chat', payload: { input: 'hi' } })
  assert(r.isRight(), 'D1: chat accept')
  assertDeepEqual(r.value.state.turnGate, TurnState.working('hi'),
    'D1: turnGate = working(hi)')
  assertDeepEqual(r.value.state.approve, ApproveState.idle(), 'D1: approve 그대로')
  assertDeepEqual(r.value.state.delegate, DelegateState.idle(), 'D1: delegate 그대로')
  assertDeepEqual(r.value.events[0].topic, 'turn.started', 'D1: turn.started 이벤트')
}

// D2. request_approval → approve 만 accept
{
  const r = step(sessionFSM, INITIAL, { type: 'request_approval', payload: { description: '삭제' } })
  assert(r.isRight(), 'D2: request_approval accept')
  assertDeepEqual(r.value.state.turnGate, TurnState.idle(), 'D2: turnGate 그대로')
  assertDeepEqual(r.value.state.approve, ApproveState.awaitingApproval('삭제'),
    'D2: approve = awaitingApproval')
  assertDeepEqual(r.value.events[0].topic, 'approve.requested', 'D2: approve.requested 이벤트')
}

// D3. submit → delegate 만 accept
{
  const r = step(sessionFSM, INITIAL, { type: 'submit' })
  assert(r.isRight(), 'D3: submit accept')
  assertDeepEqual(r.value.state.delegate, DelegateState.delegating(1),
    'D3: delegate = delegating(1)')
  assertDeepEqual(r.value.events[0].topic, 'delegate.submitted', 'D3: 이벤트')
}

// --- 동시 다축 상태 ---

// S1. 순차적으로 세 축 다른 상태로
{
  let state = INITIAL
  let r = step(sessionFSM, state, { type: 'chat', payload: { input: 'q' } })
  state = r.value.state
  r = step(sessionFSM, state, { type: 'request_approval', payload: { description: 'x' } })
  state = r.value.state
  r = step(sessionFSM, state, { type: 'submit' })
  state = r.value.state

  assertDeepEqual(state.turnGate, TurnState.working('q'), 'S1: turnGate=working')
  assertDeepEqual(state.approve, ApproveState.awaitingApproval('x'), 'S1: approve=awaitingApproval')
  assertDeepEqual(state.delegate, DelegateState.delegating(1), 'S1: delegate=delegating(1)')
}

// --- R1 정책 검증 (명시적 거부 우선) ---

// R1-1. turnGate=working 상태에서 chat → turnGate 가 explicit reject
//       (session-busy). R1 에 따라 전체 Left (approve/delegate no-match 무관).
{
  const workingState = {
    turnGate: TurnState.working('prev'),
    approve: ApproveState.idle(),
    delegate: DelegateState.idle(),
  }
  const r = step(sessionFSM, workingState, { type: 'chat', payload: { input: 'new' } })
  assert(r.isLeft(), 'R1-1: explicit reject → 전체 Left')
  assertDeepEqual(r.value.primaryReason, 'session-busy', 'R1-1: primary=session-busy')
}

// R1-2. approve=awaitingApproval 에서 cancel → approve 가 수락한 command 아님
//       (approve 의 cancel_approval 만 받음). cancel 은 turnGate 의 것.
//       turnGate=idle 이면 cancel no-match. 전체 Left unhandled.
{
  const s = {
    turnGate: TurnState.idle(),
    approve: ApproveState.awaitingApproval('x'),
    delegate: DelegateState.idle(),
  }
  const r = step(sessionFSM, s, { type: 'cancel' })
  assert(r.isLeft(), 'R1-2: 아무도 수락 안 함 → Left')
  assertDeepEqual(r.value.primaryReason, 'unhandled', 'R1-2: primary=unhandled')
}

// --- slot isolation ---

// I2. 한 축의 전이가 다른 축의 state 를 바꾸지 않음
{
  const s = {
    turnGate: TurnState.working('q'),
    approve: ApproveState.awaitingApproval('desc'),
    delegate: DelegateState.delegating(2),
  }
  const r = step(sessionFSM, s, { type: 'resolve' })  // delegate 만 accept
  assert(r.isRight(), 'I2: resolve accept')
  assertDeepEqual(r.value.state.turnGate, TurnState.working('q'), 'I2: turnGate 불변')
  assertDeepEqual(r.value.state.approve, ApproveState.awaitingApproval('desc'), 'I2: approve 불변')
  assertDeepEqual(r.value.state.delegate, DelegateState.delegating(1), 'I2: delegate 변경')
}

// --- event 순서 (key 순서 = turnGate → approve → delegate) ---

// E1. 동시에 여러 축 emit 되는 일은 현재 FSM 정의상 없음 (각 command 는 한 축만).
//     그러나 future-proof 확인: events 배열이 key 순서로 collect 되는지는
//     fsm-product.test.js 에서 커버됨. 여기선 단일 축 emit 만 확인.
{
  const r = step(sessionFSM, INITIAL, { type: 'chat', payload: { input: 'hi' } })
  assertDeepEqual(r.value.events.length, 1, 'E1: chat 은 1 이벤트')
  // source 는 step() 직접 호출에서는 안 붙음 (runtime 이 enrichEvent 에서 주입).
  // product 는 child FSM events 를 그대로 concat.
  assertDeepEqual(r.value.events[0].topic, 'turn.started', 'E1: topic from turnGate child')
}

summary()
