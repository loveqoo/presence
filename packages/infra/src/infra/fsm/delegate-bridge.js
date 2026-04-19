// =============================================================================
// delegateBridge — delegateFSM runtime 과 reactiveState 연결 다리
//
// 설계: plan purring-beaming-horizon Phase 7
//
// 역할 (turn-gate / approve bridge 와 동일 구조):
//   - FsmEventBus 에 4 exact topic 구독: delegate.submitted, delegate.resolved,
//     delegate.failed, fsm.rejected
//   - fsm.rejected 는 source === 'delegate' 만 처리
//   - stale (event.stateVersion ≠ runtime.stateVersion) 시 runtime.state 로 reconcile
//
// Projection 정책 (Phase 7):
//   현재 reactiveState.delegates.pending 배열은 delegate-actor 가 authoritative
//   로 관리. delegateFSM 의 count 는 그림자 추적 (별도 reactiveState path 없음).
//   Bridge 는 구조 일관성을 위해 존재하며, 실제 state.set 은 no-op. 장래
//   관찰 path (예: delegates.fsmCount) 가 필요해지면 여기에 추가.
//
// FP-RULE-EXCEPTION: approved in plan purring-beaming-horizon (fsm/ factory + actor boundary)
// =============================================================================

const DELEGATE_TOPICS = Object.freeze([
  'delegate.submitted',
  'delegate.resolved',
  'delegate.failed',
])
const REJECTION_TOPIC = 'fsm.rejected'
const DELEGATE_FSM_ID = 'delegate'

function makeDelegateBridge({ runtime, state, bus }) {
  if (!runtime) throw new Error('makeDelegateBridge: `runtime` required')
  if (!state) throw new Error('makeDelegateBridge: `state` required')
  if (!bus) throw new Error('makeDelegateBridge: `bus` required')

  // Phase 7: projection 은 현재 no-op. runtime 이 authoritative FSM state 를 보유.
  // 구조 일관성 유지 (turn-gate / approve bridge 와 동일 interface) + 장래 확장 자리.
  // eslint-disable-next-line no-unused-vars
  const applyProjection = (_delegateState) => {
    // 장래 reactiveState.delegates.fsmCount 등 관찰 path 추가 시 여기에 state.set.
  }

  const handler = (event) => {
    if (event.topic === REJECTION_TOPIC && event.source !== DELEGATE_FSM_ID) return
    if (event.stateVersion !== runtime.stateVersion) {
      applyProjection(runtime.state)
      return
    }
    if (event.payload && event.payload.delegateState !== undefined) {
      applyProjection(event.payload.delegateState)
    }
  }

  const unsubs = [
    ...DELEGATE_TOPICS.map((topic) => bus.subscribe(topic, handler)),
    bus.subscribe(REJECTION_TOPIC, handler),
  ]
  return () => { for (const u of unsubs) u() }
}

export { makeDelegateBridge }
