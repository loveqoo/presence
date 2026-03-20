import { parsePlan, resolveRefs, resolveStringRefs, resolveToolArgs } from '../../src/core/plan.js'
import { createTestInterpreter } from '../../src/interpreter/test.js'
import { createState } from '../../src/infra/state.js'
import { Free } from '../../src/core/op.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function run() {
  console.log('Plan parser tests')

  // --- Utility tests ---

  // resolveRefs
  assert(deepEqual(resolveRefs([1, 2], ['a', 'b', 'c']), ['a', 'b']), 'resolveRefs: [1,2] → first two results')
  assert(deepEqual(resolveRefs(null, []), []), 'resolveRefs: null → empty')
  assert(deepEqual(resolveRefs([5], ['a']), []), 'resolveRefs: out of range → filtered')

  // resolveStringRefs
  assert(resolveStringRefs('hello $1', ['world']) === 'hello world', 'resolveStringRefs: $1 replaced')
  assert(resolveStringRefs('$1 and $2', ['a', 'b']) === 'a and b', 'resolveStringRefs: multiple refs')
  assert(resolveStringRefs('no refs', []) === 'no refs', 'resolveStringRefs: no refs unchanged')

  // resolveToolArgs
  assert(deepEqual(
    resolveToolArgs({ msg: '$1', count: 5 }, ['hello']),
    { msg: 'hello', count: 5 }
  ), 'resolveToolArgs: replaces string refs, keeps numbers')

  // --- parsePlan tests ---

  // 1. direct_response
  {
    const { interpreter, log } = createTestInterpreter()
    const plan = { type: 'direct_response', message: 'hi there' }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(result === 'hi there', 'direct_response: returns message')
    assert(log[0].tag === 'Respond', 'direct_response: uses Respond op')
  }

  // 2. Single EXEC step
  {
    const { interpreter, log } = createTestInterpreter()
    const plan = {
      type: 'plan',
      steps: [{ op: 'EXEC', args: { tool: 'test_tool', tool_args: { x: 1 } } }]
    }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(log[0].tag === 'ExecuteTool', 'single EXEC: ExecuteTool op')
    assert(Array.isArray(result), 'single EXEC: returns array of results')
    assert(result.length === 1, 'single EXEC: 1 result')
  }

  // 3. Multi-step with ctx references: EXEC → ASK_LLM(ctx=$1) → RESPOND($2)
  {
    const { interpreter, log } = createTestInterpreter({
      ExecuteTool: (op) => `tool-result-for-${op.name}`,
      AskLLM: (op) => {
        // Fix 4: AskLLM now receives { messages, context } — consistent shape
        assert(Array.isArray(op.messages), 'ASK_LLM step: messages is array')
        assert(op.messages[0].role === 'user', 'ASK_LLM step: messages has user role')
        return `llm-said-${op.context[0]}`
      },
    })
    const plan = {
      type: 'plan',
      steps: [
        { op: 'EXEC', args: { tool: 'github', tool_args: {} } },
        { op: 'ASK_LLM', args: { prompt: 'summarize', ctx: [1] } },
        { op: 'RESPOND', args: { ref: 2 } },
      ]
    }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(log.length === 3, 'multi-step: 3 ops executed')
    assert(log[0].tag === 'ExecuteTool', 'multi-step: first is EXEC')
    assert(log[1].tag === 'AskLLM', 'multi-step: second is ASK_LLM')
    assert(log[2].tag === 'Respond', 'multi-step: third is RESPOND')
    assert(result[2] === 'llm-said-tool-result-for-github', 'multi-step: ctx reference works')
  }

  // 4. Unknown op → ignored, rest continues
  {
    const { interpreter, log } = createTestInterpreter()
    const plan = {
      type: 'plan',
      steps: [
        { op: 'UNKNOWN_OP', args: {} },
        { op: 'EXEC', args: { tool: 'test', tool_args: {} } },
      ]
    }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(result[0] === null, 'unknown op: returns null')
    assert(result.length === 2, 'unknown op: both steps produce results')
    assert(log[0].tag === 'ExecuteTool', 'unknown op: EXEC still runs')
  }

  // 5. Empty steps → Free.of([])
  {
    const { interpreter, log } = createTestInterpreter()
    const plan = { type: 'plan', steps: [] }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(Array.isArray(result) && result.length === 0, 'empty steps: returns []')
    assert(log.length === 0, 'empty steps: no ops executed')
  }

  // 6. APPROVE step
  {
    // Approved
    const { interpreter: i1, log: l1 } = createTestInterpreter({ Approve: () => true })
    const plan = {
      type: 'plan',
      steps: [
        { op: 'APPROVE', args: { description: 'send to slack?' } },
        { op: 'EXEC', args: { tool: 'slack', tool_args: {} } },
      ]
    }
    const r1 = await Free.runWithTask(i1)(parsePlan(plan))
    assert(r1[0] === true, 'APPROVE: returns true when approved')
    assert(l1[0].tag === 'Approve', 'APPROVE: logged as Approve')
  }

  // 7. LOOKUP_MEMORY → filters by query
  {
    const state = createState({ context: { memories: ['회의 안건', 'PR 현황', '회의록 정리'] } })
    const { interpreter } = createTestInterpreter({}, state)
    const plan = {
      type: 'plan',
      steps: [{ op: 'LOOKUP_MEMORY', args: { query: '회의' } }]
    }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(result[0].length === 2, 'LOOKUP_MEMORY: filters by query (2 of 3 match)')
    assert(result[0].includes('회의 안건'), 'LOOKUP_MEMORY: includes matching memory')
    assert(!result[0].includes('PR 현황'), 'LOOKUP_MEMORY: excludes non-matching')
  }

  // 7b. LOOKUP_MEMORY without query → returns all
  {
    const state = createState({ context: { memories: ['a', 'b'] } })
    const { interpreter } = createTestInterpreter({}, state)
    const plan = {
      type: 'plan',
      steps: [{ op: 'LOOKUP_MEMORY', args: {} }]
    }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(result[0].length === 2, 'LOOKUP_MEMORY no query: returns all')
  }

  // 8. EXEC with $N in tool_args
  {
    const { interpreter, log } = createTestInterpreter({
      AskLLM: () => 'formatted-message',
      ExecuteTool: (op) => `sent: ${op.args.message}`,
    })
    const plan = {
      type: 'plan',
      steps: [
        { op: 'ASK_LLM', args: { prompt: 'format' } },
        { op: 'EXEC', args: { tool: 'slack', tool_args: { channel: '#team', message: '$1' } } },
      ]
    }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(result[1] === 'sent: formatted-message', 'EXEC $N: tool_args reference resolved')
  }

  // --- LOOKUP_MEMORY edge cases (Fix 3) ---

  // 9. LOOKUP_MEMORY: case-insensitive matching
  {
    const state = createState({ context: { memories: ['Hello World', 'foo bar'] } })
    const { interpreter } = createTestInterpreter({}, state)
    const plan = { type: 'plan', steps: [{ op: 'LOOKUP_MEMORY', args: { query: 'HELLO' } }] }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(result[0].length === 1 && result[0][0] === 'Hello World', 'LOOKUP_MEMORY: case-insensitive')
  }

  // 10. LOOKUP_MEMORY: memories is null/undefined in state → empty array
  {
    const state = createState({ context: {} }) // no memories key
    const { interpreter } = createTestInterpreter({}, state)
    const plan = { type: 'plan', steps: [{ op: 'LOOKUP_MEMORY', args: { query: 'x' } }] }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(Array.isArray(result[0]) && result[0].length === 0, 'LOOKUP_MEMORY: undefined memories → []')
  }

  // 11. LOOKUP_MEMORY: non-string memories don't crash, String() used for comparison
  {
    const state = createState({ context: { memories: [{ text: 'meeting' }, 42, null, 'meeting room'] } })
    const { interpreter } = createTestInterpreter({}, state)
    const plan = { type: 'plan', steps: [{ op: 'LOOKUP_MEMORY', args: { query: 'meeting' } }] }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    // String({text:'meeting'}) = '[object Object]' → no match; String(42) = '42' → no match
    // Only 'meeting room' matches
    assert(result[0].length === 1, 'LOOKUP_MEMORY: non-string memories handled (1 string match)')
    assert(result[0][0] === 'meeting room', 'LOOKUP_MEMORY: only string memory matched')
  }

  // 12. LOOKUP_MEMORY: query matches nothing → empty array (not full dump)
  {
    const state = createState({ context: { memories: ['a', 'b', 'c'] } })
    const { interpreter } = createTestInterpreter({}, state)
    const plan = { type: 'plan', steps: [{ op: 'LOOKUP_MEMORY', args: { query: 'zzz' } }] }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(result[0].length === 0, 'LOOKUP_MEMORY: no match → empty, not full dump')
  }

  // --- ASK_LLM payload shape edge cases (Fix 4) ---

  // 13. ASK_LLM without ctx field → context is undefined
  {
    let capturedOp = null
    const { interpreter } = createTestInterpreter({
      AskLLM: (op) => { capturedOp = op; return 'ok' }
    })
    const plan = { type: 'plan', steps: [{ op: 'ASK_LLM', args: { prompt: 'hello' } }] }
    await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(capturedOp.context === undefined, 'ASK_LLM no ctx: context is undefined')
    assert(capturedOp.messages[0].content === 'hello', 'ASK_LLM no ctx: prompt in messages')
  }

  // 14. ASK_LLM with empty ctx → context is undefined
  {
    let capturedOp = null
    const { interpreter } = createTestInterpreter({
      AskLLM: (op) => { capturedOp = op; return 'ok' }
    })
    const plan = { type: 'plan', steps: [{ op: 'ASK_LLM', args: { prompt: 'hi', ctx: [] } }] }
    await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(capturedOp.context === undefined, 'ASK_LLM empty ctx: context is undefined')
  }

  // 15. ASK_LLM with out-of-range ctx → context is undefined (filtered to empty)
  {
    let capturedOp = null
    const { interpreter } = createTestInterpreter({
      ExecuteTool: () => 'only-result',
      AskLLM: (op) => { capturedOp = op; return 'ok' }
    })
    const plan = {
      type: 'plan',
      steps: [
        { op: 'EXEC', args: { tool: 'a', tool_args: {} } },
        { op: 'ASK_LLM', args: { prompt: 'summarize', ctx: [99] } }, // out of range
      ]
    }
    await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(capturedOp.context === undefined, 'ASK_LLM out-of-range ctx: context undefined')
  }

  // 16. Plan with mixed ASK_LLM: one with context, one without
  {
    const captured = []
    const { interpreter } = createTestInterpreter({
      ExecuteTool: () => 'data',
      AskLLM: (op) => { captured.push(op); return 'response' }
    })
    const plan = {
      type: 'plan',
      steps: [
        { op: 'EXEC', args: { tool: 'fetch', tool_args: {} } },
        { op: 'ASK_LLM', args: { prompt: 'with ctx', ctx: [1] } },
        { op: 'ASK_LLM', args: { prompt: 'no ctx' } },
      ]
    }
    await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(Array.isArray(captured[0].context) && captured[0].context[0] === 'data',
      'mixed ASK_LLM: first has context')
    assert(captured[1].context === undefined,
      'mixed ASK_LLM: second has no context')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
