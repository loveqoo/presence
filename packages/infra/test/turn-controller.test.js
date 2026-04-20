import { initI18n } from '@presence/infra/i18n'
await initI18n('ko')
import { STATE_PATH, HISTORY_ENTRY_TYPE } from '@presence/core/core/policies.js'
import { TurnController } from '@presence/infra/infra/sessions/internal/turn-controller.js'
import { TurnLifecycle } from '@presence/core/core/turn-lifecycle.js'
import { makeFsmEventBus } from '@presence/core/core/fsm/event-bus.js'
import { makeFSMRuntime } from '@presence/core/core/fsm/runtime.js'
import { approveFSM } from '@presence/infra/infra/fsm/approve-fsm.js'
import { makeApproveBridge } from '@presence/infra/infra/fsm/approve-bridge.js'
import { assert, summary } from '../../../test/lib/assert.js'

const noop = () => {}
const createMockState = (initial = {}) => {
  const data = { ...initial }
  return {
    get(path) { return data[path] },
    set(path, value) { data[path] = value },
    data,
  }
}

const createMockLogger = () => {
  const logs = []
  return {
    info: (msg) => logs.push({ level: 'info', msg }),
    warn: (msg) => logs.push({ level: 'warn', msg }),
    error: (msg) => logs.push({ level: 'error', msg }),
    logs,
  }
}

const mkLifecycle = () => new TurnLifecycle()

