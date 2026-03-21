import { createMemoryGraph, TIERS } from '../../src/infra/memory.js'
import { createReactiveState } from '../../src/infra/state.js'
import { PHASE, RESULT, Phase, TurnResult, ErrorInfo, ERROR_KIND } from '../../src/core/agent.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

// Wire up memory hooks (same logic that main.js uses)
const wireMemoryHooks = (state, memory) => {
  // On turn start (turnState=working): recall relevant memories → inject into state
  state.hooks.on('turnState', async (phase, s) => {
    if (phase.tag === PHASE.WORKING && phase.input) {
      const memories = await memory.recall(phase.input)
      s.set('context.memories', memories.map(n => n.label))
    }
  })

  // On turn end (turnState=idle): cleanup always, save episodic on success only
  state.hooks.on('turnState', async (phase, s) => {
    if (phase.tag !== PHASE.IDLE) return

    // cleanup은 성공/실패 무관하게 항상
    memory.removeNodesByTier(TIERS.WORKING)

    // episodic 저장은 성공 턴만
    const lastTurn = s.get('lastTurn')
    if (lastTurn && lastTurn.tag === RESULT.SUCCESS) {
      memory.addNode({
        label: lastTurn.input || 'unknown',
        type: 'conversation',
        tier: TIERS.EPISODIC,
        data: {
          input: lastTurn.input,
          output: lastTurn.result,
        }
      })
    }
  })
}

// Promotion logic: entities mentioned 3+ times get promoted
const wirePromotionHook = (state, memory) => {
  const mentionCount = new Map()

  state.hooks.on('turnState', (phase) => {
    if (phase.tag !== PHASE.WORKING || !phase.input) return
    const words = phase.input.split(/\s+/).filter(w => w.length > 1)
    for (const word of words) {
      const count = (mentionCount.get(word) || 0) + 1
      mentionCount.set(word, count)

      if (count >= 3) {
        const nodes = memory.findNodesByLabel(word)
        for (const node of nodes) {
          if (node.tier === TIERS.EPISODIC) {
            memory.promoteNode(node.id, TIERS.SEMANTIC)
          }
        }
      }
    }
  })
}

async function run() {
  console.log('Memory hook integration tests')

  // 1. Turn start → memories injected into state
  {
    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, context: {}
    })
    const memory = await createMemoryGraph()

    const n1 = memory.addNode({ label: '회의' })
    const n2 = memory.addNode({ label: '팀미팅' })
    memory.addEdge(n1.id, n2.id, '관련')

    wireMemoryHooks(state, memory)

    state.set('turnState', Phase.working('회의 안건'))
    await new Promise(r => setTimeout(r, 50))

    const mems = state.get('context.memories')
    assert(Array.isArray(mems), 'turn start: memories injected')
    assert(mems.includes('회의'), 'turn start: includes matched node')
    assert(mems.includes('팀미팅'), 'turn start: includes connected node')
  }

  // 2. Turn end → working memory cleaned
  {
    const state = createReactiveState({
      turnState: Phase.working('test'), lastTurn: null, context: {}
    })
    const memory = await createMemoryGraph()

    memory.addNode({ label: 'temp-work', tier: TIERS.WORKING })
    assert(memory.getNodesByTier(TIERS.WORKING).length === 1, 'before idle: 1 working node')

    wireMemoryHooks(state, memory)

    state.set('lastTurn', TurnResult.success('test', 'done'))
    state.set('turnState', Phase.idle())
    await new Promise(r => setTimeout(r, 50))

    assert(memory.getNodesByTier(TIERS.WORKING).length === 0, 'turn end: working memory cleaned')
  }

  // 3. Turn end → episodic record added
  {
    const state = createReactiveState({
      turnState: Phase.working('PR 현황'), lastTurn: null, context: {}
    })
    const memory = await createMemoryGraph()

    wireMemoryHooks(state, memory)

    state.set('lastTurn', TurnResult.success('PR 현황', 'PR 3건'))
    state.set('turnState', Phase.idle())
    await new Promise(r => setTimeout(r, 50))

    const episodic = memory.getNodesByTier(TIERS.EPISODIC)
    assert(episodic.length === 1, 'turn end: episodic record added')
    assert(episodic[0].data.input === 'PR 현황', 'turn end: episodic has input')
    assert(episodic[0].data.output === 'PR 3건', 'turn end: episodic has output')
  }

  // 4. Failed turn → episodic NOT saved, working memory still cleaned
  {
    const state = createReactiveState({
      turnState: Phase.working('crash me'), lastTurn: null, context: {}
    })
    const memory = await createMemoryGraph()

    memory.addNode({ label: 'temp', tier: TIERS.WORKING })
    assert(memory.getNodesByTier(TIERS.WORKING).length === 1, 'failed turn: 1 working node before')

    wireMemoryHooks(state, memory)

    state.set('lastTurn', TurnResult.failure('crash me',
      ErrorInfo('parse error', ERROR_KIND.PLANNER_PARSE), '오류 메시지'))
    state.set('turnState', Phase.idle())
    await new Promise(r => setTimeout(r, 50))

    assert(memory.getNodesByTier(TIERS.EPISODIC).length === 0, 'failed turn: no episodic record')
    assert(memory.getNodesByTier(TIERS.WORKING).length === 0, 'failed turn: working memory cleaned')
  }

  // 5. Success after failure → only success saved
  {
    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, context: {}
    })
    const memory = await createMemoryGraph()

    wireMemoryHooks(state, memory)

    // Turn 1: failure
    state.set('turnState', Phase.working('bad input'))
    await new Promise(r => setTimeout(r, 20))
    state.set('lastTurn', TurnResult.failure('bad input',
      ErrorInfo('err', ERROR_KIND.PLANNER_PARSE), '오류'))
    state.set('turnState', Phase.idle())
    await new Promise(r => setTimeout(r, 20))

    assert(memory.getNodesByTier(TIERS.EPISODIC).length === 0,
      'after failed turn: no episodic record')

    // Turn 2: success
    state.set('turnState', Phase.working('good input'))
    await new Promise(r => setTimeout(r, 20))
    state.set('lastTurn', TurnResult.success('good input', '성공 응답'))
    state.set('turnState', Phase.idle())
    await new Promise(r => setTimeout(r, 20))

    const episodic = memory.getNodesByTier(TIERS.EPISODIC)
    assert(episodic.length === 1, 'after success turn: exactly 1 episodic record')
    assert(episodic[0].data.output === '성공 응답', 'after success turn: correct output saved')
  }

  // 6. Promotion: 3+ mentions → episodic → semantic
  {
    const state = createReactiveState({ turnState: Phase.idle() })
    const memory = await createMemoryGraph()

    const node = memory.addNode({ label: 'React', tier: TIERS.EPISODIC })
    wirePromotionHook(state, memory)

    state.set('turnState', Phase.working('React 배우기'))
    state.set('turnState', Phase.working('React 컴포넌트'))
    assert(memory.findNode(node.id).value.tier === TIERS.EPISODIC, 'before 3rd: still episodic')

    state.set('turnState', Phase.working('React hooks'))
    assert(memory.findNode(node.id).value.tier === TIERS.SEMANTIC, 'after 3rd: promoted to semantic')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
