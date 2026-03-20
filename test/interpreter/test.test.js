import fp from '../../src/lib/fun-fp.js'
import { createTestInterpreter } from '../../src/interpreter/test.js'
import { createState } from '../../src/infra/state.js'
import {
  askLLM, executeTool, respond, updateState, getState, Free
} from '../../src/core/op.js'

const { Task } = fp
const msg = (text) => [{ role: 'user', content: text }]

let passed = 0
let failed = 0

function assert(condition, m) {
  if (condition) { passed++; console.log(`  ✓ ${m}`) }
  else { failed++; console.error(`  ✗ ${m}`) }
}

async function run() {
  console.log('createTestInterpreter tests')

  // 1. Single op: askLLM
  {
    const { interpreter, log } = createTestInterpreter()
    const result = await Free.runWithTask(interpreter)(askLLM({ messages: msg('test') }))
    assert(result === 'mock-llm-response', 'single op: askLLM returns mock response')
    assert(log.length === 1, 'single op: 1 log entry')
    assert(log[0].tag === 'AskLLM', 'single op: log tag is AskLLM')
  }

  // 2. Chain: askLLM → respond
  {
    const { interpreter, log } = createTestInterpreter()
    const program = askLLM({ messages: msg('hello') }).chain(r => respond(r))
    const result = await Free.runWithTask(interpreter)(program)
    assert(result === 'mock-llm-response', 'chain: askLLM → respond returns message')
    assert(log.length === 2, 'chain: 2 log entries')
    assert(log[0].tag === 'AskLLM' && log[1].tag === 'Respond', 'chain: correct log order')
  }

  // 3. Handler override
  {
    const { interpreter } = createTestInterpreter({
      AskLLM: () => 'custom-response'
    })
    const result = await Free.runWithTask(interpreter)(askLLM({ messages: msg('test') }))
    assert(result === 'custom-response', 'override: custom AskLLM handler')
  }

  // 4. UpdateState: reflects in state
  {
    const state = createState({ x: 0 })
    const { interpreter, log } = createTestInterpreter({}, state)
    await Free.runWithTask(interpreter)(updateState('x', 42))
    assert(state.get('x') === 42, 'UpdateState: value set in state')
    assert(log[0].tag === 'UpdateState', 'UpdateState: logged')
  }

  // 5. GetState: reads from state
  {
    const state = createState({ name: 'presence' })
    const { interpreter } = createTestInterpreter({}, state)
    const result = await Free.runWithTask(interpreter)(getState('name'))
    assert(result === 'presence', 'GetState: reads value from state')
  }

  // 6. Unknown op → Task.rejected
  {
    const { interpreter } = createTestInterpreter()
    const FUNCTOR = Symbol.for('fun-fp-js/Functor')
    const unknownOp = {
      tag: 'Unknown', next: x => x,
      [FUNCTOR]: true,
      map: f => ({ ...unknownOp, next: x => f(unknownOp.next(x)) })
    }
    try {
      await Free.runWithTask(interpreter)(Free.liftF(unknownOp))
      assert(false, 'unknown op: should have rejected')
    } catch (e) {
      assert(e.message === 'Unknown op: Unknown', 'unknown op: Task.rejected with error')
    }
  }

  // 7. Handler throws → Task.rejected (try/catch wrapping)
  {
    const { interpreter } = createTestInterpreter({
      AskLLM: () => { throw new Error('handler boom') }
    })
    try {
      await Free.runWithTask(interpreter)(askLLM({ messages: msg('crash') }))
      assert(false, 'handler throw: should reject')
    } catch (e) {
      assert(e.message === 'handler boom', 'handler throw: error propagated via Task.rejected')
    }
  }

  // 8. Handler throws in mid-chain → aborts remaining steps
  {
    const { interpreter, log } = createTestInterpreter({
      ExecuteTool: () => { throw new Error('tool exploded') }
    })
    const program = askLLM({ messages: msg('ok') })
      .chain(() => executeTool('bad', {}))
      .chain(() => respond('never reached'))
    try {
      await Free.runWithTask(interpreter)(program)
      assert(false, 'mid-chain throw: should reject')
    } catch (e) {
      assert(e.message === 'tool exploded', 'mid-chain throw: correct error')
      assert(log.length === 2, 'mid-chain throw: stopped after failing op (2 logged)')
      assert(log[1].tag === 'ExecuteTool', 'mid-chain throw: failure at ExecuteTool')
    }
  }

  // 9. Handler returns undefined → continuation receives undefined
  {
    const { interpreter } = createTestInterpreter({ AskLLM: () => undefined })
    const result = await Free.runWithTask(interpreter)(
      askLLM({ messages: msg('x') }).chain(r => respond(String(r)))
    )
    assert(result === 'undefined', 'handler returns undefined: continuation receives undefined')
  }

  // 10. State operations without state object → no default handler
  {
    const { interpreter } = createTestInterpreter()
    try {
      await Free.runWithTask(interpreter)(updateState('x', 1).chain(() => getState('x')))
      assert(false, 'no-state UpdateState: should reject')
    } catch (e) {
      assert(e.message.includes('Unknown op'), 'no-state: UpdateState has no default handler')
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
