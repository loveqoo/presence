// =============================================================================
// approveFSM — 세션의 승인 (approval) 축 (idle / awaitingApproval)
//
// 설계: plan purring-beaming-horizon Phase 6
//
// 이 FSM 은 세션 내 승인 상태 한 축만 담당. turnGate 와 직교 축 — session 내
// 동시에 운영. bridge (approve-bridge) 가 reactiveState.APPROVE 로 projection.
//
// Single-pending 전제: 세션당 pending approval 은 1 개. 기존 Promise 단일
// resolve 구조 유지.
//
// State shape (TurnState ADT 패턴 준용):
//   - { tag: 'idle' }
//   - { tag: 'awaitingApproval', description }
//
// emit payload 는 구독자가 그대로 쓸 수 있는 값 + resolve 신호:
//   - request_approval → { approveState: awaitingApproval(desc) }
//   - approve         → { approveState: idle, approved: true }
//   - reject          → { approveState: idle, approved: false }
//   - cancel_approval → { approveState: idle, approved: false }
// =============================================================================

import { Transition, makeFSM } from '@presence/core/core/fsm/fsm.js'

const ApproveState = Object.freeze({
  idle: () => ({ tag: 'idle' }),
  awaitingApproval: (description) => ({ tag: 'awaitingApproval', description }),
})

const isIdle = (state) => state && state.tag === 'idle'
const isAwaiting = (state) => state && state.tag === 'awaitingApproval'

const transitions = [
  // --- Accept paths ---

  // idle + request_approval(description) → awaitingApproval(description)
  Transition({
    from: isIdle,
    on: 'request_approval',
    to: (s, c) => ApproveState.awaitingApproval(c.payload?.description),
    emit: (s, c) => [{
      topic: 'approve.requested',
      payload: { approveState: ApproveState.awaitingApproval(c.payload?.description) },
    }],
  }),

  // awaitingApproval + approve → idle (Promise resolve true)
  Transition({
    from: isAwaiting,
    on: 'approve',
    to: () => ApproveState.idle(),
    emit: [{
      topic: 'approve.resolved',
      payload: { approveState: ApproveState.idle(), approved: true },
    }],
  }),

  // awaitingApproval + reject → idle (Promise resolve false)
  Transition({
    from: isAwaiting,
    on: 'reject',
    to: () => ApproveState.idle(),
    emit: [{
      topic: 'approve.resolved',
      payload: { approveState: ApproveState.idle(), approved: false },
    }],
  }),

  // awaitingApproval + cancel_approval → idle (턴 종료/abort 시)
  Transition({
    from: isAwaiting,
    on: 'cancel_approval',
    to: () => ApproveState.idle(),
    emit: [{
      topic: 'approve.cancelled',
      payload: { approveState: ApproveState.idle(), approved: false },
    }],
  }),

  // --- Explicit rejections ---

  // awaitingApproval + request_approval — nested approval 방어 (single-pending 전제)
  Transition({ from: isAwaiting, on: 'request_approval', reject: 'nested-approval' }),
]

const approveFSM = makeFSM('approve', ApproveState.idle(), transitions)

export { approveFSM, ApproveState }
