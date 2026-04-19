import { initI18n } from '@presence/infra/i18n'
initI18n('ko')
import { PHASE, RESULT, TurnState, TurnOutcome } from '@presence/core/core/policies.js'
import { Agent } from '@presence/core/core/agent.js'
import { applyFinalState, MANAGED_PATHS, clearDebugState } from '@presence/core/core/state-commit.js'
import { STATE_PATH } from '@presence/core/core/policies.js'
import { createTestInterpreter } from '@presence/core/interpreter/test.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { getByPath } from '@presence/core/lib/path.js'
import { runFreeWithStateT } from '@presence/core/lib/runner.js'
import { makeFsmEventBus } from '@presence/core/core/fsm/event-bus.js'
import { makeFSMRuntime } from '@presence/core/core/fsm/runtime.js'
import { turnGateFSM } from '@presence/infra/infra/fsm/turn-gate-fsm.js'
import { makeTurnGateBridge } from '@presence/infra/infra/fsm/turn-gate-bridge.js'

import { assert, summary } from '../../../../test/lib/assert.js'

// Phase 4 single-writer: TURN_STATE 는 bridge 가 커밋. F1-F5 는 executor.afterTurn 의
// 흐름을 재현 — applyFinalState 로 다른 path 먼저 커밋 → runtime.submit → bridge 가
// state.set(TURN_STATE, idle). hook 순서 계약 (다른 path 이미 반영된 뒤 idle hook 발동) 검증.
const setupFsmChain = (state) => {
  const bus = makeFsmEventBus()
  const runtime = makeFSMRuntime({ fsm: turnGateFSM, bus, initial: TurnState.working('q') })
  const dispose = makeTurnGateBridge({
    runtime, state, bus, getAbortController: () => null,
  })
  return { bus, runtime, dispose }
}

