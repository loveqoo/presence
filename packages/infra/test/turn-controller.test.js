import { initI18n } from '@presence/infra/i18n'
import { STATE_PATH } from '@presence/core/core/policies.js'
import { TurnController } from '@presence/infra/infra/sessions/internal/turn-controller.js'
import { assert, summary } from '../../../test/lib/assert.js'

initI18n('ko')

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

async function run() {
  console.log('TurnController cancel tests')

  // TC1: 턴 실행 중 cancel → abort signal 발동
  {
    const state = createMockState()
    const logger = createMockLogger()
    const controller = new TurnController(state, logger, noop)
    controller.turnAbort = new AbortController()

    controller.handleCancel()

    assert(controller.turnAbort.signal.aborted, 'TC1: abort signal fired')
    assert(logger.logs.some(l => l.msg.includes('cancelled')), 'TC1: cancel logged')
  }

  // TC2: 턴 완료 후 cancel → 마지막 history entry 에 cancelled 태그
  {
    const history = [
      { id: 'h-1', input: '안녕', output: '반갑습니다', ts: 1 },
      { id: 'h-2', input: '취소할 질문', output: '취소될 응답', ts: 2 },
    ]
    const state = createMockState({ [STATE_PATH.CONTEXT_CONVERSATION_HISTORY]: history })
    const logger = createMockLogger()
    const controller = new TurnController(state, logger, noop)
    // turnAbort 은 null (턴 완료 후)

    controller.handleCancel()

    const updated = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
    assert(updated.length === 2, 'TC2: history length preserved')
    assert(updated[0].cancelled === undefined, 'TC2: first entry not cancelled')
    assert(updated[1].cancelled === true, 'TC2: last entry tagged as cancelled')
    assert(updated[1].output === '취소될 응답', 'TC2: output preserved (tagged, not deleted)')
    assert(logger.logs.some(l => l.msg.includes('cancelled')), 'TC2: tag logged')
  }

  // TC3: 빈 history 에서 cancel → 에러 없이 무시
  {
    const state = createMockState({ [STATE_PATH.CONTEXT_CONVERSATION_HISTORY]: [] })
    const logger = createMockLogger()
    const controller = new TurnController(state, logger, noop)

    controller.handleCancel()

    assert(state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY).length === 0, 'TC3: empty history unchanged')
  }

  // TC4: 이미 cancelled 인 entry 에 중복 태깅 안 됨
  {
    const history = [{ id: 'h-1', input: 'x', output: 'y', ts: 1, cancelled: true }]
    const state = createMockState({ [STATE_PATH.CONTEXT_CONVERSATION_HISTORY]: history })
    const logger = createMockLogger()
    const controller = new TurnController(state, logger, noop)

    controller.handleCancel()

    assert(logger.logs.length === 0, 'TC4: no duplicate tag log')
  }

  // TC5: history 없을 때 (undefined) cancel → 에러 없이 무시
  {
    const state = createMockState({})
    const logger = createMockLogger()
    const controller = new TurnController(state, logger, noop)

    controller.handleCancel()
    assert(true, 'TC5: no error on undefined history')
  }

  summary()
}

run()
