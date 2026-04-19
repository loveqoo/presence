import { makeFsmEventBus } from '@presence/core/core/fsm/event-bus.js'
import { makeFSMRuntime } from '@presence/core/core/fsm/runtime.js'
import { approveFSM, ApproveState } from '@presence/infra/infra/fsm/approve-fsm.js'
import { makeApproveBridge } from '@presence/infra/infra/fsm/approve-bridge.js'
import { STATE_PATH } from '@presence/core/core/policies.js'
import { assert, assertDeepEqual, summary } from '../../../test/lib/assert.js'

console.log('approveBridge tests')

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

const setup = (initialApprove = ApproveState.idle()) => {
  const state = makeMockState({ [STATE_PATH.APPROVE]: null })
  const bus = makeFsmEventBus()
  const runtime = makeFSMRuntime({ fsm: approveFSM, bus, initial: initialApprove })
  const resolveCalls = []
  const resolvePending = (approved) => resolveCalls.push(approved)
  const dispose = makeApproveBridge({ runtime, state, bus, resolvePending })
  return { state, bus, runtime, resolveCalls, dispose }
}

// --- 정상 이벤트 apply ---

// N1. request_approval — reactiveState 에 { description } projection
{
  const { state, runtime } = setup()
  runtime.submit({ type: 'request_approval', payload: { description: '파일 삭제' } })
  assertDeepEqual(state.get(STATE_PATH.APPROVE), { description: '파일 삭제' },
    'N1: reactiveState = { description: ... }')
}

// N2. approve — reactiveState = null + resolvePending(true) 호출
{
  const { state, runtime, resolveCalls } = setup(ApproveState.awaitingApproval('xyz'))
  // 초기 state 에 pending 이 남아있는 것처럼 세팅
  state.set(STATE_PATH.APPROVE, { description: 'xyz' })
  runtime.submit({ type: 'approve' })
  assertDeepEqual(state.get(STATE_PATH.APPROVE), null, 'N2: reactiveState = null')
  assertDeepEqual(resolveCalls, [true], 'N2: resolvePending(true) 호출됨')
}

// N3. reject — reactiveState = null + resolvePending(false)
{
  const { state, runtime, resolveCalls } = setup(ApproveState.awaitingApproval('xyz'))
  state.set(STATE_PATH.APPROVE, { description: 'xyz' })
  runtime.submit({ type: 'reject' })
  assertDeepEqual(state.get(STATE_PATH.APPROVE), null, 'N3: reactiveState = null')
  assertDeepEqual(resolveCalls, [false], 'N3: resolvePending(false) 호출됨')
}

// N4. cancel_approval — reactiveState = null + resolvePending(false)
{
  const { state, runtime, resolveCalls } = setup(ApproveState.awaitingApproval('xyz'))
  state.set(STATE_PATH.APPROVE, { description: 'xyz' })
  runtime.submit({ type: 'cancel_approval' })
  assertDeepEqual(state.get(STATE_PATH.APPROVE), null, 'N4: reactiveState = null')
  assertDeepEqual(resolveCalls, [false], 'N4: resolvePending(false) 호출됨')
}

// --- projection 동일 값 방지 ---

// P1. 같은 값 재할당 시 state.set 중복 호출 없음
{
  const { state, runtime } = setup()
  runtime.submit({ type: 'request_approval', payload: { description: 'a' } })
  const beforeCount = state._setCalls.length

  // 두 번째 request_approval 은 nested-approval 으로 reject. state 변경 없음.
  runtime.submit({ type: 'request_approval', payload: { description: 'a' } })
  const afterCount = state._setCalls.length
  // nested-approval rejection event 는 approveState 없으므로 applyProjection 호출 안 됨.
  assertDeepEqual(afterCount, beforeCount, 'P1: reject 이벤트는 projection skip')
}

// --- stale 이벤트 sync ---

// S1. stale 이벤트 받으면 runtime.state 로 reconcile
{
  const { state, bus, runtime } = setup()
  runtime.submit({ type: 'request_approval', payload: { description: 'curr' } })
  state.set(STATE_PATH.APPROVE, null)  // 수동으로 엉뚱한 값 조작
  // stale 이벤트 publish
  bus.publish({
    topic: 'approve.requested',
    ts: 0,
    source: 'approve',
    stateVersion: 'STALE-VERSION',
    payload: { approveState: ApproveState.idle() },
  })
  assertDeepEqual(state.get(STATE_PATH.APPROVE), { description: 'curr' },
    'S1: stale 시 runtime.state 로 reconcile (current 복원)')
}

