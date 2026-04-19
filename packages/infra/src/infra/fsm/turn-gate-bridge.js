// =============================================================================
// turnGateBridge — turnGateFSM runtime 과 reactiveState 연결 다리
//
// 설계: plan purring-beaming-horizon Phase 4
//
// 역할:
//   - FsmEventBus 에 구독자로 등록 (bus.subscribe('*', handler))
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

  const unsubscribe = bus.subscribe('*', handler)

  // dispose: 등록 해제
  return unsubscribe
}

export { makeTurnGateBridge, sameTurnState, projectForReactiveState }
