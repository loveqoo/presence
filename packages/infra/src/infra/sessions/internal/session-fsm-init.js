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
import { turnGateFSM } from '../../fsm/turn-gate-fsm.js'
import { makeTurnGateBridge } from '../../fsm/turn-gate-bridge.js'
import { approveFSM } from '../../fsm/approve-fsm.js'
import { makeApproveBridge } from '../../fsm/approve-bridge.js'
import { delegateFSM } from '../../fsm/delegate-fsm.js'
import { makeDelegateBridge } from '../../fsm/delegate-bridge.js'

function makeSessionFsm({ state, turnController }) {
  const fsmBus = makeFsmEventBus()

  const turnGateRuntime = makeFSMRuntime({ fsm: turnGateFSM, bus: fsmBus })
  const turnGateBridgeDispose = makeTurnGateBridge({
    runtime: turnGateRuntime,
    state,
    bus: fsmBus,
    getAbortController: () => turnController?.turnAbort,
  })

  const approveRuntime = makeFSMRuntime({ fsm: approveFSM, bus: fsmBus })
  const approveBridgeDispose = makeApproveBridge({
    runtime: approveRuntime,
    state,
    bus: fsmBus,
    resolvePending: (approved) => turnController?.resolveApproval(approved),
  })

  const delegateRuntime = makeFSMRuntime({ fsm: delegateFSM, bus: fsmBus })
  const delegateBridgeDispose = makeDelegateBridge({
    runtime: delegateRuntime,
    state,
    bus: fsmBus,
  })

  const disposeAll = () => {
    turnGateBridgeDispose()
    approveBridgeDispose()
    delegateBridgeDispose()
  }

  return { fsmBus, turnGateRuntime, approveRuntime, delegateRuntime, disposeAll }
}

export { makeSessionFsm }
