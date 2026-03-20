import { createProdInterpreter } from '../../src/interpreter/prod.js'
import { createReactiveState } from '../../src/infra/state.js'
import { createToolRegistry } from '../../src/infra/tools.js'
import {
  askLLM, executeTool, respond, approve, delegate,
  observe, updateState, getState, Free
} from '../../src/core/op.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

const msg = (text) => [{ role: 'user', content: text }]

// Mock LLM
const mockLLM = (response) => ({
  chat: async () => ({ type: 'text', content: response })
})

async function run() {
  console.log('Production interpreter tests')

  const state = createReactiveState({ status: 'idle', context: {} })
  const registry = createToolRegistry()
  registry.register({
    name: 'echo',
    description: 'echoes input',
    handler: (args) => `echo: ${args.text}`,
  })
  registry.register({
    name: 'async_tool',
    description: 'async tool',
    handler: async (args) => `async: ${args.val}`,
  })

  // 1. AskLLM → calls llm.chat, returns content
  {
    let capturedArgs = null
    const llm = {
      chat: async (args) => {
        capturedArgs = args
        return { type: 'text', content: 'llm response' }
      }
    }
    const interp = createProdInterpreter({ llm, toolRegistry: registry, state })
    const result = await Free.runWithTask(interp)(askLLM({ messages: msg('hi') }))
    assert(result === 'llm response', 'AskLLM: returns content')
    assert(capturedArgs.messages[0].content === 'hi', 'AskLLM: passes messages to llm')
  }

  // 2. AskLLM with responseFormat → forwarded to llm
  {
    let capturedArgs = null
    const llm = {
      chat: async (args) => {
        capturedArgs = args
        return { type: 'text', content: '{"type":"plan"}' }
      }
    }
    const interp = createProdInterpreter({ llm, toolRegistry: registry, state })
    await Free.runWithTask(interp)(askLLM({
      messages: msg('plan'),
      responseFormat: { type: 'json_schema', json_schema: { name: 'test' } },
    }))
    assert(capturedArgs.responseFormat.type === 'json_schema', 'AskLLM: responseFormat forwarded')
  }

  // 3. ExecuteTool → calls registered tool handler
  {
    const interp = createProdInterpreter({ llm: mockLLM(''), toolRegistry: registry, state })
    const result = await Free.runWithTask(interp)(executeTool('echo', { text: 'hello' }))
    assert(result === 'echo: hello', 'ExecuteTool: handler called with args')
  }

  // 4. ExecuteTool async handler
  {
    const interp = createProdInterpreter({ llm: mockLLM(''), toolRegistry: registry, state })
    const result = await Free.runWithTask(interp)(executeTool('async_tool', { val: 42 }))
    assert(result === 'async: 42', 'ExecuteTool: async handler works')
  }

  // 5. ExecuteTool unknown tool → rejected
  {
    const interp = createProdInterpreter({ llm: mockLLM(''), toolRegistry: registry, state })
    try {
      await Free.runWithTask(interp)(executeTool('nonexistent', {}))
      assert(false, 'unknown tool: should reject')
    } catch (e) {
      assert(e.message.includes('Unknown tool'), 'unknown tool: correct error')
    }
  }

  // 6. Respond → passes message through
  {
    const interp = createProdInterpreter({ llm: mockLLM(''), toolRegistry: registry, state })
    const result = await Free.runWithTask(interp)(respond('final answer'))
    assert(result === 'final answer', 'Respond: passes message')
  }

  // 7. Approve → auto-approve (Phase 1)
  {
    const interp = createProdInterpreter({ llm: mockLLM(''), toolRegistry: registry, state })
    const result = await Free.runWithTask(interp)(approve('send email?'))
    assert(result === true, 'Approve: auto-approve returns true')
  }

  // 8. UpdateState + GetState
  {
    const localState = createReactiveState({ x: 0 })
    const interp = createProdInterpreter({ llm: mockLLM(''), toolRegistry: registry, state: localState })
    const result = await Free.runWithTask(interp)(
      updateState('x', 99).chain(() => getState('x'))
    )
    assert(result === 99, 'UpdateState→GetState: round-trip')
    assert(localState.get('x') === 99, 'UpdateState: reflected in state')
  }

  // 9. Full chain: AskLLM → ExecuteTool → Respond
  {
    const localState = createReactiveState({ status: 'idle', context: {} })
    const interp = createProdInterpreter({
      llm: mockLLM('use echo tool'),
      toolRegistry: registry,
      state: localState,
    })
    const program = askLLM({ messages: msg('hi') })
      .chain(() => executeTool('echo', { text: 'world' }))
      .chain(r => respond(r))

    const result = await Free.runWithTask(interp)(program)
    assert(result === 'echo: world', 'full chain: correct result')
  }

  // 10. Unknown op → rejected
  {
    const interp = createProdInterpreter({ llm: mockLLM(''), toolRegistry: registry, state })
    const FUNCTOR = Symbol.for('fun-fp-js/Functor')
    const unknownOp = {
      tag: 'Bogus', next: x => x,
      [FUNCTOR]: true,
      map: f => ({ ...unknownOp, next: x => f(unknownOp.next(x)) })
    }
    try {
      await Free.runWithTask(interp)(Free.liftF(unknownOp))
      assert(false, 'unknown op: should reject')
    } catch (e) {
      assert(e.message.includes('Unknown op'), 'unknown op: correct error')
    }
  }

  // 11. LLM failure → rejected
  {
    const badLLM = { chat: async () => { throw new Error('connection refused') } }
    const interp = createProdInterpreter({ llm: badLLM, toolRegistry: registry, state })
    try {
      await Free.runWithTask(interp)(askLLM({ messages: msg('fail') }))
      assert(false, 'LLM failure: should reject')
    } catch (e) {
      assert(e.message === 'connection refused', 'LLM failure: error propagated')
    }
  }

  // 12. Tool handler throws → rejected
  {
    const throwRegistry = createToolRegistry()
    throwRegistry.register({ name: 'bomb', handler: () => { throw new Error('boom') } })
    const interp = createProdInterpreter({ llm: mockLLM(''), toolRegistry: throwRegistry, state })
    try {
      await Free.runWithTask(interp)(executeTool('bomb', {}))
      assert(false, 'tool throw: should reject')
    } catch (e) {
      assert(e.message === 'boom', 'tool throw: error propagated')
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
