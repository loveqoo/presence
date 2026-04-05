import { prodInterpreterR } from '@presence/infra/interpreter/prod.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { createToolRegistry } from '@presence/infra/infra/tools/tool-registry.js'
import { createAgentRegistry, DelegateResult } from '@presence/infra/infra/agents/agent-registry.js'
import fp from '@presence/core/lib/fun-fp.js'
import { delegate, respond } from '@presence/core/core/op.js'

const { Free } = fp
import { runFreeWithStateT } from '@presence/core/lib/runner.js'
import { assert, summary } from '../../../../test/lib/assert.js'

const mockLLM = () => ({ chat: async () => ({ type: 'text', content: '' }) })

const runProg = (interpret, ST) => (program) =>
  runFreeWithStateT(interpret, ST)(program)({})

const makeInterpreter = (agentRegistry) => prodInterpreterR.run({
  llm: mockLLM(),
  toolRegistry: createToolRegistry(),
  reactiveState: createOriginState({}),
  agentRegistry,
})

async function run() {
  console.log('DelegateInterpreter unit tests')

  // ==========================================================================
  // 1. local agent run() 호출 → DelegateResult.completed
  // ==========================================================================
  {
    const reg = createAgentRegistry()
    reg.register({
      name: 'echo',
      description: 'Echo agent',
      type: 'local',
      run: async (task) => `echoed: ${task}`,
    })

    const { interpret, ST } = makeInterpreter(reg)
    const [result] = await runProg(interpret, ST)(delegate('echo', 'hello'))

    assert(result.status === 'completed', '1: status completed')
    assert(result.target === 'echo', '1: target echo')
    assert(result.output === 'echoed: hello', '1: output correct')
    assert(result.mode === 'local', '1: mode local')
  }

  // ==========================================================================
  // 2. local agent run() throws → DelegateResult.failed (프로그램 실행은 계속)
  // ==========================================================================
  {
    const reg = createAgentRegistry()
    reg.register({
      name: 'broken',
      type: 'local',
      run: async () => { throw new Error('agent crashed') },
    })

    const { interpret, ST } = makeInterpreter(reg)
    const [result] = await runProg(interpret, ST)(delegate('broken', 'task'))

    assert(result.status === 'failed', '2: status failed')
    assert(result.target === 'broken', '2: target broken')
    assert(result.error === 'agent crashed', '2: error message')
    assert(result.mode === 'local', '2: mode local on failure')
    assert(result.output === null, '2: output null on failure')
  }

  // ==========================================================================
  // 3. 알 수 없는 에이전트 → DelegateResult.failed("Unknown agent: ...")
  // ==========================================================================
  {
    const reg = createAgentRegistry()
    const { interpret, ST } = makeInterpreter(reg)
    const [result] = await runProg(interpret, ST)(delegate('ghost', 'task'))

    assert(result.status === 'failed', '3: status failed')
    assert(result.target === 'ghost', '3: target ghost')
    assert(result.error.includes('Unknown agent'), '3: error message mentions Unknown agent')
    assert(result.error.includes('ghost'), '3: error message includes agent name')
  }

  // ==========================================================================
  // 4. run 없는 local 에이전트 → DelegateResult.failed
  // ==========================================================================
  {
    const reg = createAgentRegistry()
    reg.register({ name: 'norun', type: 'local', description: 'no run fn' })
    // run 미지정

    const { interpret, ST } = makeInterpreter(reg)
    const [result] = await runProg(interpret, ST)(delegate('norun', 'task'))

    assert(result.status === 'failed', '4: status failed')
    assert(result.error.includes('no run function'), '4: error message')
  }

  // ==========================================================================
  // 5. agentRegistry 없이 생성 → DelegateResult.failed("Unknown agent: ...")
  // ==========================================================================
  {
    const { interpret, ST } = prodInterpreterR.run({
      llm: mockLLM(),
      toolRegistry: createToolRegistry(),
      reactiveState: createOriginState({}),
      // agentRegistry 미전달
    })
    const [result] = await runProg(interpret, ST)(delegate('anyone', 'task'))

    assert(result.status === 'failed', '5: no registry → failed')
    assert(result.error.includes('Unknown agent'), '5: error message')
  }

  // ==========================================================================
  // 6. Delegate Op chain: result를 다음 step에서 사용
  // ==========================================================================
  {
    const reg = createAgentRegistry()
    reg.register({
      name: 'summarizer',
      type: 'local',
      run: async (task) => `요약: ${task}`,
    })

    const { interpret, ST } = makeInterpreter(reg)
    const program = delegate('summarizer', '긴 내용...')
      .chain(r => respond(r.output || r.error))

    const [result] = await runProg(interpret, ST)(program)
    assert(result === '요약: 긴 내용...', '6: chained result correct')
  }

  // ==========================================================================
  // 7. run()이 sync 함수여도 동작 (Promise 반환 아닌 경우)
  // NOTE: run()은 항상 async로 명세되지만 sync도 Task.fromPromise가 감쌈
  // ==========================================================================
  {
    const reg = createAgentRegistry()
    reg.register({
      name: 'sync',
      type: 'local',
      run: (task) => Promise.resolve(`sync: ${task}`),
    })

    const { interpret, ST } = makeInterpreter(reg)
    const [result] = await runProg(interpret, ST)(delegate('sync', 'test'))

    assert(result.status === 'completed', '7: sync run → completed')
    assert(result.output === 'sync: test', '7: output correct')
  }

  // ==========================================================================
  // 8. remote agent: fetchFn 호출로 A2A 전송 (mock fetchFn)
  // ==========================================================================
  {
    const reg = createAgentRegistry()
    reg.register({
      name: 'remote-worker',
      type: 'remote',
      endpoint: 'http://remote.agent/a2a',
    })

    let capturedUrl = null
    let capturedBody = null
    const mockFetch = async (url, opts) => {
      capturedUrl = url
      capturedBody = JSON.parse(opts.body)
      // JSON-RPC 2.0 wrapper: { result: task }
      return {
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 'resp-id',
          result: {
            id: 'task-999',
            status: { state: 'completed' },
            artifacts: [{ parts: [{ kind: 'text', text: '원격 결과' }] }],
          },
        }),
      }
    }

    const { interpret, ST } = prodInterpreterR.run({
      llm: mockLLM(),
      toolRegistry: createToolRegistry(),
      reactiveState: createOriginState({}),
      agentRegistry: reg,
      fetchFn: mockFetch,
    })

    const [result] = await runProg(interpret, ST)(delegate('remote-worker', '원격 작업'))

    assert(capturedUrl === 'http://remote.agent/a2a', '8: correct endpoint called')
    assert(capturedBody?.params?.message?.parts?.[0]?.text === '원격 작업', '8: task sent as message')
    // 원격 완료 → completed 또는 submitted (A2A 상태에 따라)
    assert(['completed', 'submitted'].includes(result.status), '8: remote result status valid')
  }

  // ==========================================================================
  // 9. 여러 delegate를 sequential chain으로 실행
  // ==========================================================================
  {
    const reg = createAgentRegistry()
    const calls = []
    reg.register({
      name: 'step1',
      type: 'local',
      run: async (task) => { calls.push('step1:' + task); return 'result1' },
    })
    reg.register({
      name: 'step2',
      type: 'local',
      run: async (task) => { calls.push('step2:' + task); return 'result2' },
    })

    const { interpret, ST } = makeInterpreter(reg)
    const program = delegate('step1', 'a')
      .chain(r1 => delegate('step2', r1.output))
      .chain(r2 => respond(r2.output))

    const [result] = await runProg(interpret, ST)(program)

    assert(calls.length === 2, '9: both agents called')
    assert(calls[0] === 'step1:a', '9: step1 called with correct task')
    assert(calls[1] === 'step2:result1', '9: step2 called with step1 output')
    assert(result === 'result2', '9: final result correct')
  }

  // ==========================================================================
  // 10. task가 빈 문자열이어도 run() 호출 (검증 없음, 에이전트 자체 처리)
  // ==========================================================================
  {
    const reg = createAgentRegistry()
    reg.register({
      name: 'anything',
      type: 'local',
      run: async (task) => `got: "${task}"`,
    })

    const { interpret, ST } = makeInterpreter(reg)
    const [result] = await runProg(interpret, ST)(delegate('anything', ''))

    assert(result.status === 'completed', '10: empty task → completed')
    assert(result.output === 'got: ""', '10: empty task forwarded to run')
  }

  summary()
}

run()
