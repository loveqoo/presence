import { createTestInterpreter } from '../../src/interpreter/test.js'
import {
  askLLM, executeTool, respond, approve,
  updateState, getState, Free, runFreeWithStateT
} from '../../src/core/op.js'

const msg = (text) => [{ role: 'user', content: text }]

import { assert, summary } from '../lib/assert.js'

async function run() {
  console.log('Free + Mock interpreter integration tests')

  // 1. 3-step chain: askLLM → executeTool → respond
  {
    const { interpret, ST, log } = createTestInterpreter()
    const program = askLLM({ messages: msg('plan something') })
      .chain(plan => executeTool('github', { repo: 'test' }))
      .chain(result => respond(`done: ${result.result}`))

    const [final] = await runFreeWithStateT(interpret, ST)(program)({})
    assert(log.length === 3, '3-step chain: 3 log entries')
    assert(log[0].tag === 'AskLLM', '3-step: first is AskLLM')
    assert(log[1].tag === 'ExecuteTool', '3-step: second is ExecuteTool')
    assert(log[2].tag === 'Respond', '3-step: third is Respond')
    assert(final === 'done: mock-github-result', '3-step: final result correct')
  }

  // 2. State integration: updateState → getState
  {
    const { interpret, ST } = createTestInterpreter()
    const program = updateState('count', 42)
      .chain(() => getState('count'))

    const [result, finalState] = await runFreeWithStateT(interpret, ST)(program)({ count: 0 })
    assert(result === 42, 'state integration: updateState → getState returns 42')
    assert(finalState.count === 42, 'state integration: finalState.count is 42')
  }

  // 3. Conditional branching: approve → true → executeTool, false → respond
  {
    // Case: approved
    const { interpret: int1, ST: ST1, log: log1 } = createTestInterpreter({
      Approve: () => true
    })
    const program = approve('send email?')
      .chain(approved =>
        approved ? executeTool('email', { to: 'a@b.com' }) : respond('cancelled'))

    const [r1] = await runFreeWithStateT(int1, ST1)(program)({})
    assert(log1[1].tag === 'ExecuteTool', 'branch approved: executeTool called')

    // Case: rejected
    const { interpret: int2, ST: ST2, log: log2 } = createTestInterpreter({
      Approve: () => false
    })
    const [r2] = await runFreeWithStateT(int2, ST2)(program)({})
    assert(log2[1].tag === 'Respond', 'branch rejected: respond called')
    assert(r2 === 'cancelled', 'branch rejected: returns cancelled')
  }

  // 4. Free.of(value) → immediate completion, no ops
  {
    const { interpret, ST, log } = createTestInterpreter()
    const [result] = await runFreeWithStateT(interpret, ST)(Free.of('immediate'))({})
    assert(result === 'immediate', 'Free.of: immediate value')
    assert(log.length === 0, 'Free.of: 0 log entries')
  }

  // 5. Longer chain with state throughout
  {
    const { interpret, ST, log } = createTestInterpreter({
      AskLLM: () => '{"type":"direct_response","message":"hi"}'
    })

    const program = updateState('status', 'working')
      .chain(() => updateState('turn', 1))
      .chain(() => askLLM({ messages: msg('plan') }))
      .chain(plan => respond(plan))
      .chain(() => updateState('status', 'idle'))

    const [, finalState] = await runFreeWithStateT(interpret, ST)(program)({ status: 'idle', turn: 0 })
    assert(finalState.status === 'idle', 'full flow: status back to idle')
    assert(finalState.turn === 1, 'full flow: turn incremented')
    assert(log.length === 5, 'full flow: 5 ops executed')
  }

  summary()
}

run()
