import { createDryRunInterpreter } from '../../src/interpreter/dryrun.js'
import {
  askLLM, executeTool, respond, approve,
  updateState, getState, Free
} from '../../src/core/op.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

const msg = (t) => [{ role: 'user', content: t }]

async function run() {
  console.log('Dry-run interpreter tests')

  // 1. Plan records all ops without real execution
  {
    const { interpreter, plan } = createDryRunInterpreter()
    const program = askLLM({ messages: msg('hi') })
      .chain(() => executeTool('github', { repo: 'test' }))
      .chain(r => respond(r))

    await Free.runWithTask(interpreter)(program)
    assert(plan.length === 3, 'plan: 3 entries recorded')
    assert(plan[0].tag === 'AskLLM', 'plan[0]: AskLLM')
    assert(plan[1].tag === 'ExecuteTool', 'plan[1]: ExecuteTool')
    assert(plan[2].tag === 'Respond', 'plan[2]: Respond')
  }

  // 2. Summary info extracted per op
  {
    const { interpreter, plan } = createDryRunInterpreter()
    await Free.runWithTask(interpreter)(
      executeTool('slack_send', { channel: '#team' })
        .chain(() => updateState('status', 'working'))
        .chain(() => getState('status'))
        .chain(() => approve('send?'))
    )
    assert(plan[0].summary === 'tool: slack_send', 'summary: ExecuteTool')
    assert(plan[1].summary === 'status = "working"', 'summary: UpdateState')
    assert(plan[2].summary === 'path: status', 'summary: GetState')
    assert(plan[3].summary === 'description: send?', 'summary: Approve')
  }

  // 3. Default stubs return stub values — no side effects
  {
    const { interpreter } = createDryRunInterpreter()
    const result = await Free.runWithTask(interpreter)(
      askLLM({ messages: msg('x') })
    )
    assert(typeof result === 'string' && result.includes('dry-run'), 'stub: AskLLM returns dry-run text')
  }

  // 4. Custom stubs override defaults
  {
    const { interpreter } = createDryRunInterpreter({
      stubs: { AskLLM: () => 'custom stub' }
    })
    const result = await Free.runWithTask(interpreter)(askLLM({ messages: msg('x') }))
    assert(result === 'custom stub', 'custom stub: overrides default')
  }

  // 5. onOp callback
  {
    const ops = []
    const { interpreter } = createDryRunInterpreter({
      onOp: (entry) => ops.push(entry.tag)
    })
    await Free.runWithTask(interpreter)(
      askLLM({ messages: msg('x') }).chain(() => respond('done'))
    )
    assert(ops.length === 2, 'onOp: called for each op')
    assert(ops[0] === 'AskLLM' && ops[1] === 'Respond', 'onOp: correct tags')
  }

  // 6. UpdateState/GetState don't modify anything
  {
    const { interpreter } = createDryRunInterpreter()
    const result = await Free.runWithTask(interpreter)(
      updateState('x', 42).chain(() => getState('x'))
    )
    assert(result === undefined, 'dry-run: GetState returns undefined (no real state)')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
