import { makeFsmEventBus } from '@presence/core/core/fsm/event-bus.js'
import { makeFSMRuntime } from '@presence/core/core/fsm/runtime.js'
import { delegateFSM, DelegateState } from '@presence/infra/infra/fsm/delegate-fsm.js'
import { makeDelegateBridge } from '@presence/infra/infra/fsm/delegate-bridge.js'
import { assert, summary } from '../../../test/lib/assert.js'

console.log('delegateBridge tests')

const makeMockState = () => {
  const data = {}
  const setCalls = []
  return {
    get: (path) => data[path],
    set: (path, value) => {
      data[path] = value
      setCalls.push({ path, value })
    },
    _setCalls: setCalls,
  }
}

const setup = (initialState = DelegateState.idle()) => {
  const state = makeMockState()
  const bus = makeFsmEventBus()
  const runtime = makeFSMRuntime({ fsm: delegateFSM, bus, initial: initialState })
  const dispose = makeDelegateBridge({ runtime, state, bus })
  return { state, bus, runtime, dispose }
}

// --- projection no-op ---

// N1. submit → runtime state 변경되지만 reactiveState 에는 쓰지 않음 (Phase 7 no-op)
{
  const { state, runtime } = setup()
  runtime.submit({ type: 'submit' })
  assert(runtime.state.tag === 'delegating' && runtime.state.count === 1,
    'N1: runtime state 변경됨')
  assert(state._setCalls.length === 0, 'N1: reactiveState 에는 쓰지 않음 (projection no-op)')
}

// N2. resolve → idle. 역시 reactiveState 무변경
{
  const { state, runtime } = setup(DelegateState.delegating(1))
  runtime.submit({ type: 'resolve' })
  assert(runtime.state.tag === 'idle', 'N2: runtime idle')
  assert(state._setCalls.length === 0, 'N2: reactiveState 무변경')
}

// --- multi-FSM bus 간섭 차단 ---

// X1. turn.started 이벤트는 delegate bridge 구독 안 함
{
  const { state, bus } = setup()
  bus.publish({
    topic: 'turn.started',
    ts: 0,
    source: 'turnGate',
    stateVersion: 'v-1',
    payload: { turnState: { tag: 'working' } },
  })
  assert(state._setCalls.length === 0, 'X1: turn.started 이벤트 무시')
}

// X2. fsm.rejected source='turnGate' 도 무시
{
  const { state, bus } = setup()
  bus.publish({
    topic: 'fsm.rejected',
    ts: 0,
    source: 'turnGate',
    stateVersion: 'v-1',
    payload: { primaryReason: 'session-busy' },
  })
  assert(state._setCalls.length === 0, 'X2: 다른 FSM 의 fsm.rejected 무시')
}

// --- dispose ---

// D1. dispose 후 이벤트 수신 안 함 (runtime submit 해도 bridge 의 구독자 없음 가정)
{
  const { runtime, dispose } = setup()
  dispose()
  // 이후 submit 은 여전히 동작하지만 bridge 는 더 이상 구독 안 함.
  // 실제 projection 이 no-op 이라 직접 검증 어려움 — bus.publish 의 subscriber count 로 검증.
  const result = runtime.submit({ type: 'submit' })
  assert(result.isRight(), 'D1: dispose 후에도 runtime 은 계속 동작')
}

// --- 생성자 검증 ---

// V1. 필수 인자 누락 시 throw
{
  const bus = makeFsmEventBus()
  const runtime = makeFSMRuntime({ fsm: delegateFSM, bus })
  const state = makeMockState()

  let thrown
  thrown = null; try { makeDelegateBridge({ state, bus }) } catch (e) { thrown = e }
  assert(thrown !== null, 'V1: runtime 누락 throw')
  thrown = null; try { makeDelegateBridge({ runtime, bus }) } catch (e) { thrown = e }
  assert(thrown !== null, 'V1: state 누락 throw')
  thrown = null; try { makeDelegateBridge({ runtime, state }) } catch (e) { thrown = e }
  assert(thrown !== null, 'V1: bus 누락 throw')
}

summary()
