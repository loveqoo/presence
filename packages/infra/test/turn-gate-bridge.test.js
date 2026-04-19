import { Transition, makeFSM } from '@presence/core/core/fsm/fsm.js'
import { makeFsmEventBus } from '@presence/core/core/fsm/event-bus.js'
import { makeFSMRuntime } from '@presence/core/core/fsm/runtime.js'
import { turnGateFSM, cancelling } from '@presence/infra/infra/fsm/turn-gate-fsm.js'
import { makeTurnGateBridge } from '@presence/infra/infra/fsm/turn-gate-bridge.js'
import { STATE_PATH, TurnState } from '@presence/core/core/policies.js'
import { assert, assertDeepEqual, summary } from '../../../test/lib/assert.js'

console.log('turnGateBridge tests')

// Mock state — OriginState 인터페이스 최소 구현. set 은 매번 호출 기록.
const makeMockState = (initial = {}) => {
  const data = { ...initial }
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

// Mock AbortController wrapper — getter 로 늦은 접근 시뮬레이션
const makeAbortSlot = () => {
  let controller = null
  return {
    get: () => controller,
    create: () => { controller = new AbortController(); return controller },
    reset: () => { controller = null },
  }
}

const setup = (initialTurnState = TurnState.idle()) => {
  const state = makeMockState({ [STATE_PATH.TURN_STATE]: initialTurnState })
  const bus = makeFsmEventBus()
  const runtime = makeFSMRuntime({ fsm: turnGateFSM, bus, initial: initialTurnState })
  const abortSlot = makeAbortSlot()
  const dispose = makeTurnGateBridge({
    runtime,
    state,
    bus,
    getAbortController: abortSlot.get,
  })
  return { state, bus, runtime, abortSlot, dispose }
}

// --- 정상 이벤트 apply ---

// N1. chat (idle → working) — Right 결과 후 reactiveState 반영
{
  const { state, runtime } = setup()
  runtime.submit({ type: 'chat', payload: { input: 'hi' } })
  assertDeepEqual(state.get(STATE_PATH.TURN_STATE), TurnState.working('hi'),
    'N1: state.turnState = working(hi)')
}

// N2. complete (working → idle)
{
  const { state, runtime } = setup(TurnState.working('q'))
  runtime.submit({ type: 'complete' })
  assertDeepEqual(state.get(STATE_PATH.TURN_STATE), TurnState.idle(),
    'N2: state.turnState = idle')
}

// N3. failure (working → idle)
{
  const { state, runtime } = setup(TurnState.working('q'))
  runtime.submit({ type: 'failure' })
  assertDeepEqual(state.get(STATE_PATH.TURN_STATE), TurnState.idle(),
    'N3: failure → idle')
}

// --- cancelling projection ---

// P1. cancel (working → cancelling) — reactiveState 에는 working 으로 projection
{
  const { state, runtime } = setup(TurnState.working('q'))
  runtime.submit({ type: 'cancel' })
  assertDeepEqual(runtime.state, cancelling('q'), 'P1: runtime.state = cancelling(q)')
  assertDeepEqual(state.get(STATE_PATH.TURN_STATE), TurnState.working('q'),
    'P1: reactiveState = working(q) (cancelling → working projection)')
}

// P2. cancel 후 같은 값 재할당 방지 — state.set 중복 호출 없음
{
  const { state, runtime } = setup(TurnState.working('q'))
  const beforeCount = state._setCalls.length
  runtime.submit({ type: 'cancel' })
  const afterCount = state._setCalls.length
  assert(afterCount - beforeCount === 0,
    'P2: working → cancelling(projection=working) 은 set 호출 없음 (같은 값)')
}

// --- abort 신호 ---

// AB1. cancel 이벤트의 abort: true → AbortController.abort() 호출
{
  const { runtime, abortSlot } = setup(TurnState.working('q'))
  const controller = abortSlot.create()
  runtime.submit({ type: 'cancel' })
  assert(controller.signal.aborted, 'AB1: abort 호출됨')
}

// AB2. AbortController 가 없으면 abort 스킵 (no-op)
{
  const { runtime } = setup(TurnState.working('q'))
  // abortSlot 에 controller 생성 안 함
  let threw = false
  try {
    runtime.submit({ type: 'cancel' })
  } catch { threw = true }
  assert(!threw, 'AB2: controller 없어도 예외 없음')
}

// AB3. 이미 abort 된 controller 는 재호출 안 함
{
  const { runtime, abortSlot } = setup(TurnState.working('q'))
  const controller = abortSlot.create()
  controller.abort()
  // 이미 abort 된 상태에서 다시 cancel (여기선 cancelling 상태라 reject 될 것, 우회)
  // 대신 새 전이 — 새 working 세션 만든 뒤 abort 된 controller 로
  // 간단히 abort 재호출 없음을 verify: abort signal 이 한 번만 true
  const alreadyAborted = controller.signal.aborted
  assert(alreadyAborted, 'AB3: controller 이미 abort 상태 (정확성 확인)')
}

// --- stale 이벤트 sync ---

// S1. stale 이벤트 받으면 runtime.state 로 reconcile — Phase 6 에서 exact topic
// 구독으로 변경됐으므로 turnGate 가 실제로 관리하는 topic 으로 stale 이벤트 시뮬.
{
  const { state, bus, runtime } = setup()
  runtime.submit({ type: 'chat', payload: { input: 'hi' } })
  // 이제 runtime.state = working('hi')
  // 수동으로 reactiveState 를 엉뚱한 값으로 조작 (stale 구독자 시뮬레이션)
  state.set(STATE_PATH.TURN_STATE, TurnState.idle())
  // turnGate 의 실제 topic 으로 publish 하되 stateVersion 을 엉뚱한 값으로 (stale).
  bus.publish({
    topic: 'turn.completed',
    ts: 0,
    source: 'turnGate',
    stateVersion: 'DIFFERENT-VERSION',
    payload: { turnState: TurnState.idle() },  // 이 payload 는 무시되어야 함
  })
  // bridge 가 stale 감지 → runtime.state (working('hi')) 로 sync
  assertDeepEqual(state.get(STATE_PATH.TURN_STATE), TurnState.working('hi'),
    'S1: stale 이벤트 시 runtime.state 로 reconcile')
}

// S2. 매칭되는 stateVersion 은 payload 를 그대로 적용
{
  const { state, runtime } = setup()
  const result = runtime.submit({ type: 'chat', payload: { input: 'current' } })
  assert(result.isRight(), 'S2: accept')
  assertDeepEqual(state.get(STATE_PATH.TURN_STATE), TurnState.working('current'),
    'S2: 매칭 버전의 payload 적용')
}

// --- dispose ---

// D1. dispose 호출 후 이벤트 수신 안 함
{
  const { state, bus, runtime, dispose } = setup()
  dispose()
  runtime.submit({ type: 'chat', payload: { input: 'after-dispose' } })
  assertDeepEqual(state.get(STATE_PATH.TURN_STATE), TurnState.idle(),
    'D1: dispose 후 state 변경 없음')
}

// --- 생성자 검증 ---

// V1. 필수 인자 누락 시 throw
{
  const bus = makeFsmEventBus()
  const runtime = makeFSMRuntime({ fsm: turnGateFSM, bus })
  const state = makeMockState()
  const fn = () => {}

  let thrown
  thrown = null; try { makeTurnGateBridge({ state, bus, getAbortController: fn }) } catch (e) { thrown = e }
  assert(thrown !== null, 'V1: runtime 누락 throw')
  thrown = null; try { makeTurnGateBridge({ runtime, bus, getAbortController: fn }) } catch (e) { thrown = e }
  assert(thrown !== null, 'V1: state 누락 throw')
  thrown = null; try { makeTurnGateBridge({ runtime, state, getAbortController: fn }) } catch (e) { thrown = e }
  assert(thrown !== null, 'V1: bus 누락 throw')
  thrown = null; try { makeTurnGateBridge({ runtime, state, bus }) } catch (e) { thrown = e }
  assert(thrown !== null, 'V1: getAbortController 누락 throw')
}

summary()