async function run() {
  console.log('TurnController cancel tests')

  // TC1: 진행 중 turn cancel (turnState=working) → abort signal, SYSTEM entry 기록 안 함
  {
    const state = createMockState({
      [STATE_PATH.CONTEXT_CONVERSATION_HISTORY]: [],
      [STATE_PATH.TURN_STATE]: { tag: 'working' },
    })
    const logger = createMockLogger()
    const controller = new TurnController(state, logger, noop, mkLifecycle())
    controller.turnAbort = new AbortController()

    controller.handleCancel()

    assert(controller.turnAbort.signal.aborted, 'TC1: abort signal fired')
    assert(logger.logs.some(l => l.msg.includes('cancelled')), 'TC1: cancel logged')
    const history = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
    assert(history.length === 0, 'TC1: handleCancel 이 SYSTEM entry 를 직접 쓰지 않음 (INV-SYS-2)')
  }

  // TC1b: turnAbort 존재하지만 turnState=idle → race window → markLastTurnCancelled path
  {
    const history = [{ id: 'h-1', input: 'q', output: 'a', ts: 1 }]
    const state = createMockState({
      [STATE_PATH.CONTEXT_CONVERSATION_HISTORY]: history,
      [STATE_PATH.TURN_STATE]: { tag: 'idle' },   // 이미 applyFinalState 로 idle 전이됨
    })
    const logger = createMockLogger()
    const controller = new TurnController(state, logger, noop, mkLifecycle())
    controller.turnAbort = new AbortController()   // finally 아직 미실행 — race window

    controller.handleCancel()

    assert(!controller.turnAbort.signal.aborted, 'TC1b: abort no-op 회피 — signal 건드리지 않음')
    const updated = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
    assert(updated[0].cancelled === true, 'TC1b: race window 에서도 cancelled 플래그 부여')
  }

  // TC2: 턴 완료 후 cancel → markLastTurnCancelledSync 위임
  {
    const history = [
      { id: 'h-1', input: '안녕', output: '반갑습니다', ts: 1 },
      { id: 'h-2', input: '취소할 질문', output: '취소될 응답', ts: 2 },
    ]
    const state = createMockState({ [STATE_PATH.CONTEXT_CONVERSATION_HISTORY]: history })
    const logger = createMockLogger()
    const controller = new TurnController(state, logger, noop, mkLifecycle())

    controller.handleCancel()

    const updated = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
    assert(updated.length === 2, 'TC2: history length preserved')
    assert(updated[0].cancelled === undefined, 'TC2: first entry not cancelled')
    assert(updated[1].cancelled === true, 'TC2: last turn entry tagged cancelled')
    assert(logger.logs.some(l => l.msg.includes('cancelled')), 'TC2: tag logged')
  }

  // TC3: 빈 history 에서 cancel → 에러 없이 무시
  {
    const state = createMockState({ [STATE_PATH.CONTEXT_CONVERSATION_HISTORY]: [] })
    const logger = createMockLogger()
    const controller = new TurnController(state, logger, noop, mkLifecycle())

    controller.handleCancel()

    assert(state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY).length === 0, 'TC3: empty history unchanged')
    assert(logger.logs.length === 0, 'TC3: no log on empty history')
  }

  // TC4: 이미 cancelled entry 는 중복 태깅 안 함
  {
    const history = [{ id: 'h-1', input: 'x', output: 'y', ts: 1, cancelled: true }]
    const state = createMockState({ [STATE_PATH.CONTEXT_CONVERSATION_HISTORY]: history })
    const logger = createMockLogger()
    const controller = new TurnController(state, logger, noop, mkLifecycle())

    controller.handleCancel()

    assert(logger.logs.length === 0, 'TC4: no duplicate tag log')
  }

  // TC5: 마지막 entry 가 SYSTEM 이면 그 앞의 turn entry 를 타겟 (INV-CNC-1)
  {
    const history = [
      { id: 'h-1', input: 'q', output: 'a', ts: 1 },
      { id: 'h-2', type: HISTORY_ENTRY_TYPE.SYSTEM, content: 'approved', tag: 'approve', ts: 2 },
    ]
    const state = createMockState({ [STATE_PATH.CONTEXT_CONVERSATION_HISTORY]: history })
    const logger = createMockLogger()
    const controller = new TurnController(state, logger, noop, mkLifecycle())

    controller.handleCancel()

    const updated = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
    assert(updated[0].cancelled === true, 'TC5: turn entry at [0] cancelled (SYSTEM skipped)')
    assert(updated[1].cancelled === undefined, 'TC5: SYSTEM entry unchanged')
  }

  // TC6/TC7 제거 — approveRuntime 미주입 legacy 경로 제거 (INV-FSM-SINGLE-WRITER).
  // 동일 시나리오는 TF2/TF3 가 FSM 경로로 커버.

  // TC-THROW: approveRuntime 미주입 시 onApprove → throw (fast-fail 배선 버그 탐지)
  {
    const state = createMockState()
    const logger = createMockLogger()
    const controller = new TurnController(state, logger, noop, mkLifecycle())
    controller.interactive = true
    let thrown = null
    try { controller.onApprove('any') } catch (e) { thrown = e }
    assert(thrown && /approveRuntime not injected/.test(thrown.message),
      'TC-THROW: runtime 미주입 시 onApprove throw')
  }

  // TC8: isAborted() getter
  {
    const controller = new TurnController(createMockState(), createMockLogger(), noop, mkLifecycle())
    assert(controller.isAborted() === false, 'TC8: no abort controller → false')
    controller.turnAbort = new AbortController()
    assert(controller.isAborted() === false, 'TC8: not yet aborted → false')
    controller.turnAbort.abort()
    assert(controller.isAborted() === true, 'TC8: after abort → true')
  }

  // --- Phase 6: approveFSM 주입 시나리오 (운영 ship 경로) ---

  // setup helper — turnController + approveFSM runtime + bridge 를 실제로 연결.
  const setupFsmApprove = () => {
    const state = createMockState({
      [STATE_PATH.CONTEXT_CONVERSATION_HISTORY]: [],
      [STATE_PATH.APPROVE]: null,
    })
    const logger = createMockLogger()
    const controller = new TurnController(state, logger, noop, mkLifecycle())
    const bus = makeFsmEventBus()
    const runtime = makeFSMRuntime({ fsm: approveFSM, bus })
    makeApproveBridge({
      runtime, state, bus,
      resolvePending: (approved) => controller.resolveApproval(approved),
    })
    controller.setApproveRuntime(runtime)
    controller.interactive = true
    return { state, controller, runtime, logger }
  }

  // TF1. FSM 경로 onApprove → runtime awaitingApproval + reactiveState.APPROVE 세팅
  {
    const { state, controller, runtime } = setupFsmApprove()
    const promise = controller.onApprove('file.delete')
    assert(promise instanceof Promise, 'TF1: onApprove 가 Promise 반환')
    assert(runtime.state.tag === 'awaitingApproval', 'TF1: runtime 상태 awaitingApproval')
    const approve = state.get(STATE_PATH.APPROVE)
    assert(approve && approve.description === 'file.delete',
      'TF1: reactiveState.APPROVE = { description }')
  }

  // TF2. FSM 경로 handleApproveResponse(true) → runtime idle + resolve(true) + SYSTEM entry
  {
    const { state, controller, runtime } = setupFsmApprove()
    let resolvedWith = null
    controller.onApprove('write').then(v => { resolvedWith = v })
    controller.handleApproveResponse(true)
    // 동기 경로: submit → bridge → resolveApproval → promise 는 microtask 로 resolve
    await Promise.resolve()
    assert(runtime.state.tag === 'idle', 'TF2: runtime idle')
    assert(state.get(STATE_PATH.APPROVE) === null, 'TF2: reactiveState.APPROVE = null')
    assert(resolvedWith === true, 'TF2: Promise resolve true')
    const history = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
    assert(history.length === 1 && history[0].tag === 'approve',
      'TF2: SYSTEM approve entry 기록 (INV-SYS-3 보존)')
  }

  // TF3. FSM 경로 handleApproveResponse(false) → reject + resolve(false) + SYSTEM reject
  {
    const { state, controller, runtime } = setupFsmApprove()
    let resolvedWith = null
    controller.onApprove('risky').then(v => { resolvedWith = v })
    controller.handleApproveResponse(false)
    await Promise.resolve()
    assert(runtime.state.tag === 'idle', 'TF3: runtime idle')
    assert(resolvedWith === false, 'TF3: Promise resolve false')
    const history = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
    assert(history[0].tag === 'reject', 'TF3: SYSTEM reject entry')
  }

  // TF4. FSM 경로 resetApprove — pending 정리 + resolve(false)
  {
    const { state, controller, runtime } = setupFsmApprove()
    let resolvedWith = null
    controller.onApprove('cleanup').then(v => { resolvedWith = v })
    controller.resetApprove()
    await Promise.resolve()
    assert(runtime.state.tag === 'idle', 'TF4: runtime idle 복귀')
    assert(state.get(STATE_PATH.APPROVE) === null, 'TF4: reactiveState null')
    assert(resolvedWith === false, 'TF4: Promise resolve false (cancel)')
  }

  // TF5. FSM 경로 nested-approval — pending 중 재 요청은 runtime 이 explicit reject
  {
    const { controller, runtime } = setupFsmApprove()
    controller.onApprove('first')
    // 두 번째 onApprove 는 runtime 이 nested-approval explicit reject.
    // 하지만 turnController 는 Left 결과를 무시 (promise 는 그대로 만들어짐).
    // 이 테스트는 FSM 의 방어가 정상 동작하는지만 확인 (runtime.state 유지).
    controller.onApprove('second')
    assert(runtime.state.tag === 'awaitingApproval', 'TF5: runtime 여전히 awaitingApproval')
    assert(runtime.state.description === 'first',
      'TF5: runtime description 은 첫 번째 값 유지 (nested reject)')
  }

  summary()
}

run()
