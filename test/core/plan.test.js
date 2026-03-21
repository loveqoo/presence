import { parsePlan, validateStep, argValidators, resolveRefs, resolveStringRefs, resolveToolArgs } from '../../src/core/plan.js'
import { createTestInterpreter } from '../../src/interpreter/test.js'
import { createState } from '../../src/infra/state.js'
import { Free, Either } from '../../src/core/op.js'

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

  // validateStep — op + args 검증
  assert(Either.isRight(validateStep({ op: 'EXEC', args: { tool: 'gh' } })), 'validateStep: valid EXEC → Right')
  assert(Either.isRight(validateStep({ op: 'RESPOND', args: { ref: 1 } })), 'validateStep: RESPOND ref → Right')
  assert(Either.isRight(validateStep({ op: 'RESPOND', args: { message: 'hi' } })), 'validateStep: RESPOND msg → Right')
  assert(Either.isRight(validateStep({ op: 'LOOKUP_MEMORY', args: {} })), 'validateStep: LOOKUP no args → Right')
  assert(Either.isRight(validateStep({ op: 'LOOKUP_MEMORY', args: { query: '회의' } })), 'validateStep: LOOKUP string query → Right')
  assert(Either.isLeft(validateStep({ op: 'LOOKUP_MEMORY', args: { query: 42 } })), 'validateStep: LOOKUP numeric query → Left')
  assert(Either.isLeft(validateStep({ op: 'LOOKUP_MEMORY', args: { query: {} } })), 'validateStep: LOOKUP object query → Left')
  assert(Either.isLeft(validateStep(null)), 'validateStep: null → Left')
  assert(Either.isLeft(validateStep({ op: 'UNKNOWN' })), 'validateStep: unknown op → Left')
  assert(Either.isLeft(validateStep({})), 'validateStep: no op → Left')
  assert(Either.isLeft(validateStep({ op: 'EXEC', args: {} })), 'validateStep: EXEC without tool → Left')
  assert(Either.isLeft(validateStep({ op: 'RESPOND', args: {} })), 'validateStep: RESPOND without ref/msg → Left')
  assert(Either.isLeft(validateStep({ op: 'ASK_LLM', args: {} })), 'validateStep: ASK_LLM without prompt → Left')
  assert(Either.isLeft(validateStep({ op: 'APPROVE', args: {} })), 'validateStep: APPROVE without desc → Left')
  assert(Either.isLeft(validateStep({ op: 'DELEGATE', args: { target: 'x' } })), 'validateStep: DELEGATE missing task → Left')

  // RESPOND.ref 타입 검증
  assert(Either.isLeft(validateStep({ op: 'RESPOND', args: { ref: 0 } })), 'validateStep: RESPOND ref=0 → Left')
  assert(Either.isLeft(validateStep({ op: 'RESPOND', args: { ref: -1 } })), 'validateStep: RESPOND ref=-1 → Left')
  assert(Either.isLeft(validateStep({ op: 'RESPOND', args: { ref: 'abc' } })), 'validateStep: RESPOND ref=string → Left')
  assert(Either.isLeft(validateStep({ op: 'RESPOND', args: { ref: 1.5 } })), 'validateStep: RESPOND ref=float → Left')

  // ASK_LLM.ctx 타입 검증
  assert(Either.isRight(validateStep({ op: 'ASK_LLM', args: { prompt: 'q', ctx: [1, 2] } })), 'validateStep: ASK_LLM valid ctx → Right')
  assert(Either.isRight(validateStep({ op: 'ASK_LLM', args: { prompt: 'q' } })), 'validateStep: ASK_LLM no ctx → Right')
  assert(Either.isLeft(validateStep({ op: 'ASK_LLM', args: { prompt: 'q', ctx: '1' } })), 'validateStep: ASK_LLM ctx=string → Left')
  assert(Either.isLeft(validateStep({ op: 'ASK_LLM', args: { prompt: 'q', ctx: [0] } })), 'validateStep: ASK_LLM ctx=[0] → Left')
  assert(Either.isLeft(validateStep({ op: 'ASK_LLM', args: { prompt: 'q', ctx: [-1] } })), 'validateStep: ASK_LLM ctx=[-1] → Left')
  assert(Either.isLeft(validateStep({ op: 'ASK_LLM', args: { prompt: 'q', ctx: [1.5] } })), 'validateStep: ASK_LLM ctx=[1.5] → Left')

  // argValidators 단위
  assert(Either.isRight(argValidators.EXEC({ tool: 'gh' })), 'argValidators.EXEC: valid')
  assert(Either.isLeft(argValidators.EXEC({})), 'argValidators.EXEC: missing tool')
  assert(Either.isRight(argValidators.DELEGATE({ target: 'a', task: 'b' })), 'argValidators.DELEGATE: valid')
  assert(Either.isLeft(argValidators.DELEGATE({ target: 'a' })), 'argValidators.DELEGATE: missing task')

  // --- parsePlan tests ---

  // 1. direct_response → Either.Right
  {
    const { interpreter, log } = createTestInterpreter()
    const plan = { type: 'direct_response', message: 'hi there' }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(Either.isRight(result), 'direct_response: Right')
    assert(result.value === 'hi there', 'direct_response: returns message')
    assert(log[0].tag === 'Respond', 'direct_response: uses Respond op')
  }

  // 2. Single EXEC step → Either.Right
  {
    const { interpreter, log } = createTestInterpreter()
    const plan = {
      type: 'plan',
      steps: [{ op: 'EXEC', args: { tool: 'test_tool', tool_args: { x: 1 } } }]
    }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(Either.isRight(result), 'single EXEC: Right')
    assert(log[0].tag === 'ExecuteTool', 'single EXEC: ExecuteTool op')
    assert(result.value.length === 1, 'single EXEC: 1 result')
  }

  // 3. Multi-step with ctx references
  {
    const { interpreter, log } = createTestInterpreter({
      ExecuteTool: (op) => `tool-result-for-${op.name}`,
      AskLLM: (op) => {
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
    assert(Either.isRight(result), 'multi-step: Right')
    assert(log.length === 3, 'multi-step: 3 ops executed')
    assert(result.value[2] === 'llm-said-tool-result-for-github', 'multi-step: ctx reference works')
  }

  // 4. Unknown op → Either.Left, short-circuits (EXEC 실행 안 됨)
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
    assert(Either.isLeft(result), 'unknown op: Left')
    assert(result.value.includes('UNKNOWN_OP'), 'unknown op: error mentions op name')
    assert(log.filter(l => l.tag === 'ExecuteTool').length === 0, 'unknown op: EXEC not executed')
  }

  // 5. Empty steps → Either.Right([])
  {
    const { interpreter, log } = createTestInterpreter()
    const plan = { type: 'plan', steps: [] }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(Either.isRight(result), 'empty steps: Right')
    assert(result.value.length === 0, 'empty steps: empty array')
    assert(log.length === 0, 'empty steps: no ops executed')
  }

  // 6. APPROVE step
  {
    const { interpreter: i1, log: l1 } = createTestInterpreter({ Approve: () => true })
    const plan = {
      type: 'plan',
      steps: [
        { op: 'APPROVE', args: { description: 'send to slack?' } },
        { op: 'EXEC', args: { tool: 'slack', tool_args: {} } },
      ]
    }
    const r1 = await Free.runWithTask(i1)(parsePlan(plan))
    assert(Either.isRight(r1), 'APPROVE: Right')
    assert(r1.value[0] === true, 'APPROVE: returns true when approved')
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
    assert(result.value[0].length === 2, 'LOOKUP_MEMORY: filters by query (2 of 3 match)')
    assert(result.value[0].includes('회의 안건'), 'LOOKUP_MEMORY: includes matching memory')
    assert(!result.value[0].includes('PR 현황'), 'LOOKUP_MEMORY: excludes non-matching')
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
    assert(result.value[0].length === 2, 'LOOKUP_MEMORY no query: returns all')
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
    assert(result.value[1] === 'sent: formatted-message', 'EXEC $N: tool_args reference resolved')
  }

  // --- LOOKUP_MEMORY edge cases ---

  // 9. case-insensitive
  {
    const state = createState({ context: { memories: ['Hello World', 'foo bar'] } })
    const { interpreter } = createTestInterpreter({}, state)
    const plan = { type: 'plan', steps: [{ op: 'LOOKUP_MEMORY', args: { query: 'HELLO' } }] }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(result.value[0].length === 1 && result.value[0][0] === 'Hello World', 'LOOKUP_MEMORY: case-insensitive')
  }

  // 10. memories undefined → empty
  {
    const state = createState({ context: {} })
    const { interpreter } = createTestInterpreter({}, state)
    const plan = { type: 'plan', steps: [{ op: 'LOOKUP_MEMORY', args: { query: 'x' } }] }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(result.value[0].length === 0, 'LOOKUP_MEMORY: undefined memories → []')
  }

  // 11. non-string memories
  {
    const state = createState({ context: { memories: [{ text: 'meeting' }, 42, null, 'meeting room'] } })
    const { interpreter } = createTestInterpreter({}, state)
    const plan = { type: 'plan', steps: [{ op: 'LOOKUP_MEMORY', args: { query: 'meeting' } }] }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(result.value[0].length === 1, 'LOOKUP_MEMORY: non-string memories handled')
    assert(result.value[0][0] === 'meeting room', 'LOOKUP_MEMORY: only string memory matched')
  }

  // 12. query matches nothing
  {
    const state = createState({ context: { memories: ['a', 'b', 'c'] } })
    const { interpreter } = createTestInterpreter({}, state)
    const plan = { type: 'plan', steps: [{ op: 'LOOKUP_MEMORY', args: { query: 'zzz' } }] }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(result.value[0].length === 0, 'LOOKUP_MEMORY: no match → empty')
  }

  // --- ASK_LLM payload edge cases ---

  // 13. without ctx → context undefined
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

  // 14. empty ctx → context undefined
  {
    let capturedOp = null
    const { interpreter } = createTestInterpreter({
      AskLLM: (op) => { capturedOp = op; return 'ok' }
    })
    const plan = { type: 'plan', steps: [{ op: 'ASK_LLM', args: { prompt: 'hi', ctx: [] } }] }
    await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(capturedOp.context === undefined, 'ASK_LLM empty ctx: context is undefined')
  }

  // 15. out-of-range ctx
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
        { op: 'ASK_LLM', args: { prompt: 'summarize', ctx: [99] } },
      ]
    }
    await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(capturedOp.context === undefined, 'ASK_LLM out-of-range ctx: context undefined')
  }

  // 16. mixed ASK_LLM
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

  // --- malformed step args → plan fails ---

  // 17. EXEC without tool → Left (PLANNER_SHAPE, not INTERPRETER)
  {
    const { interpreter, log } = createTestInterpreter()
    const plan = {
      type: 'plan',
      steps: [{ op: 'EXEC', args: { tool_args: { x: 1 } } }]
    }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(Either.isLeft(result), 'EXEC no tool: Left')
    assert(result.value.includes('EXEC'), 'EXEC no tool: error mentions EXEC')
    assert(log.filter(l => l.tag === 'ExecuteTool').length === 0, 'EXEC no tool: not dispatched')
  }

  // 18. RESPOND without ref or message → Left
  {
    const { interpreter } = createTestInterpreter()
    const plan = {
      type: 'plan',
      steps: [{ op: 'RESPOND', args: {} }]
    }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(Either.isLeft(result), 'RESPOND no args: Left')
    assert(result.value.includes('RESPOND'), 'RESPOND no args: error mentions RESPOND')
  }

  // 19. RESPOND with out-of-range ref → Either.Left
  {
    const { interpreter } = createTestInterpreter({
      ExecuteTool: () => 'result',
    })
    const plan = {
      type: 'plan',
      steps: [
        { op: 'EXEC', args: { tool: 'a', tool_args: {} } },
        { op: 'RESPOND', args: { ref: 99 } },
      ]
    }
    const result = await Free.runWithTask(interpreter)(parsePlan(plan))
    assert(Either.isLeft(result), 'RESPOND bad ref: Left')
    assert(result.value.includes('99'), 'RESPOND bad ref: error mentions index')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
