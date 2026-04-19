// =============================================================================
// turnGateBridge — turnGateFSM runtime 과 reactiveState 연결 다리
//
// 설계: plan purring-beaming-horizon Phase 4 + Phase 6 (exact topic 구독 전환)
//
// 역할:
//   - FsmEventBus 에 6 개 topic 을 각각 구독 (Phase 6: wildcard 제거 — 다른 FSM bridge 와
//     같은 bus 공유 시 간섭 방지. stateVersion 통합 추적 유지)
//     topic 목록: turn.started, cancel.requested, turn.completed, turn.failed,
//                 turn.cancelled, fsm.rejected
//   - 이벤트의 payload.turnState 를 reactiveState.TURN_STATE 에 반영 (dumb forwarder)
//   - 이벤트의 payload.abort 신호로 AbortController.abort() 호출
//   - stale 이벤트 (event.stateVersion ≠ runtime.stateVersion) 시
//     runtime.state 로 reconcile (구독자 데이터 최신화)
//   - cancelling 태그는 reactiveState 로는 working 으로 projection
//     (외부 소비자 10곳이 tag === 'working'/'idle' 만 체크하므로 wire format 유지)
//   - 같은 값 재할당 방지 (hook 중복 발동 차단)
//
// FP-RULE-EXCEPTION: approved in plan purring-beaming-horizon (fsm/ factory + actor boundary)
// =============================================================================

import { STATE_PATH, TurnState } from '@presence/core/core/policies.js'
import { CANCELLING } from './turn-gate-fsm.js'

// turnGateFSM 이 emit 하는 topic + fsm.rejected (source 로 필터).
const TURN_GATE_TOPICS = Object.freeze([
  'turn.started',
  'cancel.requested',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
])
const REJECTION_TOPIC = 'fsm.rejected'
const TURN_GATE_FSM_ID = 'turnGate'

// tag 와 input 동일 여부로 얕은 비교.
const sameTurnState = (a, b) => {
  if (a === b) return true
  if (!a || !b) return false
  return a.tag === b.tag && a.input === b.input
}

// FSM 의 cancelling 태그는 reactiveState 로는 working 으로 보여준다.
const projectForReactiveState = (turnState) => {
  if (turnState && turnState.tag === CANCELLING) {
    return TurnState.working(turnState.input)
  }
  return turnState
}

function makeTurnGateBridge({ runtime, state, bus, getAbortController }) {
  if (!runtime) throw new Error('makeTurnGateBridge: `runtime` required')
  if (!state) throw new Error('makeTurnGateBridge: `state` required')
  if (!bus) throw new Error('makeTurnGateBridge: `bus` required')
  if (typeof getAbortController !== 'function') {
    throw new Error('makeTurnGateBridge: `getAbortController` must be a function')
  }

  const applyProjection = (nextTurnState) => {
    if (nextTurnState === undefined || nextTurnState === null) return
    const projected = projectForReactiveState(nextTurnState)
    const current = state.get(STATE_PATH.TURN_STATE)
    if (sameTurnState(current, projected)) return  // hook 중복 발동 차단
    state.set(STATE_PATH.TURN_STATE, projected)
  }

  const handler = (event) => {
    // fsm.rejected 는 source 로 turnGate 것만 처리 (다른 FSM 의 rejection 무시)
    if (event.topic === REJECTION_TOPIC && event.source !== TURN_GATE_FSM_ID) return
    if (event.stateVersion !== runtime.stateVersion) {
      // stale — 현재 runtime.state 로 reconcile (구독자 데이터 최신화)
      applyProjection(runtime.state)
      return
    }
    if (event.payload && event.payload.turnState !== undefined) {
      applyProjection(event.payload.turnState)
    }
    if (event.payload && event.payload.abort) {
      const controller = getAbortController()
      if (controller && !controller.signal.aborted) controller.abort()
    }
  }

  // exact topic 각각 구독 (Phase 6 — wildcard 제거로 multi-FSM bus 공유 시 간섭 차단)
  const unsubs = [
    ...TURN_GATE_TOPICS.map((topic) => bus.subscribe(topic, handler)),
    bus.subscribe(REJECTION_TOPIC, handler),
  ]
  return () => { for (const u of unsubs) u() }
}

export { makeTurnGateBridge, sameTurnState, projectForReactiveState }
