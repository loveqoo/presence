import { createMemoryGraph, TIERS } from '../../src/infra/memory.js'
import { createReactiveState } from '../../src/infra/state.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

// Wire up memory hooks (same logic that main.js would use)
const wireMemoryHooks = (state, memory) => {
  // On turn start (status=working): recall relevant memories → inject into state
  state.hooks.on('status', async (value, s) => {
    if (value === 'working') {
      const input = s.get('currentInput')
      if (input) {
        const memories = memory.recall(input)
        s.set('context.memories', memories.map(n => n.label))
      }
    }
  })

  // On turn end (status=idle): clean up working memory, save episodic
  state.hooks.on('status', async (value, s) => {
    if (value === 'idle' && s.get('lastResult')) {
      // Save to episodic
      memory.addNode({
        label: s.get('currentInput') || 'unknown',
        type: 'conversation',
        tier: TIERS.EPISODIC,
        data: {
          input: s.get('currentInput'),
          output: s.get('lastResult'),
        }
      })
      // Clean working memory
      memory.removeNodesByTier(TIERS.WORKING)
    }
  })
}

// Promotion logic: entities mentioned 3+ times get promoted
const wirePromotionHook = (state, memory) => {
  const mentionCount = new Map()

  state.hooks.on('currentInput', (input) => {
    if (!input) return
    // Simple keyword extraction
    const words = input.split(/\s+/).filter(w => w.length > 1)
    for (const word of words) {
      const count = (mentionCount.get(word) || 0) + 1
      mentionCount.set(word, count)

      if (count >= 3) {
        // Check if there's an episodic node with this label
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
    const state = createReactiveState({ status: 'idle', currentInput: null, context: {} })
    const memory = await createMemoryGraph()

    // Seed some memory
    const n1 = memory.addNode({ label: '회의' })
    const n2 = memory.addNode({ label: '팀미팅' })
    memory.addEdge(n1.id, n2.id, '관련')

    wireMemoryHooks(state, memory)

    state.set('currentInput', '회의 안건')
    state.set('status', 'working')
    await new Promise(r => setTimeout(r, 50))

    const mems = state.get('context.memories')
    assert(Array.isArray(mems), 'turn start: memories injected')
    assert(mems.includes('회의'), 'turn start: includes matched node')
    assert(mems.includes('팀미팅'), 'turn start: includes connected node')
  }

  // 2. Turn end → working memory cleaned
  {
    const state = createReactiveState({ status: 'idle', currentInput: 'test', lastResult: null, context: {} })
    const memory = await createMemoryGraph()

    memory.addNode({ label: 'temp-work', tier: TIERS.WORKING })
    assert(memory.getNodesByTier(TIERS.WORKING).length === 1, 'before idle: 1 working node')

    wireMemoryHooks(state, memory)

    state.set('lastResult', 'done')
    state.set('status', 'idle')
    await new Promise(r => setTimeout(r, 50))

    assert(memory.getNodesByTier(TIERS.WORKING).length === 0, 'turn end: working memory cleaned')
  }

  // 3. Turn end → episodic record added
  {
    const state = createReactiveState({ status: 'working', currentInput: 'PR 현황', lastResult: null, context: {} })
    const memory = await createMemoryGraph()

    wireMemoryHooks(state, memory)

    state.set('lastResult', 'PR 3건')
    state.set('status', 'idle')
    await new Promise(r => setTimeout(r, 50))

    const episodic = memory.getNodesByTier(TIERS.EPISODIC)
    assert(episodic.length === 1, 'turn end: episodic record added')
    assert(episodic[0].data.input === 'PR 현황', 'turn end: episodic has input')
    assert(episodic[0].data.output === 'PR 3건', 'turn end: episodic has output')
  }

  // 4. Promotion: 3+ mentions → episodic → semantic
  {
    const state = createReactiveState({ currentInput: null })
    const memory = await createMemoryGraph()

    const node = memory.addNode({ label: 'React', tier: TIERS.EPISODIC })
    wirePromotionHook(state, memory)

    state.set('currentInput', 'React 배우기')
    state.set('currentInput', 'React 컴포넌트')
    assert(memory.findNode(node.id).tier === TIERS.EPISODIC, 'before 3rd: still episodic')

    state.set('currentInput', 'React hooks')
    assert(memory.findNode(node.id).tier === TIERS.SEMANTIC, 'after 3rd: promoted to semantic')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
