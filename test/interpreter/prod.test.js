import { createProdInterpreter } from '../../src/interpreter/prod.js'
import { createReactiveState } from '../../src/infra/state.js'
import { createToolRegistry } from '../../src/infra/tools.js'
import { createAgentRegistry, DelegateResult } from '../../src/infra/agent-registry.js'
import {
  askLLM, executeTool, respond, approve, delegate,
  observe, updateState, getState, parallel, Free,
  runFreeWithStateT,
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

// Helper: run a Free program with the StateT-based prod interpreter
const runProg = (interpret, ST, initialState = {}) => (program) =>
  runFreeWithStateT(interpret, ST)(program)(initialState)

async function run() {
  console.log('Production interpreter tests')

  const reactiveState = createReactiveState({ status: 'idle', context: {} })
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
    const { interpret, ST } = createProdInterpreter({ llm, toolRegistry: registry, reactiveState })
    const [result] = await runProg(interpret, ST)(askLLM({ messages: msg('hi') }))
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
    const { interpret, ST } = createProdInterpreter({ llm, toolRegistry: registry, reactiveState })
    await runProg(interpret, ST)(askLLM({
      messages: msg('plan'),
      responseFormat: { type: 'json_schema', json_schema: { name: 'test' } },
    }))
    assert(capturedArgs.responseFormat.type === 'json_schema', 'AskLLM: responseFormat forwarded')
  }

  // 3. ExecuteTool → calls registered tool handler
  {
    const { interpret, ST } = createProdInterpreter({ llm: mockLLM(''), toolRegistry: registry, reactiveState })
    const [result] = await runProg(interpret, ST)(executeTool('echo', { text: 'hello' }))
    assert(result === 'echo: hello', 'ExecuteTool: handler called with args')
  }

  // 4. ExecuteTool async handler
  {
    const { interpret, ST } = createProdInterpreter({ llm: mockLLM(''), toolRegistry: registry, reactiveState })
    const [result] = await runProg(interpret, ST)(executeTool('async_tool', { val: 42 }))
    assert(result === 'async: 42', 'ExecuteTool: async handler works')
  }

  // 5. ExecuteTool unknown tool → error result string (not rejected)
  {
    const { interpret, ST } = createProdInterpreter({ llm: mockLLM(''), toolRegistry: registry, reactiveState })
    const [result] = await runProg(interpret, ST)(executeTool('nonexistent', {}))
    assert(typeof result === 'string' && result.startsWith('[ERROR]'), 'unknown tool: returns error string')
    assert(result.includes('Unknown tool'), 'unknown tool: correct error message')
  }

  // 6. Respond → passes message through
  {
    const { interpret, ST } = createProdInterpreter({ llm: mockLLM(''), toolRegistry: registry, reactiveState })
    const [result] = await runProg(interpret, ST)(respond('final answer'))
    assert(result === 'final answer', 'Respond: passes message')
  }

  // 7. Approve → auto-approve (Phase 1)
  {
    const { interpret, ST } = createProdInterpreter({ llm: mockLLM(''), toolRegistry: registry, reactiveState })
    const [result] = await runProg(interpret, ST)(approve('send email?'))
    assert(result === true, 'Approve: auto-approve returns true')
  }

  // 8. UpdateState + GetState — state changes are in finalState (pure StateT)
  {
    const localReactive = createReactiveState({ x: 0 })
    const { interpret, ST } = createProdInterpreter({ llm: mockLLM(''), toolRegistry: registry, reactiveState: localReactive })
    const initialState = { x: 0 }
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(
      updateState('x', 99).chain(() => getState('x'))
    )(initialState)
    assert(result === 99, 'UpdateState→GetState: round-trip')
    assert(finalState.x === 99, 'UpdateState: reflected in finalState')
  }

  // 9. Full chain: AskLLM → ExecuteTool → Respond
  {
    const localReactive = createReactiveState({ status: 'idle', context: {} })
    const { interpret, ST } = createProdInterpreter({
      llm: mockLLM('use echo tool'),
      toolRegistry: registry,
      reactiveState: localReactive,
    })
    const program = askLLM({ messages: msg('hi') })
      .chain(() => executeTool('echo', { text: 'world' }))
      .chain(r => respond(r))

    const [result] = await runProg(interpret, ST)(program)
    assert(result === 'echo: world', 'full chain: correct result')
  }

  // 10. Unknown op → rejected
  {
    const { interpret, ST } = createProdInterpreter({ llm: mockLLM(''), toolRegistry: registry, reactiveState })
    const FUNCTOR = Symbol.for('fun-fp-js/Functor')
    const unknownOp = {
      tag: 'Bogus', next: x => x,
      [FUNCTOR]: true,
      map: f => ({ ...unknownOp, next: x => f(unknownOp.next(x)) })
    }
    try {
      await runProg(interpret, ST)(Free.liftF(unknownOp))
      assert(false, 'unknown op: should reject')
    } catch (e) {
      assert(e.message.includes('Unknown op'), 'unknown op: correct error')
    }
  }

  // 11. LLM failure → rejected
  {
    const badLLM = { chat: async () => { throw new Error('connection refused') } }
    const { interpret, ST } = createProdInterpreter({ llm: badLLM, toolRegistry: registry, reactiveState })
    try {
      await runProg(interpret, ST)(askLLM({ messages: msg('fail') }))
      assert(false, 'LLM failure: should reject')
    } catch (e) {
      assert(e.message === 'connection refused', 'LLM failure: error propagated')
    }
  }

  // 12. Tool handler throws → rejected
  {
    const throwRegistry = createToolRegistry()
    throwRegistry.register({ name: 'bomb', handler: () => { throw new Error('boom') } })
    const { interpret, ST } = createProdInterpreter({ llm: mockLLM(''), toolRegistry: throwRegistry, reactiveState })
    try {
      await runProg(interpret, ST)(executeTool('bomb', {}))
      assert(false, 'tool throw: should reject')
    } catch (e) {
      assert(e.message === 'boom', 'tool throw: error propagated')
    }
  }

  // --- tool_calls 응답 처리 ---

  // 13. AskLLM: LLM이 tool_calls를 반환하면 content가 아닌 tool_calls 구조를 전달해야 함
  {
    const llm = {
      chat: async () => ({
        type: 'tool_calls',
        toolCalls: [{ id: 'tc1', function: { name: 'search', arguments: '{"q":"test"}' } }],
        raw: {}
      })
    }
    const { interpret, ST } = createProdInterpreter({ llm, toolRegistry: registry, reactiveState })
    const [result] = await runProg(interpret, ST)(askLLM({ messages: msg('find') }))
    // 현재 코드는 result.content만 읽으므로 tool_calls 시 undefined가 됨
    assert(result !== undefined, 'tool_calls: result is not undefined')
    assert(Array.isArray(result.toolCalls), 'tool_calls: toolCalls array returned')
    assert(result.toolCalls[0].function.name === 'search', 'tool_calls: function name preserved')
  }

  // --- Parallel 동작 명시 ---

  // 14. Parallel: allSettled — 성공 + 에러결과 혼합
  {
    const failRegistry = createToolRegistry()
    failRegistry.register({ name: 'ok-tool', handler: () => 'ok' })
    const { interpret, ST } = createProdInterpreter({ llm: mockLLM(''), toolRegistry: failRegistry, reactiveState })
    const programs = [
      respond('ok'),
      executeTool('nonexistent-tool', {}),  // unknown tool → error result string (not rejected)
    ]
    const [result] = await runProg(interpret, ST)(parallel(programs))
    assert(Array.isArray(result), 'Parallel: returns array')
    assert(result.length === 2, 'Parallel: 2 results')
    assert(result[0].status === 'fulfilled', 'Parallel: first fulfilled')
    assert(result[0].value === 'ok', 'Parallel: first value')
    assert(result[1].status === 'fulfilled', 'Parallel: second fulfilled (error as result)')
    assert(typeof result[1].value === 'string' && result[1].value.startsWith('[ERROR]'), 'Parallel: second value is error string')
  }

  // 14b. Parallel: 빈 배열 → 빈 배열 반환
  {
    const { interpret, ST } = createProdInterpreter({ llm: mockLLM(''), toolRegistry: registry, reactiveState })
    const [result] = await runProg(interpret, ST)(parallel([]))
    assert(Array.isArray(result) && result.length === 0, 'Parallel empty: returns []')
  }

  // --- Delegate ---

  // 14c. Delegate: local agent → completed
  {
    const agentReg = createAgentRegistry()
    agentReg.register({
      name: 'reviewer',
      description: 'Code reviewer',
      run: async (task) => `reviewed: ${task}`,
    })
    const { interpret, ST } = createProdInterpreter({
      llm: mockLLM(''), toolRegistry: registry, reactiveState, agentRegistry: agentReg
    })
    const [result] = await runProg(interpret, ST)(delegate('reviewer', 'check PR'))
    assert(result.status === 'completed', 'Delegate local: completed')
    assert(result.output === 'reviewed: check PR', 'Delegate local: output')
    assert(result.mode === 'local', 'Delegate local: mode')
  }

  // 14d. Delegate: unknown agent → failed
  {
    const { interpret, ST } = createProdInterpreter({
      llm: mockLLM(''), toolRegistry: registry, reactiveState, agentRegistry: createAgentRegistry()
    })
    const [result] = await runProg(interpret, ST)(delegate('nonexistent', 'task'))
    assert(result.status === 'failed', 'Delegate unknown: failed')
    assert(result.error.includes('nonexistent'), 'Delegate unknown: error mentions target')
  }

  // 14e. Delegate: local agent throws → failed (not interpreter exception)
  {
    const agentReg = createAgentRegistry()
    agentReg.register({
      name: 'crasher',
      description: 'Agent that crashes',
      run: async () => { throw new Error('agent crash') },
    })
    const { interpret, ST } = createProdInterpreter({
      llm: mockLLM(''), toolRegistry: registry, reactiveState, agentRegistry: agentReg
    })
    const [result] = await runProg(interpret, ST)(delegate('crasher', 'task'))
    assert(result.status === 'failed', 'Delegate crash: failed (not exception)')
    assert(result.error === 'agent crash', 'Delegate crash: error message')
    assert(result.mode === 'local', 'Delegate crash: mode local')
  }

  // 14f. Delegate: remote agent → A2A completed
  {
    const agentReg = createAgentRegistry()
    agentReg.register({
      name: 'remote-helper',
      description: 'Remote agent',
      type: 'remote',
      endpoint: 'https://a2a.test/rpc',
    })
    const mockFetch = async (url, opts) => ({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0', id: '1',
        result: {
          id: JSON.parse(opts.body).params.id,
          status: { state: 'completed' },
          artifacts: [{ parts: [{ kind: 'text', text: 'remote result' }] }],
        },
      }),
    })
    const { interpret, ST } = createProdInterpreter({
      llm: mockLLM(''), toolRegistry: registry, reactiveState, agentRegistry: agentReg, fetchFn: mockFetch,
    })
    const [result] = await runProg(interpret, ST)(delegate('remote-helper', 'task'))
    assert(result.status === 'completed', 'Delegate remote completed: status')
    assert(result.output === 'remote result', 'Delegate remote completed: output')
    assert(result.mode === 'remote', 'Delegate remote completed: mode')
  }

  // 14f2. Delegate: remote agent → 네트워크 실패 시 failed (not thrown)
  {
    const agentReg = createAgentRegistry()
    agentReg.register({
      name: 'remote-down',
      description: 'Remote agent (down)',
      type: 'remote',
      endpoint: 'https://a2a.test/rpc',
    })
    const mockFetch = async () => { throw new Error('ECONNREFUSED') }
    const { interpret, ST } = createProdInterpreter({
      llm: mockLLM(''), toolRegistry: registry, reactiveState, agentRegistry: agentReg, fetchFn: mockFetch,
    })
    const [result] = await runProg(interpret, ST)(delegate('remote-down', 'task'))
    assert(result.status === 'failed', 'Delegate remote fail: returns failed')
    assert(result.error.includes('ECONNREFUSED'), 'Delegate remote fail: error message')
  }

  // 14f3. Delegate: remote submitted → pending에 등록
  {
    const testReactive = createReactiveState({ delegates: { pending: [] } })
    const agentReg = createAgentRegistry()
    agentReg.register({
      name: 'slow-agent',
      description: 'Slow remote',
      type: 'remote',
      endpoint: 'https://a2a.test/rpc',
    })
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0', id: '1',
        result: { id: 'task-slow-1', status: { state: 'submitted' } },
      }),
    })
    const { interpret, ST } = createProdInterpreter({
      llm: mockLLM(''), toolRegistry: registry, reactiveState: testReactive, agentRegistry: agentReg, fetchFn: mockFetch,
    })
    const [result] = await runProg(interpret, ST)(delegate('slow-agent', 'long task'))
    assert(result.status === 'submitted', 'Delegate submitted: status')
    const pending = testReactive.get('delegates.pending')
    assert(pending.length === 1, 'Delegate submitted: added to pending')
    assert(pending[0].target === 'slow-agent', 'Delegate submitted: pending target')
    assert(pending[0].taskId === 'task-slow-1', 'Delegate submitted: pending taskId')
  }

  // 14g. Delegate: no agentRegistry → failed
  {
    const { interpret, ST } = createProdInterpreter({
      llm: mockLLM(''), toolRegistry: registry, reactiveState
    })
    const [result] = await runProg(interpret, ST)(delegate('any', 'task'))
    assert(result.status === 'failed', 'Delegate no registry: failed')
  }

  // 14h. 통합: parsePlan DELEGATE step → registry → local run → 결과가 plan results에 포함
  {
    const agentReg = createAgentRegistry()
    agentReg.register({
      name: 'summarizer',
      description: 'Summarizer',
      run: async (task) => `요약: ${task}`,
    })

    let askCallNum = 0
    const llm = {
      chat: async ({ messages }) => {
        askCallNum++
        if (askCallNum === 1) {
          // planner: DELEGATE → RESPOND
          return { type: 'text', content: JSON.stringify({
            type: 'plan',
            steps: [
              { op: 'DELEGATE', args: { target: 'summarizer', task: '긴 보고서 내용' } },
              { op: 'RESPOND', args: { ref: 1 } },
            ]
          })}
        }
        // formatter
        return { type: 'text', content: `결과: ${messages[1]?.content || ''}` }
      }
    }

    const { interpret, ST } = createProdInterpreter({ llm, toolRegistry: registry, reactiveState, agentRegistry: agentReg })

    const { createAgentTurn } = await import('../../src/core/agent.js')
    const turn = createAgentTurn({ tools: [], agents: agentReg.list() })
    const [result] = await runFreeWithStateT(interpret, ST)(turn('보고서 요약해줘'))({})

    // RESPOND가 DelegateResult를 직접 전달 (formatter 없음)
    assert(result != null && result.status === 'completed', 'full delegate path: returns DelegateResult')
  }

  // --- context 전달 ---

  // 15. AskLLM: context가 있으면 messages에 참조 컨텍스트로 주입되어 LLM에 전달
  {
    let capturedMessages = null
    const llm = {
      chat: async ({ messages }) => {
        capturedMessages = messages
        return { type: 'text', content: 'summary' }
      }
    }
    const { interpret, ST } = createProdInterpreter({ llm, toolRegistry: registry, reactiveState })
    const [result] = await runProg(interpret, ST)(askLLM({
      messages: [{ role: 'user', content: '요약해줘' }],
      context: ['PR 3건 조회됨', '이슈 2건 진행중'],
    }))

    // context 내용이 LLM에 전달된 messages 안에 포함되어야 함
    const allText = capturedMessages.map(m => m.content).join('\n')
    assert(allText.includes('PR 3건 조회됨'), 'context: first ref delivered to LLM')
    assert(allText.includes('이슈 2건 진행중'), 'context: second ref delivered to LLM')
    assert(result === 'summary', 'context: result still returned normally')
  }

  // 16. AskLLM: context가 없거나 빈 배열이면 messages 변경 없음
  {
    let capturedMessages = null
    const llm = {
      chat: async ({ messages }) => {
        capturedMessages = messages
        return { type: 'text', content: 'ok' }
      }
    }
    const { interpret, ST } = createProdInterpreter({ llm, toolRegistry: registry, reactiveState })
    await runProg(interpret, ST)(askLLM({
      messages: [{ role: 'user', content: 'hello' }],
    }))
    assert(capturedMessages.length === 1, 'no context: messages unchanged (1)')

    await runProg(interpret, ST)(askLLM({
      messages: [{ role: 'user', content: 'hello' }],
      context: [],
    }))
    assert(capturedMessages.length === 1, 'empty context: messages unchanged (1)')
  }

  // --- Parallel UI 격리 ---

  // 17. Parallel 브랜치가 _toolResults를 오염시키지 않음
  {
    const toolReg = createToolRegistry()
    toolReg.register({ name: 'branch-tool', handler: (args) => `result-${args.id}` })
    const rs = createReactiveState({ _toolResults: [] })
    const { interpret, ST } = createProdInterpreter({ llm: mockLLM(''), toolRegistry: toolReg, reactiveState: rs })
    const programs = [
      executeTool('branch-tool', { id: 'a' }),
      executeTool('branch-tool', { id: 'b' }),
    ]
    const [result] = await runProg(interpret, ST)(parallel(programs))
    assert(result.length === 2, 'Parallel UI isolation: 2 results')
    assert(result[0].status === 'fulfilled', 'Parallel UI isolation: first fulfilled')
    assert(result[1].status === 'fulfilled', 'Parallel UI isolation: second fulfilled')
    const toolResults = rs.get('_toolResults') || []
    assert(toolResults.length === 0, 'Parallel UI isolation: _toolResults not polluted')
  }

  // 17b. Parallel 후 일반 ExecuteTool은 _toolResults에 정상 기록
  {
    const toolReg = createToolRegistry()
    toolReg.register({ name: 'main-tool', handler: () => 'main-result' })
    const rs = createReactiveState({ _toolResults: [] })
    const { interpret, ST } = createProdInterpreter({ llm: mockLLM(''), toolRegistry: toolReg, reactiveState: rs })
    // parallel 실행 후 uiState 복원 확인
    const program = parallel([executeTool('main-tool', {})]).chain(() => executeTool('main-tool', { after: true }))
    const [result, finalState] = await runProg(interpret, ST)(program)
    const toolResults = rs.get('_toolResults') || []
    assert(toolResults.length === 1, 'Parallel UI restore: _toolResults has 1 (main only)')
    assert(toolResults[0].args.after === true, 'Parallel UI restore: only post-parallel tool recorded')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
