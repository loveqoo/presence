import { initI18n } from '@presence/infra/i18n'
initI18n('ko')
import { assemblePrompt, buildIterationPrompt } from '@presence/core/core/prompt/assembly.js'
import { flattenHistory, fitHistory, fitMemories, buildIterationBlock } from '@presence/core/core/prompt/budget.js'
import { measureMessages } from '@presence/core/lib/tokenizer.js'
import { PHASE, RESULT, TurnState } from '@presence/core/core/policies.js'
import { Agent } from '@presence/core/core/agent.js'
import { makeTestAgent } from '../../../../test/lib/test-agent.js'
import { createTestInterpreter } from '@presence/core/interpreter/test.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'

const initState = (overrides = {}) =>
  createOriginState({ turnState: TurnState.idle(), lastTurn: null, turn: 0, context: { memories: [] }, ...overrides })

import { assert, summary } from '../../../../test/lib/assert.js'

async function run() {
  console.log('Assembly + Budget + History tests')

  // =========================================
  // measureMessages
  // =========================================

  {
    const msgs = [
      { role: 'system', content: 'hello' },
      { role: 'user', content: 'world' },
    ]
    const result = measureMessages(msgs)
    // estimateTokens('hello')=2 + 4 + estimateTokens('world')=2 + 4 = 12
    assert(result === 12, 'measureMessages: basic measurement')
  }

  {
    assert(measureMessages([]) === 0, 'measureMessages: empty array')
  }

  {
    const msgs = [{ role: 'user', content: '' }]
    assert(measureMessages(msgs) === 4, 'measureMessages: empty content = overhead only')
  }

  // =========================================
  // flattenHistory
  // =========================================

  {
    const turns = [
      { input: 'hi', output: 'hello', ts: 1 },
      { input: 'bye', output: 'goodbye', ts: 2 },
    ]
    const flat = flattenHistory(turns)
    assert(flat.length === 4, 'flattenHistory: 2 turns → 4 messages')
    assert(flat[0].role === 'user' && flat[0].content === 'hi', 'flattenHistory: first user')
    assert(flat[1].role === 'assistant' && flat[1].content === 'hello', 'flattenHistory: first assistant')
    assert(flat[2].role === 'user' && flat[2].content === 'bye', 'flattenHistory: second user')
    assert(flat[3].role === 'assistant' && flat[3].content === 'goodbye', 'flattenHistory: second assistant')
  }

  {
    assert(flattenHistory([]).length === 0, 'flattenHistory: empty → empty')
  }

  // =========================================
  // fitHistory
  // =========================================

  {
    const turns = [
      { input: 'a', output: 'b', ts: 1 },
      { input: 'c', output: 'd', ts: 2 },
      { input: 'e', output: 'f', ts: 3 },
    ]
    // Each turn: 2 messages, each estimateTokens(1 char)=1 + 4 overhead = 10 tokens/turn
    const all = fitHistory(turns, 10000)
    assert(all.length === 3, 'fitHistory: infinite budget → all turns')
  }

  {
    const turns = [
      { input: 'a', output: 'b', ts: 1 },
      { input: 'c', output: 'd', ts: 2 },
      { input: 'e', output: 'f', ts: 3 },
    ]
    // Each turn costs: (1+4) + (1+4) = 10 tokens
    // Budget 25 → fits 2 turns (20), not 3 (30)
    const fitted = fitHistory(turns, 25)
    assert(fitted.length === 2, 'fitHistory: tight budget → newest 2 turns')
    assert(fitted[0].input === 'c', 'fitHistory: oldest dropped, newest kept (first)')
    assert(fitted[1].input === 'e', 'fitHistory: oldest dropped, newest kept (second)')
  }

  {
    const turns = [
      { input: 'a', output: 'b', ts: 1 },
    ]
    const fitted = fitHistory(turns, 5)
    assert(fitted.length === 0, 'fitHistory: budget too small → empty')
  }

  {
    assert(fitHistory([], 10000).length === 0, 'fitHistory: empty turns → empty')
  }

  {
    assert(fitHistory([], 0).length === 0, 'fitHistory: zero budget → empty')
  }

  // =========================================
  // fitMemories
  // =========================================

  {
    const mems = ['short', 'also short']
    const fitted = fitMemories(mems, 10000)
    assert(fitted.length === 2, 'fitMemories: all fit with large budget')
  }

  {
    // MEMORY_PROMPT_OVERHEAD (6) + [1] short (3+1=4) = 10, + [2] also short (4+1=5) = 15
    // Budget 12 → fits first (10), not both (15)
    const fitted = fitMemories(['short', 'also short'], 12)
    assert(fitted.length === 1, 'fitMemories: only first fits')
    assert(fitted[0] === 'short', 'fitMemories: first memory included')
  }

  {
    assert(fitMemories([], 10000).length === 0, 'fitMemories: empty → empty')
    assert(fitMemories(null, 10000).length === 0, 'fitMemories: null → empty')
  }

  {
    const fitted = fitMemories(['hello'], 0)
    assert(fitted.length === 0, 'fitMemories: zero budget → empty')
  }

  {
    const fitted = fitMemories(['hello'], 5)
    assert(fitted.length === 0, 'fitMemories: budget below header overhead → empty')
  }

  // =========================================
  // buildIterationBlock
  // =========================================

  {
    assert(buildIterationBlock(null).length === 0, 'buildIterationBlock: null → empty')
    assert(buildIterationBlock({}).length === 0, 'buildIterationBlock: empty → empty')
    assert(buildIterationBlock({ previousPlan: null }).length === 0, 'buildIterationBlock: no plan → empty')
  }

  {
    const ctx = {
      previousPlan: { type: 'plan', steps: [{ op: 'EXEC' }] },
      previousResults: 'some result',
    }
    const block = buildIterationBlock(ctx)
    assert(block.length === 2, 'buildIterationBlock full: 2 messages')
    assert(block[0].role === 'assistant', 'buildIterationBlock full: assistant message')
    assert(block[1].role === 'user', 'buildIterationBlock full: user message')
    assert(block[1].content.includes('some result'), 'buildIterationBlock full: includes results')
    assert(block[1].content.includes('Step results'), 'buildIterationBlock full: includes header')
  }

  {
    const longResult = 'x'.repeat(500)
    const ctx = {
      previousPlan: { type: 'plan', steps: [] },
      previousResults: longResult,
    }
    const blockFull = buildIterationBlock(ctx, 'full')
    const blockSumm = buildIterationBlock(ctx, 'summarized')
    assert(blockFull[1].content.includes(longResult), 'buildIterationBlock: full preserves long result')
    assert(blockSumm[1].content.includes('...(summarized)'), 'buildIterationBlock: summarized truncates')
    assert(blockSumm[1].content.length < blockFull[1].content.length, 'buildIterationBlock: summarized is shorter')
  }

  // =========================================
  // assemblePrompt — basic structure
  // =========================================

  {
    const result = assemblePrompt({
      tools: [], agents: [], memories: [], history: [],
      input: 'hello',
    })
    assert(result.messages.length === 2, 'assemblePrompt basic: 2 messages (system + user)')
    assert(result.messages[0].role === 'system', 'assemblePrompt basic: system first')
    assert(result.messages[1].role === 'user', 'assemblePrompt basic: user second')
    assert(result.messages[1].content === 'hello', 'assemblePrompt basic: user content')
    assert(result._assembly, 'assemblePrompt basic: _assembly present')
    assert(result._assembly.historyUsed === 0, 'assemblePrompt basic: no history')
    assert(result._assembly.historyDropped === 0, 'assemblePrompt basic: no drops')
  }

  // =========================================
  // assemblePrompt — with history
  // =========================================

  {
    const history = [
      { input: 'prev q', output: 'prev a', ts: 1 },
    ]
    const result = assemblePrompt({
      tools: [], agents: [], memories: [], history,
      input: 'current',
    })
    // system + user(prev q) + assistant(prev a) + user(current) = 4 messages
    assert(result.messages.length === 4, 'assemblePrompt history: 4 messages')
    assert(result.messages[1].role === 'user' && result.messages[1].content === 'prev q', 'assemblePrompt history: history user')
    assert(result.messages[2].role === 'assistant' && result.messages[2].content === 'prev a', 'assemblePrompt history: history assistant')
    assert(result.messages[3].content === 'current', 'assemblePrompt history: current input last')
    assert(result._assembly.historyUsed === 1, 'assemblePrompt history: 1 turn used')
  }

  // =========================================
  // assemblePrompt — with iteration context
  // =========================================

  {
    const result = assemblePrompt({
      tools: [], agents: [], memories: [], history: [],
      input: 'test',
      iterationContext: {
        previousPlan: { type: 'plan', steps: [{ op: 'EXEC' }] },
        previousResults: 'step result',
      },
    })
    // system + user(input) + assistant(plan) + user(results) = 4
    assert(result.messages.length === 4, 'assemblePrompt iteration: 4 messages')
    assert(result.messages[2].role === 'assistant', 'assemblePrompt iteration: assistant plan')
    assert(result.messages[3].content.includes('Step results'), 'assemblePrompt iteration: results')
  }

  // =========================================
  // assemblePrompt — budget fitting
  // =========================================

  {
    const history = [
      { input: 'old question', output: 'old answer', ts: 1 },
      { input: 'recent question', output: 'recent answer', ts: 2 },
    ]
    const memories = ['memory one', 'memory two', 'memory three']

    // Very tight budget → history and memories trimmed
    const result = assemblePrompt({
      tools: [], agents: [], memories, history,
      input: 'now',
      budget: { maxContextChars: 3500, reservedOutputChars: 0 },
    })

    // With tight budget, some history/memories may be dropped
    assert(result._assembly.historyUsed <= 2, 'assemblePrompt budget: history may be trimmed')
    assert(result._assembly.memoriesUsed <= 3, 'assemblePrompt budget: memories may be trimmed')
    assert(result._assembly.budget === 3500, 'assemblePrompt budget: budget recorded')
    assert(result._assembly.used > 0, 'assemblePrompt budget: used > 0')
  }

  // =========================================
  // assemblePrompt — fallback: iteration context compaction
  // =========================================

  {
    const longResult = 'x'.repeat(1000)
    const result = assemblePrompt({
      tools: [], agents: [], memories: [], history: [],
      input: 'test',
      iterationContext: {
        previousPlan: { type: 'plan', steps: [] },
        previousResults: longResult,
      },
      // Budget so tight that full iteration block doesn't fit
      budget: { maxContextChars: 3800, reservedOutputChars: 0 },
    })
    // Should still produce messages (iteration block summarized)
    assert(result.messages.length >= 2, 'assemblePrompt fallback: messages produced')
    assert(result._assembly.historyUsed === 0, 'assemblePrompt fallback: no history with tight budget')
  }

  // =========================================
  // assemblePrompt — memories included when budget allows
  // =========================================

  {
    const result = assemblePrompt({
      tools: [], agents: [], memories: ['relevant memory'], history: [],
      input: 'test',
    })
    assert(result.messages[0].content.includes('Relevant memories'), 'assemblePrompt memories: section present')
    assert(result.messages[0].content.includes('relevant memory'), 'assemblePrompt memories: content present')
    assert(result._assembly.memoriesUsed === 1, 'assemblePrompt memories: 1 used')
  }

  {
    const result = assemblePrompt({
      tools: [], agents: [], memories: [], history: [],
      input: 'test',
    })
    assert(!result.messages[0].content.includes('Relevant memories'), 'assemblePrompt no memories: section absent')
    assert(result._assembly.memoriesUsed === 0, 'assemblePrompt no memories: 0 used')
  }

  // =========================================
  // buildIterationPrompt backward compat
  // =========================================

  {
    const prompt = buildIterationPrompt({ tools: [], agents: [], memories: [], input: 'hi' })
    assert(prompt.messages.length === 2, 'buildIterationPrompt compat: 2 messages')
    assert(prompt.messages[0].role === 'system', 'buildIterationPrompt compat: system first')
    assert(prompt.messages[1].content === 'hi', 'buildIterationPrompt compat: user content')
    assert(prompt._assembly, 'buildIterationPrompt compat: _assembly present')
  }

  {
    const prompt = buildIterationPrompt({
      tools: [], memories: [], input: 'test',
      previousPlan: { type: 'plan', steps: [{ op: 'EXEC' }] },
      previousResults: 'result',
    })
    assert(prompt.messages.length === 4, 'buildIterationPrompt rolling: 4 messages')
    assert(prompt.messages[2].role === 'assistant', 'buildIterationPrompt rolling: assistant plan')
    assert(prompt.messages[3].content.includes('Step results'), 'buildIterationPrompt rolling: results')
  }

  // =========================================
  // assemblePrompt — message order: history before input
  // =========================================

  {
    const history = [{ input: 'q1', output: 'a1', ts: 1 }]
    const result = assemblePrompt({
      tools: [], agents: [], memories: [], history,
      input: 'current',
      iterationContext: {
        previousPlan: { type: 'plan', steps: [] },
        previousResults: 'res',
      },
    })
    // Order: system, history-user, history-assistant, user(current), assistant(plan), user(results)
    assert(result.messages[0].role === 'system', 'message order: system first')
    assert(result.messages[1].role === 'user' && result.messages[1].content === 'q1', 'message order: history user')
    assert(result.messages[2].role === 'assistant' && result.messages[2].content === 'a1', 'message order: history assistant')
    assert(result.messages[3].role === 'user' && result.messages[3].content === 'current', 'message order: current input')
    assert(result.messages[4].role === 'assistant', 'message order: iteration plan')
    assert(result.messages[5].role === 'user' && result.messages[5].content.includes('Step results'), 'message order: iteration results')
  }

  // =========================================
  // History saving — source='user'
  // =========================================

  {
    const state = initState({ context: { memories: [], conversationHistory: [] } })
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'response!' })
    })

    const agent = makeTestAgent({ interpret, ST, state })
    await agent.run('hello', { source: 'user' })

    const history = state.get('context.conversationHistory')
    assert(Array.isArray(history), 'history save: conversationHistory is array')
    assert(history.length === 1, 'history save: 1 entry')
    assert(history[0].input === 'hello', 'history save: input stored')
    assert(history[0].output === 'response!', 'history save: output stored')
    assert(typeof history[0].ts === 'number', 'history save: timestamp present')
  }

  // =========================================
  // No history saving without source
  // =========================================

  {
    const state = initState({ context: { memories: [], conversationHistory: [] } })
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'response!' })
    })

    const agent = makeTestAgent({ interpret, ST, state })
    await agent.run('hello')

    const history = state.get('context.conversationHistory')
    assert(history.length === 0, 'no source: no history saved')
  }

  // =========================================
  // No history saving with source='heartbeat'
  // =========================================

  {
    const state = initState({ context: { memories: [], conversationHistory: [] } })
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'response!' })
    })

    const agent = makeTestAgent({ interpret, ST, state })
    await agent.run('hello', { source: 'heartbeat' })

    const history = state.get('context.conversationHistory')
    assert(history.length === 0, 'heartbeat source: no history saved')
  }

  // =========================================
  // History truncation
  // =========================================

  {
    const state = initState({ context: { memories: [], conversationHistory: [] } })
    const longMessage = 'x'.repeat(2000)
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: longMessage })
    })

    const agent = makeTestAgent({ interpret, ST, state })
    await agent.run('a'.repeat(800), { source: 'user' })

    const history = state.get('context.conversationHistory')
    // 500 chars + '...(truncated)' (14 chars) = 514
    assert(history[0].input.length <= 514, 'history truncation: input truncated')
    assert(history[0].input.includes('...(truncated)'), 'history truncation: input has marker')
    // 1000 chars + '...(truncated)' (14 chars) = 1014
    assert(history[0].output.length <= 1014, 'history truncation: output truncated')
    assert(history[0].output.includes('...(truncated)'), 'history truncation: output has marker')
  }

  // =========================================
  // Multiple turns accumulate history
  // =========================================

  {
    const state = initState({ context: { memories: [], conversationHistory: [] } })
    let n = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        n++
        return JSON.stringify({ type: 'direct_response', message: `answer ${n}` })
      }
    })

    const agent = makeTestAgent({ interpret, ST, state })
    await agent.run('q1', { source: 'user' })
    await agent.run('q2', { source: 'user' })
    await agent.run('q3', { source: 'user' })

    const history = state.get('context.conversationHistory')
    assert(history.length === 3, 'multi-turn: 3 entries')
    assert(history[0].input === 'q1', 'multi-turn: first input')
    assert(history[2].input === 'q3', 'multi-turn: last input')
    assert(history[1].output === 'answer 2', 'multi-turn: middle output')
  }

  // =========================================
  // History flows into assemblePrompt via agent
  // =========================================

  {
    const state = initState({ context: { memories: [], conversationHistory: [] } })
    const capturedOps = []
    let n = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: (op) => {
        capturedOps.push(op)
        n++
        return JSON.stringify({ type: 'direct_response', message: `resp ${n}` })
      }
    })

    const agent = makeTestAgent({ interpret, ST, state })
    await agent.run('first', { source: 'user' })
    await agent.run('second', { source: 'user' })

    // Second call should have history from first turn
    const secondMessages = capturedOps[1].messages
    // Look for history: should contain 'first' as user message before 'second'
    const historyUserMsg = secondMessages.find(m => m.role === 'user' && m.content === 'first')
    const historyAsstMsg = secondMessages.find(m => m.role === 'assistant' && m.content === 'resp 1')
    assert(historyUserMsg != null, 'history in prompt: previous input present')
    assert(historyAsstMsg != null, 'history in prompt: previous output present')
  }

  // =========================================
  // Assembly metadata in debug
  // =========================================

  {
    const state = initState({ context: { memories: [], conversationHistory: [] } })
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'ok' })
    })

    const agent = makeTestAgent({ interpret, ST, state })
    await agent.run('test', { source: 'user' })

    const debug = state.get('_debug.lastTurn')
    assert(debug.assembly != null, 'debug assembly: present')
    assert(typeof debug.assembly.budget === 'number' || debug.assembly.budget === Infinity, 'debug assembly: budget')
    assert(typeof debug.assembly.used === 'number', 'debug assembly: used')
    assert(typeof debug.assembly.historyUsed === 'number', 'debug assembly: historyUsed')
    assert(typeof debug.assembly.historyDropped === 'number', 'debug assembly: historyDropped')
    assert(typeof debug.assembly.memoriesUsed === 'number', 'debug assembly: memoriesUsed')
  }

  // =========================================
  // Budget passed to agent constrains history
  // =========================================

  {
    const history = [
      { input: 'q1', output: 'a1', ts: 1 },
      { input: 'q2', output: 'a2', ts: 2 },
      { input: 'q3', output: 'a3', ts: 3 },
    ]
    const state = initState({ context: { memories: [], conversationHistory: history } })
    let capturedOp = null
    const { interpret, ST } = createTestInterpreter({
      AskLLM: (op) => {
        if (!capturedOp) capturedOp = op
        return JSON.stringify({ type: 'direct_response', message: 'ok' })
      }
    })

    // Tight token budget — won't fit all 3 history turns
    const agent = makeTestAgent({
      interpret, ST, state,
      budget: { maxContextChars: 920, reservedOutputChars: 0 },
    })
    await agent.run('current', { source: 'user' })

    const debug = state.get('_debug.lastTurn')
    assert(debug.assembly.historyUsed < 3 || debug.assembly.historyDropped > 0,
      'budget constraint: history trimmed when budget tight')
  }

  // =========================================
  // Budget guarantee: used <= budget
  // =========================================

  {
    const history = [
      { input: 'question one', output: 'answer one', ts: 1 },
      { input: 'question two with more text', output: 'answer two with more text', ts: 2 },
    ]
    const memories = ['relevant memory one', 'relevant memory two', 'relevant memory three']
    const budget = { maxContextChars: 5000, reservedOutputChars: 1000 }

    const result = assemblePrompt({
      tools: [], agents: [], memories, history,
      input: 'current question',
      budget,
    })

    assert(result._assembly.used <= result._assembly.budget,
      `budget guarantee: used (${result._assembly.used}) <= budget (${result._assembly.budget})`)
  }

  {
    // Also verify with iteration context — budget must accommodate fixed system text
    const history = [{ input: 'q', output: 'a', ts: 1 }]
    const memories = ['mem1']
    const budget = { maxContextChars: 6000, reservedOutputChars: 500 }

    const result = assemblePrompt({
      tools: [], agents: [], memories, history,
      input: 'test',
      iterationContext: {
        previousPlan: { type: 'plan', steps: [{ op: 'EXEC', args: { tool: 'x', tool_args: {} } }] },
        previousResults: 'step 1 result text here',
      },
      budget,
    })

    assert(result._assembly.used <= result._assembly.budget,
      `budget guarantee with iteration: used (${result._assembly.used}) <= budget (${result._assembly.budget})`)
  }

  {
    // When fixed content alone exceeds budget → history/memory 0, used may exceed budget (v1 fallback)
    const result = assemblePrompt({
      tools: [], agents: [], memories: ['mem1', 'mem2'], history: [{ input: 'q', output: 'a', ts: 1 }],
      input: 'test',
      budget: { maxContextChars: 100, reservedOutputChars: 0 },
    })

    assert(result._assembly.historyUsed === 0, 'over-budget fallback: no history')
    assert(result._assembly.memoriesUsed === 0, 'over-budget fallback: no memories')
    assert(result._assembly.used > result._assembly.budget, 'over-budget fallback: used exceeds budget (fixed content only)')
  }

  // =========================================
  // Rolling window: history capped at MAX_CONVERSATION_HISTORY
  // =========================================

  {
    const state = initState({ context: { memories: [], conversationHistory: [] } })
    let n = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        n++
        return JSON.stringify({ type: 'direct_response', message: `ok ${n}` })
      }
    })

    const agent = makeTestAgent({ interpret, ST, state })
    for (let i = 0; i < 25; i++) {
      await agent.run(`q${i}`, { source: 'user' })
    }

    const history = state.get('context.conversationHistory')
    assert(history.length === 20, 'rolling window: capped at 20')
    assert(history[0].input === 'q5', 'rolling window: oldest entries dropped')
    assert(history[19].input === 'q24', 'rolling window: newest entries kept')
  }

  // =========================================
  // plan+RESPOND saves history with source
  // =========================================

  {
    const state = initState({ context: { memories: [], conversationHistory: [] } })
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({
        type: 'plan',
        steps: [
          { op: 'EXEC', args: { tool: 'test', tool_args: {} } },
          { op: 'RESPOND', args: { ref: 1 } },
        ]
      }),
      ExecuteTool: () => 'tool result'
    })

    const agent = makeTestAgent({ interpret, ST, state })
    await agent.run('do it', { source: 'user' })

    const history = state.get('context.conversationHistory')
    assert(history.length === 1, 'plan+RESPOND: history saved')
    assert(history[0].input === 'do it', 'plan+RESPOND: input stored')
    assert(history[0].output === 'tool result', 'plan+RESPOND: output stored')
  }

  summary()
}

run()