async function run() {
  console.log('applyFinalState ordering + turn chaining tests')

  // ===========================================
  // 경로 순서: bridge 가 turnState 를 마지막에 커밋
  // applyFinalState (다른 path) → runtime.submit → bridge.state.set(TURN_STATE, idle)
  // 이 순서로 idle hook 시점에 다른 path 가 이미 반영되어 있음을 보장.
  // ===========================================

  // F1. idle hook 시점에 lastTurn 이 이미 반영되어야 함
  {
    const state = createOriginState({ turnState: TurnState.working('q'), lastTurn: null })
    const { runtime } = setupFsmChain(state)
    let lastTurnAtIdleHook = 'NOT_CAPTURED'

    state.hooks.on("turnState", (change) => { const phase = change.nextValue;
      if (phase.tag === PHASE.IDLE) {
        lastTurnAtIdleHook = state.get('lastTurn')
      }
    })

    applyFinalState(state, {
      _streaming: null,
      lastTurn: TurnOutcome.success('q', 'result'),
    }, {})
    runtime.submit({ type: 'complete' })  // bridge → state.set(TURN_STATE, idle)

    assert(lastTurnAtIdleHook !== null, 'F1: lastTurn captured at idle hook')
    assert(lastTurnAtIdleHook !== 'NOT_CAPTURED', 'F1: hook actually fired')
    assert(lastTurnAtIdleHook.tag === RESULT.SUCCESS, 'F1: lastTurn is success at idle hook time')
  }

  // F2. idle hook 시점에 conversationHistory 가 이미 반영되어야 함
  {
    const state = createOriginState({
      turnState: TurnState.working('q'),
      context: { conversationHistory: [] },
    })
    const { runtime } = setupFsmChain(state)
    let historyAtIdleHook = null

    state.hooks.on("turnState", (change) => { const phase = change.nextValue;
      if (phase.tag === PHASE.IDLE) {
        historyAtIdleHook = state.get('context.conversationHistory')
      }
    })

    applyFinalState(state, {
      lastTurn: TurnOutcome.success('q', 'ok'),
      context: { conversationHistory: [{ id: 'h-1', input: 'q', output: 'ok' }] },
    }, { initialEpoch: 0 })
    runtime.submit({ type: 'complete' })

    assert(historyAtIdleHook !== null, 'F2: history captured at idle hook')
    assert(historyAtIdleHook.length === 1, 'F2: history has 1 entry at idle hook time')
  }

  // F3. idle hook 시점에 _debug.* 가 이미 반영되어야 함
  {
    const state = createOriginState({ turnState: TurnState.working('q') })
    const { runtime } = setupFsmChain(state)
    let debugAtIdleHook = 'NOT_SET'

    state.hooks.on("turnState", (change) => { const phase = change.nextValue;
      if (phase.tag === PHASE.IDLE) {
        debugAtIdleHook = state.get('_debug.lastTurn')
      }
    })

    applyFinalState(state, {
      lastTurn: TurnOutcome.success('q', 'ok'),
      _debug: { lastTurn: { input: 'q', iteration: 0 } },
    }, {})
    runtime.submit({ type: 'complete' })

    assert(debugAtIdleHook !== 'NOT_SET', 'F3: debug captured at idle hook')
    assert(debugAtIdleHook?.input === 'q', 'F3: debug.lastTurn reflects current turn')
  }

  // F4. idle hook 시점에 _streaming 이 이미 null 이어야 함
  {
    const state = createOriginState({
      turnState: TurnState.working('q'),
      _streaming: { content: 'partial', status: 'streaming' },
    })
    const { runtime } = setupFsmChain(state)
    let streamingAtIdleHook = 'NOT_CHECKED'

    state.hooks.on("turnState", (change) => { const phase = change.nextValue;
      if (phase.tag === PHASE.IDLE) {
        streamingAtIdleHook = state.get('_streaming')
      }
    })

    applyFinalState(state, {
      lastTurn: TurnOutcome.success('q', 'ok'),
      _streaming: null,
    }, {})
    runtime.submit({ type: 'complete' })

    assert(streamingAtIdleHook === null, 'F4: _streaming is null at idle hook time')
  }

  // F5. MANAGED_PATHS 에는 TURN_STATE 가 없음 (bridge 가 유일한 writer)
  {
    assert(!MANAGED_PATHS.includes(STATE_PATH.TURN_STATE),
      'F5: TURN_STATE is not in MANAGED_PATHS — bridge 가 유일한 writer')
  }

  // ===========================================
  // 턴 연쇄: idle hook → 다음 턴 시작
  // ===========================================

  // F6. 1st 턴(user) 완료 → idle hook에서 2nd 턴(auto) 시작 → 2nd가 1st의 history를 보는지
  {
    const state = createOriginState({
      turnState: TurnState.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })

    let secondTurnCallCount = 0
    let secondTurnHistoryLength = null

    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: '응답' }),
    })

    // idle hook: 1st 턴 완료 후 2nd 턴 자동 시작 (1회만)
    state.hooks.on("turnState", async (change) => { const phase = change.nextValue;
      if (phase.tag === PHASE.IDLE && state.get('turn') === 1 && secondTurnCallCount === 0) {
        secondTurnCallCount++
        // 이 시점에 1st 턴의 history가 반영되어 있어야 함
        secondTurnHistoryLength = (state.get('context.conversationHistory') || []).length

        // 2nd 턴 시작 (source 없음 — event/heartbeat 시나리오)
        const agent2 = new Agent({ interpret, ST, state })
        await agent2.run('자동 후속 질문')
      }
    })

    // 1st 턴 실행 (source: 'user' → history에 기록)
    const agent = new Agent({ interpret, ST, state })
    await agent.run('첫 질문', { source: 'user' })

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
    const state = createOriginState({
      turnState: TurnState.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })

    let snapshotLastTurn = 'NOT_CAPTURED'
    let triggered = false

    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: '응답' }),
    })

    state.hooks.on("turnState", async (change) => { const phase = change.nextValue;
      if (phase.tag === PHASE.IDLE && state.get('turn') === 1 && !triggered) {
        triggered = true
        snapshotLastTurn = state.get('lastTurn')
      }
    })

    const agent = new Agent({ interpret, ST, state })
    await agent.run('질문')
    await new Promise(r => setTimeout(r, 100))

    assert(snapshotLastTurn !== 'NOT_CAPTURED', 'F7: lastTurn captured in idle hook')
    assert(snapshotLastTurn?.tag === RESULT.SUCCESS, 'F7: lastTurn is success in idle hook')
  }

  // ===========================================
  // epoch 변경 + idle hook
  // ===========================================

  // F8. epoch 불일치: history 스킵되지만 bridge 경유 turnState idle hook 은 정상 발동
  {
    const state = createOriginState({
      turnState: TurnState.working('q'),
      _compactionEpoch: 1,
      context: { conversationHistory: [{ id: 'old', input: 'old' }] },
    })
    const { runtime } = setupFsmChain(state)
    let hookFired = false

    state.hooks.on("turnState", (change) => { const phase = change.nextValue;
      if (phase.tag === PHASE.IDLE) hookFired = true
    })

    applyFinalState(state, {
      lastTurn: TurnOutcome.success('q', 'ok'),
      context: { conversationHistory: [{ id: 'old' }, { id: 'new' }] },
    }, { initialEpoch: 0 }) // epoch 불일치
    runtime.submit({ type: 'complete' })  // bridge → state.set(TURN_STATE, idle)

    assert(hookFired, 'F8: idle hook fires despite epoch mismatch')
    const history = state.get('context.conversationHistory')
    assert(history.length === 1, 'F8: history NOT overwritten (epoch guard)')
    assert(history[0].id === 'old', 'F8: old history preserved')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'F8: lastTurn still applied')
  }

  // F9. epoch 일치: history 정상 반영
  {
    const state = createOriginState({
      turnState: TurnState.working('q'),
      _compactionEpoch: 0,
      context: { conversationHistory: [] },
    })

    applyFinalState(state, {
      turnState: TurnState.idle(),
      lastTurn: TurnOutcome.success('q', 'ok'),
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
    const state = createOriginState({
      turnState: TurnState.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })

    let hookLastTurn = null
    state.hooks.on("turnState", (change) => { const phase = change.nextValue;
      if (phase.tag === PHASE.IDLE && state.get('turn') >= 1) {
        hookLastTurn = state.get('lastTurn')
      }
    })

    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'no-memory reply' }),
    })

    // memoryActor 없이 실행
    const agent = new Agent({ interpret, ST, state })
    await agent.run('test')

    assert(hookLastTurn !== null, 'F10: lastTurn available in idle hook (no memoryActor)')
    assert(hookLastTurn?.tag === RESULT.SUCCESS, 'F10: lastTurn is success')
  }

  // ===========================================
  // 실패 턴 후 연쇄
  // ===========================================

  // F11. 1st 턴 실패 → idle hook 발동 → 상태가 failure로 정확히 반영
  {
    const state = createOriginState({
      turnState: TurnState.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })

    let hookLastTurnTag = null
    state.hooks.on("turnState", (change) => { const phase = change.nextValue;
      if (phase.tag === PHASE.IDLE && state.get('turn') >= 1) {
        hookLastTurnTag = state.get('lastTurn')?.tag
      }
    })

    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => '<<<invalid>>>',
    })

    const agent = new Agent({ interpret, ST, state })
    await agent.run('fail')

    assert(hookLastTurnTag === RESULT.FAILURE, 'F11: idle hook sees failure lastTurn')
  }

  // F12. 실패 턴 후 성공 턴 연쇄: lastTurn이 success로 교체되는지
  {
    const state = createOriginState({
      turnState: TurnState.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })

    const lastTurnTags = []
    state.hooks.on("turnState", (change) => { const phase = change.nextValue;
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

    const agent = new Agent({ interpret, ST, state })
    await agent.run('fail first')
    await agent.run('then succeed')

    assert(lastTurnTags.length === 2, 'F12: 2 idle hooks fired')
    assert(lastTurnTags[0] === RESULT.FAILURE, 'F12: 1st idle sees failure')
    assert(lastTurnTags[1] === RESULT.SUCCESS, 'F12: 2nd idle sees success')
  }

  // ===========================================
  // applyFinalState에 undefined 값이 포함된 경우
  // ===========================================

  // F13. finalState에 undefined 경로 → 기존 값 보존 (덮어쓰지 않음)
  {
    const state = createOriginState({
      turnState: TurnState.working('q'),
      lastTurn: TurnOutcome.success('old', 'old result'),
      _debug: { lastTurn: { input: 'old' } },
    })

    applyFinalState(state, {
      turnState: TurnState.idle(),
      // lastTurn, _debug.lastTurn 없음 (undefined)
    }, {})

    // lastTurn은 이전 값 유지
    assert(state.get('lastTurn')?.result === 'old result', 'F13: undefined path preserves old value')
  }

  // --- clearDebugState (INV-CLR-1) ---

  // F14. clearDebugState 는 pending/transcript/budgetWarning 모두 초기화
  {
    const state = createOriginState({
      turnState: TurnState.idle(),
      context: { memories: ['m1'], conversationHistory: [{ id: 'h-1', input: 'q', output: 'a' }] },
      _pendingInput: { input: 'in-flight', ts: 123 },
      _toolTranscript: [{ tool: 't', args: {}, result: 'r' }],
      _budgetWarning: { type: 'high_usage', pct: 95 },
      _compactionEpoch: 2,
      _debug: { lastTurn: { input: 'x' }, opTrace: ['o'] },
    })

    clearDebugState(state)

    assert(state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY).length === 0, 'F14: history cleared')
    assert(state.get(STATE_PATH.CONTEXT_MEMORIES).length === 0, 'F14: memories cleared')
    assert(state.get(STATE_PATH.PENDING_INPUT) === null, 'F14: pendingInput cleared (INV-CLR-1)')
    assert(state.get(STATE_PATH.TOOL_TRANSCRIPT).length === 0, 'F14: toolTranscript cleared (INV-CLR-1)')
    assert(state.get(STATE_PATH.BUDGET_WARNING) === null, 'F14: budgetWarning cleared (INV-CLR-1)')
    assert(state.get(STATE_PATH.COMPACTION_EPOCH) === 3, 'F14: compactionEpoch incremented')
    assert(state.get(STATE_PATH.DEBUG_LAST_TURN) === null, 'F14: debug.lastTurn cleared')
  }

  // F15. clearDebugState 빈 상태에서도 안전
  {
    const state = createOriginState({ turnState: TurnState.idle() })
    clearDebugState(state)
    assert(state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY).length === 0, 'F15: empty state safe')
    assert(state.get(STATE_PATH.PENDING_INPUT) === null, 'F15: pendingInput null safe')
  }

  // F16. MANAGED_PATHS 에 PENDING_INPUT 포함
  {
    assert(MANAGED_PATHS.includes(STATE_PATH.PENDING_INPUT), 'F16: MANAGED_PATHS includes PENDING_INPUT')
  }

  summary()
}

run()
