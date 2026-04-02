import { createMemoryGraph, TIERS } from '@presence/infra/infra/memory.js'
import { createReactiveState } from '@presence/infra/infra/state.js'
import { PHASE, RESULT, ERROR_KIND, TurnState, TurnOutcome, TurnError } from '@presence/core/core/policies.js'
import { assert, summary } from '../lib/assert.js'

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

  // 1. Turn start without embedder → no memories recalled
  {
    const state = createReactiveState({
      turnState: TurnState.idle(), lastTurn: null, context: {}
    })
    const memory = await createMemoryGraph()

    memory.addNode({ label: '회의' })
    memory.addNode({ label: '팀미팅' })

    wireMemoryHooks(state, memory)

    state.set('turnState', TurnState.working('회의 안건'))
    await new Promise(r => setTimeout(r, 50))

    const mems = state.get('context.memories')
    assert(Array.isArray(mems), 'turn start: memories array set')
    assert(mems.length === 0, 'turn start: no recall without embedder')
  }

  // 2. Turn end → working memory cleaned
  {
    const state = createReactiveState({
      turnState: TurnState.working('test'), lastTurn: null, context: {}
    })
    const memory = await createMemoryGraph()

    memory.addNode({ label: 'temp-work', tier: TIERS.WORKING })
    assert(memory.getNodesByTier(TIERS.WORKING).length === 1, 'before idle: 1 working node')

    wireMemoryHooks(state, memory)

    state.set('lastTurn', TurnOutcome.success('test', 'done'))
    state.set('turnState', TurnState.idle())
    await new Promise(r => setTimeout(r, 50))

    assert(memory.getNodesByTier(TIERS.WORKING).length === 0, 'turn end: working memory cleaned')
  }

  // 3. Turn end → episodic record added
  {
    const state = createReactiveState({
      turnState: TurnState.working('PR 현황'), lastTurn: null, context: {}
    })
    const memory = await createMemoryGraph()

    wireMemoryHooks(state, memory)

    state.set('lastTurn', TurnOutcome.success('PR 현황', 'PR 3건'))
    state.set('turnState', TurnState.idle())
    await new Promise(r => setTimeout(r, 50))

    const episodic = memory.getNodesByTier(TIERS.EPISODIC)
    assert(episodic.length === 1, 'turn end: episodic record added')
    assert(episodic[0].data.input === 'PR 현황', 'turn end: episodic has input')
    assert(episodic[0].data.output === 'PR 3건', 'turn end: episodic has output')
  }

  // 4. Failed turn → episodic NOT saved, working memory still cleaned
  {
    const state = createReactiveState({
      turnState: TurnState.working('crash me'), lastTurn: null, context: {}
    })
    const memory = await createMemoryGraph()

    memory.addNode({ label: 'temp', tier: TIERS.WORKING })
    assert(memory.getNodesByTier(TIERS.WORKING).length === 1, 'failed turn: 1 working node before')

    wireMemoryHooks(state, memory)

    state.set('lastTurn', TurnOutcome.failure('crash me',
      TurnError('parse error', ERROR_KIND.PLANNER_PARSE), '오류 메시지'))
    state.set('turnState', TurnState.idle())
    await new Promise(r => setTimeout(r, 50))

    assert(memory.getNodesByTier(TIERS.EPISODIC).length === 0, 'failed turn: no episodic record')
    assert(memory.getNodesByTier(TIERS.WORKING).length === 0, 'failed turn: working memory cleaned')
  }

  // 5. Success after failure → only success saved
  {
    const state = createReactiveState({
      turnState: TurnState.idle(), lastTurn: null, context: {}
    })
    const memory = await createMemoryGraph()

    wireMemoryHooks(state, memory)

    // Turn 1: failure
    state.set('turnState', TurnState.working('bad input'))
    await new Promise(r => setTimeout(r, 20))
    state.set('lastTurn', TurnOutcome.failure('bad input',
      TurnError('err', ERROR_KIND.PLANNER_PARSE), '오류'))
    state.set('turnState', TurnState.idle())
    await new Promise(r => setTimeout(r, 20))

    assert(memory.getNodesByTier(TIERS.EPISODIC).length === 0,
      'after failed turn: no episodic record')

    // Turn 2: success
    state.set('turnState', TurnState.working('good input'))
    await new Promise(r => setTimeout(r, 20))
    state.set('lastTurn', TurnOutcome.success('good input', '성공 응답'))
    state.set('turnState', TurnState.idle())
    await new Promise(r => setTimeout(r, 20))

    const episodic = memory.getNodesByTier(TIERS.EPISODIC)
    assert(episodic.length === 1, 'after success turn: exactly 1 episodic record')
    assert(episodic[0].data.output === '성공 응답', 'after success turn: correct output saved')
  }

  // 6. Promotion: 3+ mentions → episodic → semantic
  {
    const state = createReactiveState({ turnState: TurnState.idle() })
    const memory = await createMemoryGraph()

    const node = memory.addNode({ label: 'React', tier: TIERS.EPISODIC })
    wirePromotionHook(state, memory)

    state.set('turnState', TurnState.working('React 배우기'))
    state.set('turnState', TurnState.working('React 컴포넌트'))
    assert(memory.findNode(node.id).value.tier === TIERS.EPISODIC, 'before 3rd: still episodic')

    state.set('turnState', TurnState.working('React hooks'))
    assert(memory.findNode(node.id).value.tier === TIERS.SEMANTIC, 'after 3rd: promoted to semantic')
  }

  // 7. 동일 턴 반복 → episodic 중복 없음
  {
    const state = createReactiveState({
      turnState: TurnState.idle(), lastTurn: null, context: {}
    })
    const memory = await createMemoryGraph()

    wireMemoryHooks(state, memory)

    // Turn 1
    state.set('turnState', TurnState.working('PR 현황'))
    await new Promise(r => setTimeout(r, 20))
    state.set('lastTurn', TurnOutcome.success('PR 현황', 'PR 3건'))
    state.set('turnState', TurnState.idle())
    await new Promise(r => setTimeout(r, 20))

    // Turn 2 — 동일 입력/출력
    state.set('turnState', TurnState.working('PR 현황'))
    await new Promise(r => setTimeout(r, 20))
    state.set('lastTurn', TurnOutcome.success('PR 현황', 'PR 3건'))
    state.set('turnState', TurnState.idle())
    await new Promise(r => setTimeout(r, 20))

    const episodic = memory.getNodesByTier(TIERS.EPISODIC)
    assert(episodic.length === 1, 'dedup hook: identical turns → 1 node only')
  }

  // 8. 같은 질문, 다른 응답 → 최신으로 갱신 (1개 유지)
  {
    const state = createReactiveState({
      turnState: TurnState.idle(), lastTurn: null, context: {}
    })
    const memory = await createMemoryGraph()

    wireMemoryHooks(state, memory)

    state.set('turnState', TurnState.working('PR 현황'))
    await new Promise(r => setTimeout(r, 20))
    state.set('lastTurn', TurnOutcome.success('PR 현황', 'PR 3건'))
    state.set('turnState', TurnState.idle())
    await new Promise(r => setTimeout(r, 20))

    state.set('turnState', TurnState.working('PR 현황'))
    await new Promise(r => setTimeout(r, 20))
    state.set('lastTurn', TurnOutcome.success('PR 현황', 'PR 5건'))
    state.set('turnState', TurnState.idle())
    await new Promise(r => setTimeout(r, 20))

    const episodic = memory.getNodesByTier(TIERS.EPISODIC)
    assert(episodic.length === 1, 'dedup hook: same question → 1 node')
    assert(episodic[0].data.output === 'PR 5건', 'dedup hook: output updated to latest')
  }

  summary()
}

run()
