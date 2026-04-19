// =============================================================================
// sessionFSM — turnGate / approve / delegate 세 축의 product 합성.
//
// 설계: plan purring-beaming-horizon Phase 8
//
// State shape:
//   {
//     turnGate: TurnState,       // { tag: 'idle' | 'working' | 'cancelling', input? }
//     approve:  ApproveState,    // { tag: 'idle' | 'awaitingApproval', description? }
//     delegate: DelegateState,   // { tag: 'idle' | 'delegating', count? }
//   }
//
// Command 는 각 FSM 의 것을 그대로 사용. product 가 자동 dispatch:
//   - chat / complete / cancel / ... → turnGate 만 accept, 나머지 no-match
//   - request_approval / approve / reject / cancel_approval → approve 만 accept
//   - submit / resolve / fail → delegate 만 accept
//
// R1 규칙 (Phase 3 확정): 명시적 거부 > 수락. 한 child 이라도 explicit reject 면 전체 Left.
//   예: turnGate=working 상태에서 chat 명령 → turnGate 가 explicit reject('session-busy') →
//       전체 Left. approve/delegate 의 no-match 상태는 무관.
//
// Event 는 각 child 의 emit 을 key 순서로 concat 하여 순차 발행.
// =============================================================================

import { product } from '@presence/core/core/fsm/product.js'
import { turnGateFSM } from './turn-gate-fsm.js'
import { approveFSM } from './approve-fsm.js'
import { delegateFSM } from './delegate-fsm.js'

const sessionFSM = product({
  turnGate: turnGateFSM,
  approve: approveFSM,
  delegate: delegateFSM,
})

export { sessionFSM }
