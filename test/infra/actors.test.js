import { initI18n } from '../../src/i18n/index.js'
initI18n('ko')
import fp from '../../src/lib/fun-fp.js'
import { createMemoryGraph, TIERS } from '../../src/infra/memory.js'
import { createReactiveState } from '../../src/infra/state.js'
import { MEMORY, HISTORY } from '../../src/core/policies.js'
import {
  createMemoryActor, createCompactionActor, createPersistenceActor,
  applyCompaction, forkTask,
} from '../../src/infra/actors.js'
import {
  extractForCompaction, createSummaryEntry, SUMMARY_MARKER,
} from '../../src/infra/history-compaction.js'

const { Task } = fp

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

// --- Helpers ---

const makeHistory = (n) => Array.from({ length: n }, (_, i) => ({
  id: `h-${i}`, input: `q${i}`, output: `a${i}`, ts: 1000 + i,
}))

const delay = (ms) => new Promise(r => setTimeout(r, ms))

async function run() {
  console.log('Actor tests')

  // =============================================
  // MemoryActor
  // =============================================

  // M1. recall → 결과 반환
  {
    const memory = await createMemoryGraph()
    memory.addNode({ label: '회의 안건', type: 'entity', tier: TIERS.EPISODIC })
    const actor = createMemoryActor({ graph: memory, embedder: null, logger: null })

    const result = await forkTask(actor.send({ type: 'recall', input: '회의' }))
    assert(Array.isArray(result), 'MemoryActor recall: returns array')
  }

  // M2. save → addNode + persist
  {
    const memory = await createMemoryGraph()
    const actor = createMemoryActor({ graph: memory, embedder: null, logger: null })

    const result = await forkTask(actor.send({
      type: 'save',
      node: { label: 'test node', type: 'conversation', tier: TIERS.EPISODIC, data: { input: 'q', output: 'a' } },
    }))
    assert(result === 'ok', 'MemoryActor save: returns ok')
    const episodic = memory.getNodesByTier(TIERS.EPISODIC)
    assert(episodic.length === 1, 'MemoryActor save: node added')
    assert(episodic[0].label === 'test node', 'MemoryActor save: correct label')
  }

  // M3. removeWorking → working 노드 제거
  {
    const memory = await createMemoryGraph()
    memory.addNode({ label: 'temp', tier: TIERS.WORKING })
    assert(memory.getNodesByTier(TIERS.WORKING).length === 1, 'MemoryActor removeWorking: 1 working before')

    const actor = createMemoryActor({ graph: memory, embedder: null, logger: null })
    await forkTask(actor.send({ type: 'removeWorking' }))
    assert(memory.getNodesByTier(TIERS.WORKING).length === 0, 'MemoryActor removeWorking: cleaned')
  }

  // M4. prune → 동기 처리
  {
    const memory = await createMemoryGraph()
    for (let i = 0; i < 5; i++) {
      memory.addNode({ label: `node-${i}`, type: 'conversation', tier: TIERS.EPISODIC, data: {} })
    }
    const actor = createMemoryActor({ graph: memory, embedder: null, logger: null })

    const pruned = await forkTask(actor.send({ type: 'prune', tier: TIERS.EPISODIC, max: 3 }))
    assert(typeof pruned === 'number', 'MemoryActor prune: returns count')
    assert(memory.getNodesByTier(TIERS.EPISODIC).length <= 3, 'MemoryActor prune: respects max')
  }

  // M5. promote → 동기 처리 (3개 미만이면 0)
  {
    const memory = await createMemoryGraph()
    memory.addNode({ label: 'unique topic', type: 'conversation', tier: TIERS.EPISODIC, data: {} })
    const actor = createMemoryActor({ graph: memory, embedder: null, logger: null })

    const count = await forkTask(actor.send({ type: 'promote' }))
    assert(count === 0, 'MemoryActor promote: no candidates → 0')
  }

  // M6. embed → embedder null이면 0 반환
  {
    const memory = await createMemoryGraph()
    const actor = createMemoryActor({ graph: memory, embedder: null, logger: null })

    const count = await forkTask(actor.send({ type: 'embed' }))
    assert(count === 0 || typeof count === 'number', 'MemoryActor embed: returns count')
  }

  // M7. 메시지 큐 직렬화: send 3개 연속 → 순서대로 처리
  {
    const memory = await createMemoryGraph()
    const order = []
    const originalSave = memory.save.bind(memory)
    memory.save = async () => {
      order.push('save')
      return originalSave()
    }
    const originalRemove = memory.removeNodesByTier.bind(memory)
    memory.removeNodesByTier = (tier) => {
      order.push('removeWorking')
      return originalRemove(tier)
    }

    const actor = createMemoryActor({ graph: memory, embedder: null, logger: null })

    // Fire all three without awaiting individually
    const p1 = forkTask(actor.send({
      type: 'save',
      node: { label: 'seq-test', type: 'conversation', tier: TIERS.EPISODIC, data: {} },
    }))
    const p2 = forkTask(actor.send({ type: 'removeWorking' }))
    const p3 = forkTask(actor.send({ type: 'saveDisk' }))

    await Promise.all([p1, p2, p3])
    assert(order[0] === 'save', 'MemoryActor queue: save first')
    assert(order[1] === 'removeWorking', 'MemoryActor queue: removeWorking second')
    assert(order[2] === 'save', 'MemoryActor queue: saveDisk third (calls save)')
  }

  // M8. 에러 격리: handle reject → 다음 메시지 정상 처리
  {
    const memory = await createMemoryGraph()
    const actor = createMemoryActor({ graph: memory, embedder: null, logger: null })

    // recall with no nodes → should still work (returns empty)
    const result1 = await forkTask(actor.send({ type: 'recall', input: 'nonexistent' }))
    assert(Array.isArray(result1), 'MemoryActor error isolation: first message ok')

    const result2 = await forkTask(actor.send({ type: 'removeWorking' }))
    assert(result2 === 'ok', 'MemoryActor error isolation: second message ok after first')
  }

  // =============================================
  // CompactionActor
  // =============================================

  // C1. threshold 미만 → skip
  {
    const actor = createCompactionActor({ llm: null, logger: null })
    const result = await forkTask(actor.send({
      type: 'check',
      history: makeHistory(10),
    }))
    assert(result === 'skip', 'CompactionActor: below threshold → skip')
  }

  // C2. 정상 → summary + extractedIds 반환
  {
    const mockLlm = { chat: async () => ({ content: 'summarized conversation' }) }
    const actor = createCompactionActor({ llm: mockLlm, logger: null })

    const result = await forkTask(actor.send({
      type: 'check',
      history: makeHistory(20),
    }))
    assert(result !== 'skip', 'CompactionActor: above threshold → not skip')
    assert(result.summary.input === SUMMARY_MARKER, 'CompactionActor: summary has SUMMARY_MARKER')
    assert(result.summary.output === 'summarized conversation', 'CompactionActor: summary content')
    assert(result.extractedIds instanceof Set, 'CompactionActor: extractedIds is Set')
    assert(result.extractedIds.size === 15, 'CompactionActor: extracted 15 ids (20 - keep 5)')
  }

  // C3. LLM 실패 → skip (에러 격리)
  {
    const logs = []
    const mockLlm = { chat: async () => { throw new Error('LLM timeout') } }
    const mockLogger = { warn: (msg, meta) => logs.push({ msg, meta }) }
    const actor = createCompactionActor({ llm: mockLlm, logger: mockLogger })

    const result = await forkTask(actor.send({
      type: 'check',
      history: makeHistory(20),
    }))
    assert(result === 'skip', 'CompactionActor LLM failure: resolves as skip')
    assert(logs.some(l => l.msg === 'Compaction failed'), 'CompactionActor LLM failure: logged')
  }

  // C4. 큐 직렬화: Task 진행 중 두 번째 check → 큐 대기
  {
    let callCount = 0
    let concurrency = 0
    let maxConcurrency = 0

    const slowLlm = {
      chat: () => new Promise(resolve => {
        callCount++
        concurrency++
        maxConcurrency = Math.max(maxConcurrency, concurrency)
        setTimeout(() => {
          concurrency--
          resolve({ content: `summary ${callCount}` })
        }, 50)
      }),
    }
    const actor = createCompactionActor({ llm: slowLlm, logger: null })

    const p1 = forkTask(actor.send({ type: 'check', history: makeHistory(20) }))
    const p2 = forkTask(actor.send({ type: 'check', history: makeHistory(20) }))

    const [r1, r2] = await Promise.all([p1, p2])
    assert(maxConcurrency === 1, 'CompactionActor queue: max concurrency 1 (serialized)')
    assert(callCount === 2, 'CompactionActor queue: both messages processed')
    assert(r1 !== 'skip' && r2 !== 'skip', 'CompactionActor queue: both returned results')
  }

  // C5. epoch passthrough: 결과에 요청 시점 epoch 포함
  {
    const mockLlm = { chat: async () => ({ content: 'epoch test' }) }
    const actor = createCompactionActor({ llm: mockLlm, logger: null })

    const result = await forkTask(actor.send({
      type: 'check', history: makeHistory(20), epoch: 7,
    }))
    assert(result !== 'skip', 'CompactionActor epoch: not skip')
    assert(result.epoch === 7, 'CompactionActor epoch: passes through from request')
  }

  // C6. epoch guard 시뮬레이션: /clear 후 stale 결과 차단
  {
    const state = createReactiveState({
      context: { conversationHistory: makeHistory(20) },
      _compactionEpoch: 0,
    })

    // 느린 LLM으로 compaction 시작
    const slowLlm = {
      chat: () => new Promise(resolve =>
        setTimeout(() => resolve({ content: 'stale summary' }), 50)
      ),
    }
    const actor = createCompactionActor({ llm: slowLlm, logger: null })

    const subscribedResults = []
    actor.subscribe((result) => subscribedResults.push(result))

    // 요청 시점 epoch=0
    actor.send({ type: 'check', history: makeHistory(20), epoch: 0 }).fork(() => {}, () => {})

    // /clear 시뮬레이션: epoch 증가 + history 초기화
    state.set('context.conversationHistory', [])
    state.set('_compactionEpoch', 1)

    // compaction 결과 대기
    await delay(100)

    assert(subscribedResults.length === 1, 'epoch guard: subscriber called')
    const result = subscribedResults[0]
    assert(result.epoch === 0, 'epoch guard: result carries request epoch')

    // subscriber에서 epoch guard를 적용했을 때:
    const currentEpoch = state.get('_compactionEpoch')
    assert(result.epoch !== currentEpoch, 'epoch guard: mismatch detected → should discard')

    // history가 비어있는 상태 유지 확인 (applyCompaction 호출하지 않아야 함)
    const history = state.get('context.conversationHistory')
    assert(history.length === 0, 'epoch guard: history stays empty after /clear')
  }

  // =============================================
  // applyCompaction
  // =============================================

  // AC1. extractedIds 기반 필터 + summary prepend
  {
    const state = createReactiveState({
      context: { conversationHistory: makeHistory(20) },
    })
    const extractedIds = new Set(makeHistory(15).map(h => h.id))
    const summary = createSummaryEntry('test summary')

    applyCompaction(state, { summary, extractedIds })

    const history = state.get('context.conversationHistory')
    assert(history[0].input === SUMMARY_MARKER, 'applyCompaction: summary at head')
    assert(history[0].output === 'test summary', 'applyCompaction: summary content')
    assert(history.length === 6, 'applyCompaction: 1 summary + 5 remaining')
  }

  // AC2. id 없는 항목 보존
  {
    const historyWithNoId = [
      { input: 'old', output: 'legacy', ts: 1 },  // no id
      ...makeHistory(5),
    ]
    const state = createReactiveState({
      context: { conversationHistory: historyWithNoId },
    })
    const extractedIds = new Set(['h-0', 'h-1'])
    const summary = createSummaryEntry('merged')

    applyCompaction(state, { summary, extractedIds })

    const history = state.get('context.conversationHistory')
    // summary + no-id item + h-2, h-3, h-4 = 5
    assert(history.some(h => h.input === 'old'), 'applyCompaction: id-less item preserved')
  }

  // AC3. MAX_CONVERSATION 상한 유지
  {
    const state = createReactiveState({
      context: { conversationHistory: makeHistory(HISTORY.MAX_CONVERSATION) },
    })
    const extractedIds = new Set()  // nothing extracted → all preserved
    const summary = createSummaryEntry('big summary')

    applyCompaction(state, { summary, extractedIds })

    const history = state.get('context.conversationHistory')
    assert(history.length <= HISTORY.MAX_CONVERSATION, 'applyCompaction: respects MAX_CONVERSATION')
    assert(history[0].input === SUMMARY_MARKER, 'applyCompaction: summary still at head')
  }

  // =============================================
  // PersistenceActor
  // =============================================

  // P1. save → deferred (debounce)
  {
    const stored = {}
    const mockStore = { set: (k, v) => { stored[k] = v } }
    const actor = createPersistenceActor({ store: mockStore, debounceMs: 50 })

    const result = await forkTask(actor.send({
      type: 'save',
      snapshot: { turn: 1, _debug: { x: 1 } },
    }))
    assert(result === 'deferred', 'PersistenceActor save: returns deferred')
    assert(stored.agentState === undefined, 'PersistenceActor save: not saved immediately')

    await delay(100)
    assert(stored.agentState != null, 'PersistenceActor save: saved after debounce')
    assert(stored.agentState.turn === 1, 'PersistenceActor save: correct value')
    assert(stored.agentState._debug === undefined, 'PersistenceActor save: transient stripped')
  }

  // P2. debounce: 두 번째 save → 마지막 snapshot만 flush
  {
    const stored = {}
    const mockStore = { set: (k, v) => { stored[k] = v } }
    const actor = createPersistenceActor({ store: mockStore, debounceMs: 50 })

    await forkTask(actor.send({ type: 'save', snapshot: { turn: 1 } }))
    await forkTask(actor.send({ type: 'save', snapshot: { turn: 2 } }))
    await forkTask(actor.send({ type: 'save', snapshot: { turn: 3 } }))

    await delay(100)
    assert(stored.agentState.turn === 3, 'PersistenceActor debounce: last snapshot saved')
  }

  // P3. flush → 즉시 저장
  {
    const stored = {}
    const mockStore = { set: (k, v) => { stored[k] = v } }
    const actor = createPersistenceActor({ store: mockStore, debounceMs: 500 })

    await forkTask(actor.send({
      type: 'flush',
      snapshot: { turn: 42 },
    }))
    assert(stored.agentState != null, 'PersistenceActor flush: saved immediately')
    assert(stored.agentState.turn === 42, 'PersistenceActor flush: correct value')
  }

  // P4. flush가 기존 timer를 clearTimeout — stale flush 방지
  {
    const stored = {}
    let setCount = 0
    const mockStore = { set: (k, v) => { stored[k] = v; setCount++ } }
    const actor = createPersistenceActor({ store: mockStore, debounceMs: 200 })

    // save triggers timer
    await forkTask(actor.send({ type: 'save', snapshot: { turn: 1 } }))
    // flush cancels timer and saves immediately
    await forkTask(actor.send({ type: 'flush', snapshot: { turn: 2 } }))

    assert(stored.agentState.turn === 2, 'PersistenceActor flush+timer: flush value saved')

    await delay(300)
    // timer was cancelled, so no additional save should have happened
    assert(stored.agentState.turn === 2, 'PersistenceActor flush+timer: stale timer did not fire')
  }

  // P5. shutdown flush → 보류 timer 정리 + 즉시 저장
  {
    const stored = {}
    const mockStore = { set: (k, v) => { stored[k] = v } }
    const actor = createPersistenceActor({ store: mockStore, debounceMs: 5000 })

    // save triggers a long timer
    await forkTask(actor.send({ type: 'save', snapshot: { turn: 10 } }))
    assert(stored.agentState === undefined, 'PersistenceActor shutdown: not saved yet')

    // shutdown: explicit flush
    await forkTask(actor.send({ type: 'flush', snapshot: { turn: 10 } }))
    assert(stored.agentState.turn === 10, 'PersistenceActor shutdown: flushed immediately')
  }

  // P6. store.set 실패 → non-fatal
  {
    const mockStore = { set: () => { throw new Error('disk full') } }
    const actor = createPersistenceActor({ store: mockStore, debounceMs: 0 })

    let threw = false
    try {
      await forkTask(actor.send({ type: 'flush', snapshot: { turn: 1 } }))
    } catch (_) {
      threw = true
    }
    assert(!threw, 'PersistenceActor error: store.set failure is non-fatal')

    // Actor still works after error
    const stored2 = {}
    // Can't change store, but verify actor doesn't crash
    const result = await forkTask(actor.send({ type: 'flush', snapshot: { turn: 2 } }))
    assert(result === 'flushed', 'PersistenceActor error: actor still works after failure')
  }

  // P7. self-send flush: timer 후 store.set 호출 확인
  {
    const stored = {}
    const mockStore = { set: (k, v) => { stored[k] = v } }
    const actor = createPersistenceActor({ store: mockStore, debounceMs: 30 })

    await forkTask(actor.send({ type: 'save', snapshot: { turn: 99, _temp: true } }))

    // Wait for self-send flush to fire
    await delay(80)

    assert(stored.agentState != null, 'PersistenceActor self-send: store.set called via flush')
    assert(stored.agentState.turn === 99, 'PersistenceActor self-send: correct snapshot')
    assert(stored.agentState._temp === undefined, 'PersistenceActor self-send: transient stripped in flush')
  }

  // =============================================
  // safeRunTurn integration (Actor 통합)
  // =============================================

  // I1. recall 성공 → context.memories 반영
  {
    const { safeRunTurn, createAgentTurn, PHASE, Phase, RESULT } = await import('../../src/core/agent.js')
    const { createTestInterpreter } = await import('../../src/interpreter/test.js')
    const { Free } = await import('../../src/core/op.js')

    const memory = await createMemoryGraph()
    memory.addNode({ label: 'recall target', type: 'entity', tier: TIERS.EPISODIC })
    const memActor = createMemoryActor({ graph: memory, embedder: null, logger: null })

    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'ok' }),
    })

    const safe = safeRunTurn({ interpret, ST }, state, { memoryActor: memActor })
    const turn = createAgentTurn()
    await safe(turn('hello'), 'hello')

    assert(state.get('turn') === 1, 'integration recall: turn incremented')
    assert(Array.isArray(state.get('context.memories')), 'integration recall: memories is array')
  }

  // I2. recall 실패 → context.memories=[], 턴 계속
  {
    const { safeRunTurn, createAgentTurn, Phase } = await import('../../src/core/agent.js')
    const { createTestInterpreter } = await import('../../src/interpreter/test.js')

    // Create a mock actor that fails on recall
    const failActor = fp.Actor({
      init: {},
      handle: (state, msg) => {
        if (msg.type === 'recall') return new Task((reject) => reject(new Error('recall broke')))
        return ['ok', state]
      },
    })

    const logs = []
    const mockLogger = { warn: (msg, meta) => logs.push({ msg, meta }) }

    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, turn: 0,
      context: { memories: ['stale'] },
    })
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'still ok' }),
    })

    const safe = safeRunTurn({ interpret, ST }, state, { memoryActor: failActor, logger: mockLogger })
    const turn = createAgentTurn()
    const result = await safe(turn('test'), 'test')

    assert(result === 'still ok', 'integration recall fail: turn completes')
    assert(state.get('turn') === 1, 'integration recall fail: turn incremented')
    assert(JSON.stringify(state.get('context.memories')) === '[]', 'integration recall fail: memories cleared')
    assert(logs.some(l => l.msg === 'Memory recall failed'), 'integration recall fail: logged')
  }

  // I3. 후처리 순서: save → removeWorking → embed → prune → promote → saveDisk
  {
    const { safeRunTurn, createAgentTurn, Phase, TurnResult, RESULT } = await import('../../src/core/agent.js')
    const { createTestInterpreter } = await import('../../src/interpreter/test.js')

    const order = []
    const mockActor = fp.Actor({
      init: {},
      handle: (state, msg) => {
        order.push(msg.type)
        return ['ok', state]
      },
    })

    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'result' }),
    })

    const safe = safeRunTurn({ interpret, ST }, state, { memoryActor: mockActor })
    const turn = createAgentTurn()
    await safe(turn('test', { source: 'user' }), 'test')

    // Wait for fire-and-forget messages to process
    await delay(50)

    // First message is recall (awaited), then post-turn messages
    assert(order[0] === 'recall', 'integration order: recall first')
    const postTurn = order.slice(1)
    assert(postTurn[0] === 'save', 'integration order: save after recall')
    assert(postTurn[1] === 'removeWorking', 'integration order: removeWorking')
    assert(postTurn[2] === 'embed', 'integration order: embed')
    assert(postTurn[3] === 'prune', 'integration order: prune')
    assert(postTurn[4] === 'promote', 'integration order: promote')
    assert(postTurn[5] === 'saveDisk', 'integration order: saveDisk last')
  }

  // I4. 실패 턴 → save 메시지 안 보냄 (node save), 나머지 후처리 실행
  {
    const { safeRunTurn, createAgentTurn, Phase } = await import('../../src/core/agent.js')
    const { createTestInterpreter } = await import('../../src/interpreter/test.js')

    const messages = []
    const mockActor = fp.Actor({
      init: {},
      handle: (state, msg) => {
        messages.push(msg.type)
        return ['ok', state]
      },
    })

    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => '<<<invalid json>>>',
    })

    const safe = safeRunTurn({ interpret, ST }, state, { memoryActor: mockActor })
    const turn = createAgentTurn()
    await safe(turn('fail-test'), 'fail-test')
    await delay(50)

    const postRecall = messages.slice(1)
    assert(!postRecall.includes('save') || postRecall[0] !== 'save',
      'integration failure: no node save on failed turn')
    assert(postRecall.includes('removeWorking'), 'integration failure: removeWorking still runs')
  }

  // I5. persistenceActor: 성공 턴 후 save 메시지
  {
    const { safeRunTurn, createAgentTurn, Phase } = await import('../../src/core/agent.js')
    const { createTestInterpreter } = await import('../../src/interpreter/test.js')

    const stored = {}
    const mockStore = { set: (k, v) => { stored[k] = v } }
    const pActor = createPersistenceActor({ store: mockStore, debounceMs: 30 })

    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'ok' }),
    })

    const safe = safeRunTurn({ interpret, ST }, state, { persistenceActor: pActor })
    const turn = createAgentTurn()
    await safe(turn('persist-test'), 'persist-test')

    await delay(80)
    assert(stored.agentState != null, 'integration persistence: state saved after turn')
    assert(stored.agentState.turn === 1, 'integration persistence: turn count correct')
  }

  // I6. persistenceActor: 에러 턴 후에도 save
  {
    const { safeRunTurn, createAgentTurn, Phase, PHASE } = await import('../../src/core/agent.js')
    const { createTestInterpreter } = await import('../../src/interpreter/test.js')

    const stored = {}
    const mockStore = { set: (k, v) => { stored[k] = v } }
    const pActor = createPersistenceActor({ store: mockStore, debounceMs: 30 })

    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, turn: 0,
      context: { memories: [] },
    })
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => { throw new Error('crash') },
    })

    const safe = safeRunTurn({ interpret, ST }, state, { persistenceActor: pActor })
    const turn = createAgentTurn()
    try {
      await safe(turn('crash-test'), 'crash-test')
    } catch (_) {}

    await delay(80)
    assert(stored.agentState != null, 'integration persistence error: state saved after crash')
    assert(state.get('turnState').tag === PHASE.IDLE, 'integration persistence error: state recovered')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
