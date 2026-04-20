// =============================================================================
// approveBridge — approveFSM runtime 과 reactiveState + Promise resolve 연결 다리
//
// 설계: plan purring-beaming-horizon Phase 6
//
// 역할:
//   - FsmEventBus 에 4 개 topic 구독 (wildcard 제거 — multi-FSM bus 간섭 차단):
//     approve.requested, approve.resolved, approve.cancelled, fsm.rejected
//   - 이벤트의 payload.approveState 를 reactiveState.APPROVE 에 projection:
//     { tag: 'idle' }                → null
//     { tag: 'awaitingApproval', description } → { description } (기존 wire format 유지)
//   - payload.approved 신호를 resolvePending(approved) 로 전달 (turnController
//     의 pending Promise 를 resolve + clear)
//   - stale (event.stateVersion ≠ runtime.stateVersion) 시 runtime.state 로 reconcile
//   - fsm.rejected 는 source === 'approve' 인 것만 처리 (다른 FSM rejection 무시)
//
// FP-RULE-EXCEPTION: approved in plan purring-beaming-horizon (fsm/ factory + actor boundary)
// =============================================================================

import { STATE_PATH } from '@presence/core/core/policies.js'

const APPROVE_TOPICS = Object.freeze([
  'approve.requested',
  'approve.resolved',
  'approve.cancelled',
])
const REJECTION_TOPIC = 'fsm.rejected'
const APPROVE_FSM_ID = 'approve'

// FSM state → reactiveState.APPROVE projection.
// 외부 (ApprovePrompt, SNAPSHOT_PATHS) 은 { description } 또는 null 만 본다.
const projectForReactiveState = (approveState) => {
  if (!approveState || approveState.tag === 'idle') return null
  if (approveState.tag === 'awaitingApproval') {
    return { description: approveState.description }
  }
  return null
}

const sameApprove = (a, b) => {
  if (a === b) return true
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  return a.description === b.description
}

function makeApproveBridge({ runtime, state, bus, resolvePending, childKey = null }) {
  if (!runtime) throw new Error('makeApproveBridge: `runtime` required')
  if (!state) throw new Error('makeApproveBridge: `state` required')
  if (!bus) throw new Error('makeApproveBridge: `bus` required')
  if (typeof resolvePending !== 'function') {
    throw new Error('makeApproveBridge: `resolvePending` must be a function')
  }

  // sessionRuntime 에서는 runtime.state[childKey] 로 child 추출. 없으면 atomic.
  const getChildState = () => childKey ? runtime.state?.[childKey] : runtime.state

  const applyProjection = (nextApproveState) => {
    const projected = projectForReactiveState(nextApproveState)
    const current = state.get(STATE_PATH.APPROVE)
    if (sameApprove(current, projected)) return  // hook 중복 발동 차단
    state.set(STATE_PATH.APPROVE, projected)
  }

  const handler = (event) => {
    // fsm.rejected 는 approve FSM 의 것만 처리 (다른 FSM 의 rejection 무시)
    if (event.topic === REJECTION_TOPIC && event.source !== APPROVE_FSM_ID) return
    if (event.stateVersion !== runtime.stateVersion) {
      // stale — 현재 runtime.state 로 reconcile
      applyProjection(getChildState())
      return
    }
    if (event.payload && event.payload.approveState !== undefined) {
      applyProjection(event.payload.approveState)
    }
    if (event.payload && event.payload.approved !== undefined) {
      resolvePending(event.payload.approved)
    }
  }

  const unsubs = [
    ...APPROVE_TOPICS.map((topic) => bus.subscribe(topic, handler)),
    bus.subscribe(REJECTION_TOPIC, handler),
  ]
  return () => { for (const u of unsubs) u() }
}

export { makeApproveBridge, projectForReactiveState, sameApprove }
