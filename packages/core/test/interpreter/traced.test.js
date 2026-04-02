import { tracedInterpreterR } from '@presence/core/interpreter/traced.js'
import { createTestInterpreter } from '@presence/core/interpreter/test.js'
import { askLLM, executeTool, respond } from '@presence/core/core/op.js'
import { runFreeWithStateT } from '@presence/core/lib/runner.js'
import { assert, summary } from '../../../../test/lib/assert.js'

const msg = (t) => [{ role: 'user', content: t }]
const initialState = {}

async function run() {
  console.log('Traced interpreter tests')

  // 1. Trace records op tags and timing (Writer 기반 getTrace)
  {
    const { interpret: inner, ST } = createTestInterpreter()
    const { interpret, getTrace } = tracedInterpreterR.run({ interpret: inner, ST })
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(
      askLLM({ messages: msg('hi') }).chain(r => respond(r))
    )(initialState)
    const trace = getTrace()
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
    const { interpret, getTrace } = tracedInterpreterR.run({ interpret: inner, ST })
    const [result] = await runFreeWithStateT(interpret, ST)(executeTool('x', {}))(initialState)
    const trace = getTrace()

    assert(result.startsWith('[ERROR]'), 'trace error: result is error string')
    assert(trace[0].error === undefined, 'trace error: no error in trace (caught by interpreter)')
    assert(typeof trace[0].duration === 'number', 'trace error: duration recorded')
  }

  // 3. onOp callback fired
  {
    const events = []
    const { interpret: inner, ST } = createTestInterpreter()
    const { interpret } = tracedInterpreterR.run({ interpret: inner, ST,
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
    const { interpret } = tracedInterpreterR.run({ interpret: inner, ST,
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
    const { interpret } = tracedInterpreterR.run({ interpret: inner, ST, logger: mockLogger })
    await runFreeWithStateT(interpret, ST)(askLLM({ messages: msg('x') }))(initialState)
    assert(logs.some(l => l.level === 'debug' && l.msg.includes('op:start')), 'logger: start logged')
    assert(logs.some(l => l.level === 'debug' && l.msg.includes('op:done')), 'logger: done logged')
  }

  // 6. Inner interpreter behavior unchanged (passthrough)
  {
    const { interpret: inner, ST } = createTestInterpreter({
      AskLLM: () => 'custom'
    })
    const { interpret } = tracedInterpreterR.run({ interpret: inner, ST })
    const [result] = await runFreeWithStateT(interpret, ST)(askLLM({ messages: msg('x') }))(initialState)
    assert(result === 'custom', 'passthrough: inner result preserved')
  }

  // 7. resetTrace clears accumulated trace
  {
    const { interpret: inner, ST } = createTestInterpreter()
    const { interpret, getTrace, resetTrace } = tracedInterpreterR.run({ interpret: inner, ST })
    await runFreeWithStateT(interpret, ST)(askLLM({ messages: msg('x') }))(initialState)
    assert(getTrace().length === 1, 'resetTrace: trace has 1 entry before reset')
    resetTrace()
    assert(getTrace().length === 0, 'resetTrace: trace empty after reset')
    // 새 실행에서 다시 축적
    await runFreeWithStateT(interpret, ST)(askLLM({ messages: msg('y') }))(initialState)
    assert(getTrace().length === 1, 'resetTrace: trace accumulates after reset')
  }

  // 8. getTrace returns immutable snapshot (Writer log)
  {
    const { interpret: inner, ST } = createTestInterpreter()
    const { interpret, getTrace } = tracedInterpreterR.run({ interpret: inner, ST })
    await runFreeWithStateT(interpret, ST)(askLLM({ messages: msg('x') }))(initialState)
    const snap1 = getTrace()
    await runFreeWithStateT(interpret, ST)(respond('done'))(initialState)
    const snap2 = getTrace()
    assert(snap1.length === 1, 'snapshot: first snapshot has 1')
    assert(snap2.length === 2, 'snapshot: second snapshot has 2')
  }

  // 9. getTrace는 방어적 복사 — 외부 변경이 내부 상태를 오염시키지 않음
  {
    const { interpret: inner, ST } = createTestInterpreter()
    const { interpret, getTrace } = tracedInterpreterR.run({ interpret: inner, ST })
    await runFreeWithStateT(interpret, ST)(askLLM({ messages: msg('x') }))(initialState)
    const snap = getTrace()
    snap.push({ tag: 'Injected', detail: null, timestamp: 0 })
    snap[0].tag = 'Tampered'
    const fresh = getTrace()
    assert(fresh.length === 1, 'defensive copy: push does not pollute internal state')
    assert(fresh[0].tag === 'AskLLM', 'defensive copy: mutation does not propagate')
  }

  summary()
}

run()
