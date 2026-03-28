import { createTracedInterpreter } from '@presence/core/interpreter/traced.js'
import { createTestInterpreter } from '@presence/core/interpreter/test.js'
import { askLLM, executeTool, respond, runFreeWithStateT } from '@presence/core/core/op.js'
import { assert, summary } from '../lib/assert.js'

const msg = (t) => [{ role: 'user', content: t }]
const initialState = {}

async function run() {
  console.log('Traced interpreter tests')

  // 1. Trace records op tags and timing
  {
    const { interpret: inner, ST } = createTestInterpreter()
    const { interpret, trace } = createTracedInterpreter({ interpret: inner, ST })
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(
      askLLM({ messages: msg('hi') }).chain(r => respond(r))
    )(initialState)
    assert(trace.length === 2, 'trace: 2 entries')
    assert(trace[0].tag === 'AskLLM', 'trace: first tag')
    assert(trace[1].tag === 'Respond', 'trace: second tag')
    assert(typeof trace[0].duration === 'number', 'trace: has duration')
    assert(trace[0].error === undefined, 'trace: no error on success')
  }

  // 2. ExecuteTool error captured as result (not thrown), trace shows success
  {
    const { interpret: inner, ST } = createTestInterpreter({
      ExecuteTool: () => { throw new Error('fail') }
    })
    const { interpret, trace } = createTracedInterpreter({ interpret: inner, ST })
    const [result] = await runFreeWithStateT(interpret, ST)(executeTool('x', {}))(initialState)

    assert(result.startsWith('[ERROR]'), 'trace error: result is error string')
    assert(trace[0].error === undefined, 'trace error: no error in trace (caught by interpreter)')
    assert(typeof trace[0].duration === 'number', 'trace error: duration recorded')
  }

  // 3. onOp callback fired
  {
    const events = []
    const { interpret: inner, ST } = createTestInterpreter()
    const { interpret } = createTracedInterpreter({ interpret: inner, ST }, {
      onOp: (phase, entry) => events.push({ phase, tag: entry.tag })
    })
    await runFreeWithStateT(interpret, ST)(askLLM({ messages: msg('x') }))(initialState)
    assert(events.length === 2, 'onOp: 2 events (start + done)')
    assert(events[0].phase === 'start', 'onOp: first is start')
    assert(events[1].phase === 'done', 'onOp: second is done')
  }

  // 4. onOp with error
  {
    const events = []
    const { interpret: inner, ST } = createTestInterpreter({
      AskLLM: () => { throw new Error('boom') }
    })
    const { interpret } = createTracedInterpreter({ interpret: inner, ST }, {
      onOp: (phase, entry) => events.push({ phase, tag: entry.tag })
    })
    try { await runFreeWithStateT(interpret, ST)(askLLM({ messages: msg('x') }))(initialState) }
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
    const { interpret: inner, ST } = createTestInterpreter()
    const { interpret } = createTracedInterpreter({ interpret: inner, ST }, { logger: mockLogger })
    await runFreeWithStateT(interpret, ST)(askLLM({ messages: msg('x') }))(initialState)
    assert(logs.some(l => l.level === 'debug' && l.msg.includes('op:start')), 'logger: start logged')
    assert(logs.some(l => l.level === 'debug' && l.msg.includes('op:done')), 'logger: done logged')
  }

  // 6. Inner interpreter behavior unchanged (passthrough)
  {
    const { interpret: inner, ST } = createTestInterpreter({
      AskLLM: () => 'custom'
    })
    const { interpret } = createTracedInterpreter({ interpret: inner, ST })
    const [result] = await runFreeWithStateT(interpret, ST)(askLLM({ messages: msg('x') }))(initialState)
    assert(result === 'custom', 'passthrough: inner result preserved')
  }

  summary()
}

run()
