import { initI18n } from '../../src/i18n/index.js'
initI18n('ko')
import {
  applyFinalState, safeRunTurn, createAgentTurn, createAgent,
  PHASE, RESULT, Phase, TurnResult, MANAGED_PATHS,
} from '../../src/core/agent.js'
import { createTestInterpreter } from '../../src/interpreter/test.js'
import { createReactiveState, getByPath } from '../../src/infra/state.js'
import { runFreeWithStateT } from '../../src/core/op.js'

import { assert, summary } from '../lib/assert.js'

async function run() {
  console.log('applyFinalState ordering + turn chaining tests')

  // ===========================================
  // 경로 순서: turnState는 반드시 마지막
  // ===========================================

  // F1. turnState=idle 시점에 lastTurn이 이미 반영되어야 함
  {
    const state = createReactiveState({ turnState: Phase.working('q'), lastTurn: null })
    let lastTurnAtIdleHook = 'NOT_CAPTURED'

    state.hooks.on('turnState', (phase) => {
      if (phase.tag === PHASE.IDLE) {
        lastTurnAtIdleHook = state.get('lastTurn')
      }
    })

    applyFinalState(state, {
      _streaming: null,
      lastTurn: TurnResult.success('q', 'result'),
      turnState: Phase.idle(),
    }, {})

    assert(lastTurnAtIdleHook !== null, 'F1: lastTurn captured at idle hook')
    assert(lastTurnAtIdleHook !== 'NOT_CAPTURED', 'F1: hook actually fired')
    assert(lastTurnAtIdleHook.tag === RESULT.SUCCESS, 'F1: lastTurn is success at idle hook time')
  }

  // F2. turnState=idle 시점에 conversationHistory가 이미 반영되어야 함
  {
    const state = createReactiveState({
      turnState: Phase.working('q'),
      context: { conversationHistory: [] },
    })
    let historyAtIdleHook = null

    state.hooks.on('turnState', (phase) => {
      if (phase.tag === PHASE.IDLE) {
        historyAtIdleHook = state.get('context.conversationHistory')
      }
    })

    applyFinalState(state, {
      turnState: Phase.idle(),
      lastTurn: TurnResult.success('q', 'ok'),
      context: { conversationHistory: [{ id: 'h-1', input: 'q', output: 'ok' }] },
    }, { initialEpoch: 0 })

    assert(historyAtIdleHook !== null, 'F2: history captured at idle hook')
    assert(historyAtIdleHook.length === 1, 'F2: history has 1 entry at idle hook time')
  }

  // F3. turnState=idle 시점에 _debug.* 가 이미 반영되어야 함
  {
    const state = createReactiveState({ turnState: Phase.working('q') })
    let debugAtIdleHook = 'NOT_SET'

    state.hooks.on('turnState', (phase) => {
      if (phase.tag === PHASE.IDLE) {
        debugAtIdleHook = state.get('_debug.lastTurn')
      }
    })

    applyFinalState(state, {
      turnState: Phase.idle(),
      lastTurn: TurnResult.success('q', 'ok'),
      _debug: { lastTurn: { input: 'q', iteration: 0 } },
    }, {})

    assert(debugAtIdleHook !== 'NOT_SET', 'F3: debug captured at idle hook')
    assert(debugAtIdleHook?.input === 'q', 'F3: debug.lastTurn reflects current turn')
  }

  // F4. turnState=idle 시점에 _streaming이 이미 null이어야 함
  {
    const state = createReactiveState({
      turnState: Phase.working('q'),
      _streaming: { content: 'partial', status: 'streaming' },
    })
    let streamingAtIdleHook = 'NOT_CHECKED'

    state.hooks.on('turnState', (phase) => {
      if (phase.tag === PHASE.IDLE) {
        streamingAtIdleHook = state.get('_streaming')
      }
    })

    applyFinalState(state, {
      turnState: Phase.idle(),
      lastTurn: TurnResult.success('q', 'ok'),
      _streaming: null,
    }, {})

    assert(streamingAtIdleHook === null, 'F4: _streaming is null at idle hook time')
  }

  // F5. MANAGED_PATHS에서 turnState가 마지막인지 구조 검증
  {
    assert(MANAGED_PATHS[MANAGED_PATHS.length - 1] === 'turnState',
      'F5: turnState is last in MANAGED_PATHS')
  }

  // ===========================================
  // 턴 연쇄: idle hook → 다음 턴 시작
  // ===========================================

  // F6. 1st 턴(user) 완료 → idle hook에서 2nd 턴(auto) 시작 → 2nd가 1st의 history를 보는지
  {
    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })

    let secondTurnCallCount = 0
    let secondTurnHistoryLength = null

    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: '응답' }),
    })

    // idle hook: 1st 턴 완료 후 2nd 턴 자동 시작 (1회만)
    state.hooks.on('turnState', async (phase) => {
      if (phase.tag === PHASE.IDLE && state.get('turn') === 1 && secondTurnCallCount === 0) {
        secondTurnCallCount++
        // 이 시점에 1st 턴의 history가 반영되어 있어야 함
        secondTurnHistoryLength = (state.get('context.conversationHistory') || []).length

        // 2nd 턴 시작 (source 없음 — event/heartbeat 시나리오)
        const safe = safeRunTurn({ interpret, ST }, state)
        await safe(createAgentTurn()('자동 후속 질문'), '자동 후속 질문')
      }
    })

    // 1st 턴 실행 (source: 'user' → history에 기록)
    const turn = createAgentTurn()
    const safe = safeRunTurn({ interpret, ST }, state)
    await safe(turn('첫 질문', { source: 'user' }), '첫 질문')

    // 2nd 턴이 실행될 시간 확보
    await new Promise(r => setTimeout(r, 200))

    assert(secondTurnCallCount === 1, 'F6: 2nd turn triggered by idle hook')
    assert(secondTurnHistoryLength === 1, 'F6: 2nd turn sees 1st turn history at hook time')
    assert(state.get('turn') === 2, 'F6: both turns completed')
    // 1st(user) → history 1개, 2nd(auto, source 없음) → history 추가 안됨
    assert((state.get('context.conversationHistory') || []).length === 1,
      'F6: final history has 1 entry (only user turn)')
  }

  // F7. 연쇄 턴에서 2nd 턴의 snapshot이 1st 턴의 lastTurn을 포함하는지
  {
    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })

    let snapshotLastTurn = 'NOT_CAPTURED'
    let triggered = false

    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: '응답' }),
    })

    state.hooks.on('turnState', async (phase) => {
      if (phase.tag === PHASE.IDLE && state.get('turn') === 1 && !triggered) {
        triggered = true
        snapshotLastTurn = state.get('lastTurn')
      }
    })

    const safe = safeRunTurn({ interpret, ST }, state)
    await safe(createAgentTurn()('질문'), '질문')
    await new Promise(r => setTimeout(r, 100))

    assert(snapshotLastTurn !== 'NOT_CAPTURED', 'F7: lastTurn captured in idle hook')
    assert(snapshotLastTurn?.tag === RESULT.SUCCESS, 'F7: lastTurn is success in idle hook')
  }

  // ===========================================
  // epoch 변경 + idle hook
  // ===========================================

  // F8. epoch 불일치: history 스킵되지만 turnState idle hook은 정상 발동
  {
    const state = createReactiveState({
      turnState: Phase.working('q'),
      _compactionEpoch: 1,
      context: { conversationHistory: [{ id: 'old', input: 'old' }] },
    })
    let hookFired = false

    state.hooks.on('turnState', (phase) => {
      if (phase.tag === PHASE.IDLE) hookFired = true
    })

    applyFinalState(state, {
      turnState: Phase.idle(),
      lastTurn: TurnResult.success('q', 'ok'),
      context: { conversationHistory: [{ id: 'old' }, { id: 'new' }] },
    }, { initialEpoch: 0 }) // epoch 불일치

    assert(hookFired, 'F8: idle hook fires despite epoch mismatch')
    const history = state.get('context.conversationHistory')
    assert(history.length === 1, 'F8: history NOT overwritten (epoch guard)')
    assert(history[0].id === 'old', 'F8: old history preserved')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'F8: lastTurn still applied')
  }

  // F9. epoch 일치: history 정상 반영
  {
    const state = createReactiveState({
      turnState: Phase.working('q'),
      _compactionEpoch: 0,
      context: { conversationHistory: [] },
    })

    applyFinalState(state, {
      turnState: Phase.idle(),
      lastTurn: TurnResult.success('q', 'ok'),
      context: { conversationHistory: [{ id: 'h-1', input: 'q', output: 'ok' }] },
    }, { initialEpoch: 0 }) // epoch 일치

    const history = state.get('context.conversationHistory')
    assert(history.length === 1, 'F9: history applied (epoch match)')
  }

  // ===========================================
  // memoryActor 없는 환경: snapshot 타이밍
  // ===========================================

  // F10. memoryActor 없이 safeRunTurn → applyFinalState → idle hook에서 상태 일관성
  {
    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })

    let hookLastTurn = null
    state.hooks.on('turnState', (phase) => {
      if (phase.tag === PHASE.IDLE && state.get('turn') >= 1) {
        hookLastTurn = state.get('lastTurn')
      }
    })

    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'no-memory reply' }),
    })

    // memoryActor 없이 실행
    const safe = safeRunTurn({ interpret, ST }, state)
    await safe(createAgentTurn()('test'), 'test')

    assert(hookLastTurn !== null, 'F10: lastTurn available in idle hook (no memoryActor)')
    assert(hookLastTurn?.tag === RESULT.SUCCESS, 'F10: lastTurn is success')
  }

  // ===========================================
  // 실패 턴 후 연쇄
  // ===========================================

  // F11. 1st 턴 실패 → idle hook 발동 → 상태가 failure로 정확히 반영
  {
    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })

    let hookLastTurnTag = null
    state.hooks.on('turnState', (phase) => {
      if (phase.tag === PHASE.IDLE && state.get('turn') >= 1) {
        hookLastTurnTag = state.get('lastTurn')?.tag
      }
    })

    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => '<<<invalid>>>',
    })

    const safe = safeRunTurn({ interpret, ST }, state)
    await safe(createAgentTurn()('fail'), 'fail')

    assert(hookLastTurnTag === RESULT.FAILURE, 'F11: idle hook sees failure lastTurn')
  }

  // F12. 실패 턴 후 성공 턴 연쇄: lastTurn이 success로 교체되는지
  {
    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })

    const lastTurnTags = []
    state.hooks.on('turnState', (phase) => {
      if (phase.tag === PHASE.IDLE && state.get('turn') >= 1) {
        lastTurnTags.push(state.get('lastTurn')?.tag)
      }
    })

    let callCount = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        callCount++
        if (callCount === 1) return '<<<bad>>>'
        return JSON.stringify({ type: 'direct_response', message: 'ok' })
      },
    })

    const safe = safeRunTurn({ interpret, ST }, state)
    await safe(createAgentTurn()('fail first'), 'fail first')
    await safe(createAgentTurn()('then succeed'), 'then succeed')

    assert(lastTurnTags.length === 2, 'F12: 2 idle hooks fired')
    assert(lastTurnTags[0] === RESULT.FAILURE, 'F12: 1st idle sees failure')
    assert(lastTurnTags[1] === RESULT.SUCCESS, 'F12: 2nd idle sees success')
  }

  // ===========================================
  // applyFinalState에 undefined 값이 포함된 경우
  // ===========================================

  // F13. finalState에 undefined 경로 → 기존 값 보존 (덮어쓰지 않음)
  {
    const state = createReactiveState({
      turnState: Phase.working('q'),
      lastTurn: TurnResult.success('old', 'old result'),
      _debug: { lastTurn: { input: 'old' } },
    })

    applyFinalState(state, {
      turnState: Phase.idle(),
      // lastTurn, _debug.lastTurn 없음 (undefined)
    }, {})

    // lastTurn은 이전 값 유지
    assert(state.get('lastTurn')?.result === 'old result', 'F13: undefined path preserves old value')
  }

  summary()
}

run()
