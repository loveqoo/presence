import { createTracedInterpreter } from '../../src/interpreter/traced.js'
import { createTestInterpreter } from '../../src/interpreter/test.js'
import { askLLM, executeTool, respond, Free } from '../../src/core/op.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

const msg = (t) => [{ role: 'user', content: t }]

async function run() {
  console.log('Traced interpreter tests')

  // 1. Trace records op tags and timing
  {
    const { interpreter: inner } = createTestInterpreter()
    const { interpreter, trace } = createTracedInterpreter(inner)
    await Free.runWithTask(interpreter)(
      askLLM({ messages: msg('hi') }).chain(r => respond(r))
    )
    assert(trace.length === 2, 'trace: 2 entries')
    assert(trace[0].tag === 'AskLLM', 'trace: first tag')
    assert(trace[1].tag === 'Respond', 'trace: second tag')
    assert(typeof trace[0].duration === 'number', 'trace: has duration')
    assert(trace[0].error === undefined, 'trace: no error on success')
  }

  // 2. Error recorded in trace
  {
    const { interpreter: inner } = createTestInterpreter({
      ExecuteTool: () => { throw new Error('fail') }
    })
    const { interpreter, trace } = createTracedInterpreter(inner)
    try {
      await Free.runWithTask(interpreter)(executeTool('x', {}))
    } catch (_) {}

    assert(trace[0].error === 'fail', 'trace error: error message recorded')
    assert(typeof trace[0].duration === 'number', 'trace error: duration recorded')
  }

  // 3. onOp callback fired
  {
    const events = []
    const { interpreter: inner } = createTestInterpreter()
    const { interpreter } = createTracedInterpreter(inner, {
      onOp: (phase, entry) => events.push({ phase, tag: entry.tag })
    })
    await Free.runWithTask(interpreter)(askLLM({ messages: msg('x') }))
    assert(events.length === 2, 'onOp: 2 events (start + done)')
    assert(events[0].phase === 'start', 'onOp: first is start')
    assert(events[1].phase === 'done', 'onOp: second is done')
  }

  // 4. onOp with error
  {
    const events = []
    const { interpreter: inner } = createTestInterpreter({
      AskLLM: () => { throw new Error('boom') }
    })
    const { interpreter } = createTracedInterpreter(inner, {
      onOp: (phase, entry) => events.push({ phase, tag: entry.tag })
    })
    try { await Free.runWithTask(interpreter)(askLLM({ messages: msg('x') })) }
    catch (_) {}
    assert(events[1].phase === 'error', 'onOp error: second event is error')
  }

  // 5. Logger receives debug/warn calls
  {
    const logs = []
    const mockLogger = {
      debug: (msg) => logs.push({ level: 'debug', msg }),
      warn: (msg) => logs.push({ level: 'warn', msg }),
    }
    const { interpreter: inner } = createTestInterpreter()
    const { interpreter } = createTracedInterpreter(inner, { logger: mockLogger })
    await Free.runWithTask(interpreter)(askLLM({ messages: msg('x') }))
    assert(logs.some(l => l.level === 'debug' && l.msg.includes('op:start')), 'logger: start logged')
    assert(logs.some(l => l.level === 'debug' && l.msg.includes('op:done')), 'logger: done logged')
  }

  // 6. Inner interpreter behavior unchanged (passthrough)
  {
    const { interpreter: inner } = createTestInterpreter({
      AskLLM: () => 'custom'
    })
    const { interpreter } = createTracedInterpreter(inner)
    const result = await Free.runWithTask(interpreter)(askLLM({ messages: msg('x') }))
    assert(result === 'custom', 'passthrough: inner result preserved')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
