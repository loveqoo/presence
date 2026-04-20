import { Agent } from '@presence/core/core/agent.js'
import { Executor } from '@presence/core/core/executor.js'
import { makeFsmEventBus } from '@presence/core/core/fsm/event-bus.js'
import { makeFSMRuntime } from '@presence/core/core/fsm/runtime.js'
import { turnGateFSM } from '@presence/infra/infra/fsm/turn-gate-fsm.js'
import { makeTurnGateBridge } from '@presence/infra/infra/fsm/turn-gate-bridge.js'

// =============================================================================
// Test helper: Agent + turnGate FSM runtime + bridge 자동 조립.
//
// production 에서는 session (ephemeral-inits) 이 runtime 과 bridge 를 주입하지만,
// 단위 테스트는 Agent 를 직접 생성하는 경우가 많음. 이 helper 가 그 gap 을
// 메워서 executor 의 TURN_STATE 경로가 항상 runtime 경유가 되도록 한다.
//
// - state 가 있으면: fsmBus + turnGateRuntime + bridge 자동 생성 후 Agent 에 주입
// - state 가 없으면 (smoke/constructor 테스트 등): 그냥 Agent 생성
// - turnGateRuntime 이 이미 opts 에 있으면 그대로 사용 (상위 커스텀)
// =============================================================================

function wireTurnGate(state) {
  const bus = makeFsmEventBus()
  const turnGateRuntime = makeFSMRuntime({ fsm: turnGateFSM, bus })
  if (state) {
    makeTurnGateBridge({
      runtime: turnGateRuntime,
      state,
      bus,
      getAbortController: () => null,
    })
  }
  return turnGateRuntime
}

function makeTestAgent(opts = {}) {
  const { state, turnGateRuntime: provided } = opts
  if (!state || provided) return new Agent(opts)
  const turnGateRuntime = wireTurnGate(state)
  return new Agent({ ...opts, turnGateRuntime })
}

// Executor 직접 테스트용 — runtime 자동 주입.
function makeTestExecutor(opts = {}) {
  const { state, turnGateRuntime: provided } = opts
  if (provided) return new Executor(opts)
  const turnGateRuntime = wireTurnGate(state)
  return new Executor({ ...opts, turnGateRuntime })
}

export { makeTestAgent, makeTestExecutor }
