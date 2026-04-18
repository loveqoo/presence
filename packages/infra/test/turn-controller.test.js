import { initI18n } from '@presence/infra/i18n'
await initI18n('ko')
import { STATE_PATH, HISTORY_ENTRY_TYPE } from '@presence/core/core/policies.js'
import { TurnController } from '@presence/infra/infra/sessions/internal/turn-controller.js'
import { TurnLifecycle } from '@presence/core/core/turn-lifecycle.js'
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

  // TC6: approve → SYSTEM entry 기록 (INV-SYS-3)
  {
    const state = createMockState({ [STATE_PATH.CONTEXT_CONVERSATION_HISTORY]: [] })
    const logger = createMockLogger()
    const controller = new TurnController(state, logger, noop, mkLifecycle())
    controller.interactive = true
    controller.approveResolve = () => {}
    controller.approveDescription = 'write_file'

    controller.handleApproveResponse(true)

    const history = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
    assert(history.length === 1, 'TC6: approve → 1 SYSTEM entry')
    assert(history[0].type === HISTORY_ENTRY_TYPE.SYSTEM, 'TC6: type=system')
    assert(history[0].tag === 'approve', 'TC6: tag=approve')
    assert(history[0].content.includes('write_file'), 'TC6: content includes description')
  }

  // TC7: reject → SYSTEM entry 기록 (INV-SYS-3)
  {
    const state = createMockState({ [STATE_PATH.CONTEXT_CONVERSATION_HISTORY]: [] })
    const logger = createMockLogger()
    const controller = new TurnController(state, logger, noop, mkLifecycle())
    controller.interactive = true
    controller.approveResolve = () => {}
    controller.approveDescription = 'dangerous_op'

    controller.handleApproveResponse(false)

    const history = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
    assert(history.length === 1, 'TC7: reject → 1 SYSTEM entry')
    assert(history[0].tag === 'reject', 'TC7: tag=reject')
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

  summary()
}

run()