// --- fsm.rejected 필터 ---

// R1. fsm.rejected 중 source 가 다른 FSM 것은 무시
{
  const { state, bus } = setup()
  state.set(STATE_PATH.APPROVE, { description: 'keep' })
  bus.publish({
    topic: 'fsm.rejected',
    ts: 0,
    source: 'turnGate',   // 다른 FSM
    stateVersion: 'irrelevant',
    payload: { primaryReason: 'session-busy', reasons: [], command: {} },
  })
  // approveBridge 는 이 이벤트 무시 — state 변경 없음
  assertDeepEqual(state.get(STATE_PATH.APPROVE), { description: 'keep' },
    'R1: 다른 FSM 의 fsm.rejected 는 무시')
}

// --- multi-FSM bus 간섭 차단 ---

// X1. turnGate 이벤트 (approve topic 아님) 는 구독 안 함
{
  const { state, bus } = setup()
  state.set(STATE_PATH.APPROVE, { description: 'keep' })
  bus.publish({
    topic: 'turn.started',
    ts: 0,
    source: 'turnGate',
    stateVersion: 'v-1',
    payload: { turnState: { tag: 'working', input: 'x' } },
  })
  // approveBridge 는 turn.started 구독 안 함. 처리 안 됨.
  assertDeepEqual(state.get(STATE_PATH.APPROVE), { description: 'keep' },
    'X1: turn.started 이벤트는 approve bridge 가 무시 (exact topic 구독)')
}

// --- Reentry (F3) ---

// F3. resolvePending 콜백 내부에서 nested submit 시도 — Phase 2 F3 reentry 시나리오.
{
  const state = makeMockState({ [STATE_PATH.APPROVE]: null })
  const bus = makeFsmEventBus()
  const runtime = makeFSMRuntime({ fsm: approveFSM, bus })
  const resolveCalls = []
  let nestedSubmitResult = null
  const resolvePending = (approved) => {
    resolveCalls.push(approved)
    // resolve 받은 시점에 FSM 은 이미 idle. nested 는 정상 accept 가능.
    nestedSubmitResult = runtime.submit({ type: 'request_approval', payload: { description: 'after' } })
  }
  makeApproveBridge({ runtime, state, bus, resolvePending })

  runtime.submit({ type: 'request_approval', payload: { description: 'first' } })
  runtime.submit({ type: 'approve' })  // approve → idle, resolvePending → nested request

  assertDeepEqual(resolveCalls, [true], 'F3: resolvePending 한 번 호출')
  assert(nestedSubmitResult?.isRight(), 'F3: nested submit 성공 (approve 후 idle 상태라 accept)')
  assertDeepEqual(runtime.state, ApproveState.awaitingApproval('after'),
    'F3: runtime 최종 상태 = awaitingApproval(after)')
}

// --- dispose ---

// D1. dispose 후 이벤트 수신 안 함
{
  const { state, runtime, dispose } = setup()
  dispose()
  runtime.submit({ type: 'request_approval', payload: { description: 'ignored' } })
  assertDeepEqual(state.get(STATE_PATH.APPROVE), null, 'D1: dispose 후 state 변경 없음')
}

// --- 생성자 검증 ---

// V1. 필수 인자 누락 시 throw
{
  const bus = makeFsmEventBus()
  const runtime = makeFSMRuntime({ fsm: approveFSM, bus })
  const state = makeMockState()
  const fn = () => {}

  let thrown
  thrown = null; try { makeApproveBridge({ state, bus, resolvePending: fn }) } catch (e) { thrown = e }
  assert(thrown !== null, 'V1: runtime 누락 throw')
  thrown = null; try { makeApproveBridge({ runtime, bus, resolvePending: fn }) } catch (e) { thrown = e }
  assert(thrown !== null, 'V1: state 누락 throw')
  thrown = null; try { makeApproveBridge({ runtime, state, resolvePending: fn }) } catch (e) { thrown = e }
  assert(thrown !== null, 'V1: bus 누락 throw')
  thrown = null; try { makeApproveBridge({ runtime, state, bus }) } catch (e) { thrown = e }
  assert(thrown !== null, 'V1: resolvePending 누락 throw')
}

summary()
