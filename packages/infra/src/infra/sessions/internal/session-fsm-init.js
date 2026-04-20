// =============================================================================
// Session FSM 배선 — turnGateFSM + approveFSM runtime + bridge 조립 helper.
//
// ephemeral-inits.js 의 import 수를 줄이기 위해 fsm 관련 배선을 모았다.
// 단일 fsmBus 를 공유. 각 bridge 는 exact topic 구독으로 간섭 차단.
//
// 반환:
//   {
//     fsmBus, turnGateRuntime, approveRuntime,
//     disposeAll: () => void   // bridge 구독 해제
//   }
// =============================================================================

import { makeFsmEventBus } from '@presence/core/core/fsm/event-bus.js'
import { makeFSMRuntime } from '@presence/core/core/fsm/runtime.js'
import { sessionFSM } from '../../fsm/session-fsm.js'
import { makeTurnGateBridge } from '../../fsm/turn-gate-bridge.js'
import { makeApproveBridge } from '../../fsm/approve-bridge.js'
import { makeDelegateBridge } from '../../fsm/delegate-bridge.js'

// Phase 12: 3 개 독립 runtime → 1 sessionFSM product runtime 으로 단일화.
// 외부 인터페이스 (turnGateRuntime, approveRuntime, delegateRuntime) 는 유지하되
// 모두 같은 sessionRuntime 참조. bridge 는 childKey 로 자기 축의 state 만 본다.
// 장점:
//   - 단일 stateVersion — WS broadcast / 외부 refresh 계약 일관
//   - R1 정책 (explicit 우선) 이 세 축 통합으로 작동
//   - SessionFSM 정의가 Phase 8 에서 준비된 그대로 운영 경로로 진입
function makeSessionFsm({ state, turnController }) {
  const fsmBus = makeFsmEventBus()
  const sessionRuntime = makeFSMRuntime({ fsm: sessionFSM, bus: fsmBus })

  const turnGateBridgeDispose = makeTurnGateBridge({
    runtime: sessionRuntime,
    childKey: 'turnGate',
    state,
    bus: fsmBus,
    getAbortController: () => turnController?.turnAbort,
  })

  const approveBridgeDispose = makeApproveBridge({
    runtime: sessionRuntime,
    childKey: 'approve',
    state,
    bus: fsmBus,
    resolvePending: (approved) => turnController?.resolveApproval(approved),
  })

  const delegateBridgeDispose = makeDelegateBridge({
    runtime: sessionRuntime,
    childKey: 'delegate',
    state,
    bus: fsmBus,
  })

  const disposeAll = () => {
    turnGateBridgeDispose()
    approveBridgeDispose()
    delegateBridgeDispose()
  }

  // 기존 외부 인터페이스 유지 (ephemeral-inits / turnController / executor 가 기대하는
  // turnGateRuntime / approveRuntime / delegateRuntime 이름). 셋 다 같은 sessionRuntime.
  // product FSM 이 command type 으로 자동 dispatch 하므로 동일 ref 주입 문제 없음.
  return {
    fsmBus,
    sessionRuntime,
    turnGateRuntime: sessionRuntime,
    approveRuntime: sessionRuntime,
    delegateRuntime: sessionRuntime,
    disposeAll,
  }
}

export { makeSessionFsm }
