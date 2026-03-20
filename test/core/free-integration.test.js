import { createTestInterpreter } from '../../src/interpreter/test.js'
import { createState } from '../../src/infra/state.js'
import {
  askLLM, executeTool, respond, approve,
  updateState, getState, Free
} from '../../src/core/op.js'

const msg = (text) => [{ role: 'user', content: text }]

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

async function run() {
  console.log('Free + Mock interpreter integration tests')

  // 1. 3-step chain: askLLM → executeTool → respond
  {
    const { interpreter, log } = createTestInterpreter()
    const program = askLLM({ messages: msg('plan something') })
      .chain(plan => executeTool('github', { repo: 'test' }))
      .chain(result => respond(`done: ${result.result}`))

    const final = await Free.runWithTask(interpreter)(program)
    assert(log.length === 3, '3-step chain: 3 log entries')
    assert(log[0].tag === 'AskLLM', '3-step: first is AskLLM')
    assert(log[1].tag === 'ExecuteTool', '3-step: second is ExecuteTool')
    assert(log[2].tag === 'Respond', '3-step: third is Respond')
    assert(final === 'done: mock-github-result', '3-step: final result correct')
  }

  // 2. State integration: updateState → getState
  {
    const state = createState({ count: 0 })
    const { interpreter } = createTestInterpreter({}, state)
    const program = updateState('count', 42)
      .chain(() => getState('count'))

    const result = await Free.runWithTask(interpreter)(program)
    assert(result === 42, 'state integration: updateState → getState returns 42')
  }

  // 3. Conditional branching: approve → true → executeTool, false → respond
  {
    // Case: approved
    const { interpreter: int1, log: log1 } = createTestInterpreter({
      Approve: () => true
    })
    const program = approve('send email?')
      .chain(approved =>
        approved ? executeTool('email', { to: 'a@b.com' }) : respond('cancelled'))

    const r1 = await Free.runWithTask(int1)(program)
    assert(log1[1].tag === 'ExecuteTool', 'branch approved: executeTool called')

    // Case: rejected
    const { interpreter: int2, log: log2 } = createTestInterpreter({
      Approve: () => false
    })
    const r2 = await Free.runWithTask(int2)(program)
    assert(log2[1].tag === 'Respond', 'branch rejected: respond called')
    assert(r2 === 'cancelled', 'branch rejected: returns cancelled')
  }

  // 4. Free.of(value) → immediate completion, no ops
  {
    const { interpreter, log } = createTestInterpreter()
    const result = await Free.runWithTask(interpreter)(Free.of('immediate'))
    assert(result === 'immediate', 'Free.of: immediate value')
    assert(log.length === 0, 'Free.of: 0 log entries')
  }

  // 5. Longer chain with state throughout
  {
    const state = createState({ status: 'idle', turn: 0 })
    const { interpreter, log } = createTestInterpreter({
      AskLLM: () => '{"type":"direct_response","message":"hi"}'
    }, state)

    const program = updateState('status', 'working')
      .chain(() => updateState('turn', 1))
      .chain(() => askLLM({ messages: msg('plan') }))
      .chain(plan => respond(plan))
      .chain(() => updateState('status', 'idle'))

    await Free.runWithTask(interpreter)(program)
    assert(state.get('status') === 'idle', 'full flow: status back to idle')
    assert(state.get('turn') === 1, 'full flow: turn incremented')
    assert(log.length === 5, 'full flow: 5 ops executed')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
