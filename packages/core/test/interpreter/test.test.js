import fp from '@presence/core/lib/fun-fp.js'
import { createTestInterpreter } from '@presence/core/interpreter/test.js'
import { getByPath } from '@presence/core/lib/path.js'
import {
  askLLM, executeTool, respond, updateState, getState,
} from '@presence/core/core/op.js'
import { runFreeWithStateT } from '@presence/core/lib/runner.js'
import { assert, summary } from '../../../../test/lib/assert.js'

const { Free, Task } = fp
const msg = (text) => [{ role: 'user', content: text }]

async function run() {
  console.log('createTestInterpreter tests')

  // 1. Single op: askLLM
  {
    const { interpret, ST, log } = createTestInterpreter()
    const [result] = await runFreeWithStateT(interpret, ST)(askLLM({ messages: msg('test') }))({})
    assert(result === 'mock-llm-response', 'single op: askLLM returns mock response')
    assert(log.length === 1, 'single op: 1 log entry')
    assert(log[0].tag === 'AskLLM', 'single op: log tag is AskLLM')
  }

  // 2. Chain: askLLM → respond
  {
    const { interpret, ST, log } = createTestInterpreter()
    const program = askLLM({ messages: msg('hello') }).chain(r => respond(r))
    const [result] = await runFreeWithStateT(interpret, ST)(program)({})
    assert(result === 'mock-llm-response', 'chain: askLLM → respond returns message')
    assert(log.length === 2, 'chain: 2 log entries')
    assert(log[0].tag === 'AskLLM' && log[1].tag === 'Respond', 'chain: correct log order')
  }

  // 3. Handler override
  {
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => 'custom-response'
    })
    const [result] = await runFreeWithStateT(interpret, ST)(askLLM({ messages: msg('test') }))({})
    assert(result === 'custom-response', 'override: custom AskLLM handler')
  }

  // 4. UpdateState: reflects in finalState
  {
    const { interpret, ST, log } = createTestInterpreter()
    const [, finalState] = await runFreeWithStateT(interpret, ST)(updateState('x', 42))({ x: 0 })
    assert(finalState.x === 42, 'UpdateState: value set in state')
    assert(log[0].tag === 'UpdateState', 'UpdateState: logged')
  }

  // 5. GetState: reads from state
  {
    const { interpret, ST } = createTestInterpreter()
    const [result] = await runFreeWithStateT(interpret, ST)(getState('name'))({ name: 'presence' })
    assert(result === 'presence', 'GetState: reads value from state')
  }

  // 6. Unknown op → Task.rejected
  {
    const { interpret, ST } = createTestInterpreter()
    const FUNCTOR = Symbol.for('fun-fp-js/Functor')
    const unknownOp = {
      tag: 'Unknown', next: x => x,
      [FUNCTOR]: true,
      map: f => ({ ...unknownOp, next: x => f(unknownOp.next(x)) })
    }
    try {
      await runFreeWithStateT(interpret, ST)(Free.liftF(unknownOp))({})
      assert(false, 'unknown op: should have rejected')
    } catch (e) {
      assert(e.message === 'Unknown op: Unknown', 'unknown op: Task.rejected with error')
    }
  }

  // 7. Handler throws → Task.rejected (try/catch wrapping)
  {
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => { throw new Error('handler boom') }
    })
    try {
      await runFreeWithStateT(interpret, ST)(askLLM({ messages: msg('crash') }))({})
      assert(false, 'handler throw: should reject')
    } catch (e) {
      assert(e.message === 'handler boom', 'handler throw: error propagated via Task.rejected')
    }
  }

  // 8. Handler throws in mid-chain → error captured as result, chain continues
  {
    const { interpret, ST, log } = createTestInterpreter({
      ExecuteTool: () => { throw new Error('tool exploded') }
    })
    const program = askLLM({ messages: msg('ok') })
      .chain(() => executeTool('bad', {}))
      .chain(() => respond('never reached'))
    const [result] = await runFreeWithStateT(interpret, ST)(program)({})
    assert(result === 'never reached', 'mid-chain throw: chain continues past error')
    assert(log.length === 3, 'mid-chain throw: all 3 ops logged')
    assert(log[1].tag === 'ExecuteTool', 'mid-chain throw: ExecuteTool logged')
    assert(log[2].tag === 'Respond', 'mid-chain throw: Respond reached')
  }

  // 9. Handler returns undefined → continuation receives undefined
  {
    const { interpret, ST } = createTestInterpreter({ AskLLM: () => undefined })
    const [result] = await runFreeWithStateT(interpret, ST)(
      askLLM({ messages: msg('x') }).chain(r => respond(String(r)))
    )({})
    assert(result === 'undefined', 'handler returns undefined: continuation receives undefined')
  }

  // 10. UpdateState/GetState use built-in StateT handlers
  {
    const { interpret, ST } = createTestInterpreter()
    const [result] = await runFreeWithStateT(interpret, ST)(
      updateState('x', 1).chain(() => getState('x'))
    )({})
    assert(result === 1, 'UpdateState/GetState: built-in handlers work')
  }

  summary()
}

run()
