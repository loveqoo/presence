import { A2AClient } from '@presence/infra/infra/agents/a2a-client.js'
import { Artifact, A2ATask, JsonRpc, Method, TaskState } from '@presence/infra/infra/agents/a2a-protocol.js'
import { createAgentRegistry } from '@presence/infra/infra/agents/agent-registry.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { TurnState } from '@presence/core/core/policies.js'
import { delegateActorR } from '@presence/infra/infra/actors/delegate-actor.js'
import { eventActorR } from '@presence/infra/infra/actors/event-actor.js'
import { turnActorR } from '@presence/infra/infra/actors/turn-actor.js'
import { forkTask } from '@presence/core/lib/task.js'
import { assert, summary } from '../../../test/lib/assert.js'

async function run() {
  console.log('A2A protocol + client tests')

  // ===========================================
  // Artifact.extractText (순수)
  // ===========================================

  {
    const text = Artifact.extractText([
      { parts: [{ kind: 'text', text: 'hello' }] },
      { parts: [{ kind: 'text', text: 'world' }, { kind: 'image', data: '...' }] },
    ])
    assert(text === 'hello\nworld', 'Artifact.extractText: text parts joined')
  }

  {
    assert(Artifact.extractText(null) === null, 'Artifact.extractText: null → null')
    assert(Artifact.extractText([]) === null, 'Artifact.extractText: empty → null')
    assert(Artifact.extractText([{ parts: [] }]) === null, 'Artifact.extractText: no text parts → null')
  }

  // ===========================================
  // JsonRpc.request (순수)
  // ===========================================

  {
    const req = JsonRpc.request(Method.SEND, { id: 't1', message: { role: 'user', parts: [{ kind: 'text', text: 'hello' }] } })
    assert(req.jsonrpc === '2.0', 'JsonRpc.request: jsonrpc 2.0')
    assert(req.method === 'message/send', 'JsonRpc.request: method SEND')
    assert(typeof req.id === 'string' && req.id.length > 0, 'JsonRpc.request: generated id')
    assert(req.params.id === 't1', 'JsonRpc.request: params.id')
  }

  {
    const req = JsonRpc.request(Method.GET, { id: 'tid-42' })
    assert(req.method === 'tasks/get', 'JsonRpc.request: method GET')
    assert(req.params.id === 'tid-42', 'JsonRpc.request: task id')
  }

  // ===========================================
  // A2ATask.fromResponse (state machine)
  // ===========================================

  // completed
  {
    const r = A2ATask.fromResponse('agent-x', 'tid', {
      result: {
        id: 'tid',
        status: { state: TaskState.COMPLETED },
        artifacts: [{ parts: [{ kind: 'text', text: 'done' }] }],
      },
    })
    assert(r.status === 'completed', 'A2ATask.fromResponse completed: status')
    assert(r.output === 'done', 'A2ATask.fromResponse completed: output')
    assert(r.mode === 'remote', 'A2ATask.fromResponse completed: mode')
  }

  // submitted
  {
    const r = A2ATask.fromResponse('agent-x', 'tid', {
      result: { id: 'tid', status: { state: TaskState.SUBMITTED } },
    })
    assert(r.status === 'submitted', 'A2ATask.fromResponse submitted: status')
    assert(r.taskId === 'tid', 'A2ATask.fromResponse submitted: taskId')
  }

  // working → submitted (비동기 진행 중)
  {
    const r = A2ATask.fromResponse('agent-x', 'tid', {
      result: { id: 'tid', status: { state: TaskState.WORKING } },
    })
    assert(r.status === 'submitted', 'A2ATask.fromResponse working: maps to submitted')
  }

  // input-required → submitted
  {
    const r = A2ATask.fromResponse('agent-x', 'tid', {
      result: { id: 'tid', status: { state: TaskState.INPUT_REQUIRED } },
    })
    assert(r.status === 'submitted', 'A2ATask.fromResponse input-required: maps to submitted')
  }

  // failed
  {
    const r = A2ATask.fromResponse('agent-x', 'tid', {
      result: {
        id: 'tid',
        status: {
          state: TaskState.FAILED,
          message: { parts: [{ kind: 'text', text: 'something broke' }] },
        },
      },
    })
    assert(r.status === 'failed', 'A2ATask.fromResponse failed: status')
    assert(r.error === 'something broke', 'A2ATask.fromResponse failed: error')
  }

  // JSON-RPC error
  {
    const r = A2ATask.fromResponse('agent-x', 'tid', {
      error: { code: -32600, message: 'Invalid Request' },
    })
    assert(r.status === 'failed', 'A2ATask.fromResponse rpc error: failed')
    assert(r.error.includes('Invalid Request'), 'A2ATask.fromResponse rpc error: message')
  }

  // invalid response
  {
    const r = A2ATask.fromResponse('agent-x', 'tid', { result: {} })
    assert(r.status === 'failed', 'A2ATask.fromResponse invalid: failed')
  }

  // ===========================================
  // sendTask (HTTP integration)
  // ===========================================

  // 성공: completed 즉시 반환
  {
    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body)
      return {
        ok: true,
        json: async () => ({
          jsonrpc: '2.0', id: body.id,
          result: {
            id: body.params.id,
            status: { state: 'completed' },
            artifacts: [{ parts: [{ kind: 'text', text: '요약 완료' }] }],
          },
        }),
      }
    }
    const client = new A2AClient({ fetchFn: mockFetch })
    const r = await client.sendTask('remote-agent', 'https://a2a.test/rpc', '요약해줘')
    assert(r.status === 'completed', 'sendTask completed: status')
    assert(r.output === '요약 완료', 'sendTask completed: output')
    assert(r.target === 'remote-agent', 'sendTask completed: target')
    assert(r.mode === 'remote', 'sendTask completed: mode')
  }

  // 비동기: submitted 반환
  {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0', id: '1',
        result: { id: 'task-abc', status: { state: 'submitted' } },
      }),
    })
    const r = await new A2AClient({ fetchFn: mockFetch }).sendTask('agent', 'https://a2a.test/rpc', 'task')
    assert(r.status === 'submitted', 'sendTask submitted: status')
    assert(r.taskId === 'task-abc', 'sendTask submitted: taskId from response')
  }

  // HTTP 에러
  {
    const mockFetch = async () => ({
      ok: false, status: 503, text: async () => 'Service Unavailable',
    })
    const r = await new A2AClient({ fetchFn: mockFetch }).sendTask('agent', 'https://a2a.test/rpc', 'task')
    assert(r.status === 'failed', 'sendTask http error: failed')
    assert(r.error.includes('503'), 'sendTask http error: status in error')
  }

  // 네트워크 에러
  {
    const mockFetch = async () => { throw new Error('ECONNREFUSED') }
    const r = await new A2AClient({ fetchFn: mockFetch }).sendTask('agent', 'https://a2a.test/rpc', 'task')
    assert(r.status === 'failed', 'sendTask network error: failed (not thrown)')
    assert(r.error.includes('ECONNREFUSED'), 'sendTask network error: message')
  }

  // JSON-RPC 에러 응답
  {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0', id: '1',
        error: { code: -32601, message: 'Method not found' },
      }),
    })
    const r = await new A2AClient({ fetchFn: mockFetch }).sendTask('agent', 'https://a2a.test/rpc', 'task')
    assert(r.status === 'failed', 'sendTask rpc error: failed')
    assert(r.error.includes('Method not found'), 'sendTask rpc error: message')
  }

  // endpoint에 올바른 JSON-RPC 요청이 전달되는지
  {
    let capturedUrl = null
    let capturedBody = null
    const mockFetch = async (url, opts) => {
      capturedUrl = url
      capturedBody = JSON.parse(opts.body)
      return {
        ok: true,
        json: async () => ({
          jsonrpc: '2.0', id: '1',
          result: { id: 'tid', status: { state: 'completed' }, artifacts: [] },
        }),
      }
    }
    await new A2AClient({ fetchFn: mockFetch }).sendTask('agent', 'https://example.com/a2a', '작업 내용')

    assert(capturedUrl === 'https://example.com/a2a', 'sendTask: correct endpoint')
    assert(capturedBody.jsonrpc === '2.0', 'sendTask: jsonrpc 2.0')
    assert(capturedBody.method === 'message/send', 'sendTask: correct method')
    assert(capturedBody.params.message.parts[0].text === '작업 내용', 'sendTask: task text')
  }

  // ===========================================
  // getTaskStatus
  // ===========================================

  {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0', id: '1',
        result: {
          id: 'tid', status: { state: 'completed' },
          artifacts: [{ parts: [{ kind: 'text', text: 'finally done' }] }],
        },
      }),
    })
    const r = await new A2AClient({ fetchFn: mockFetch }).getTaskStatus('agent', 'https://a2a.test/rpc', 'tid')
    assert(r.status === 'completed', 'getTaskStatus completed: status')
    assert(r.output === 'finally done', 'getTaskStatus completed: output')
  }

  {
    const mockFetch = async () => { throw new Error('timeout') }
    const r = await new A2AClient({ fetchFn: mockFetch }).getTaskStatus('agent', 'https://a2a.test/rpc', 'tid')
    assert(r.status === 'failed', 'getTaskStatus network error: failed')
  }

  // tasks/get 호출 시 올바른 method 전달 확인
  {
    let capturedBody = null
    const mockFetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body)
      return {
        ok: true,
        json: async () => ({
          jsonrpc: '2.0', id: '1',
          result: { id: 'tid-42', status: { state: 'completed' }, artifacts: [] },
        }),
      }
    }
    await new A2AClient({ fetchFn: mockFetch }).getTaskStatus('agent', 'https://a2a.test/rpc', 'tid-42')
    assert(capturedBody.method === 'tasks/get', 'getTaskStatus: uses tasks/get method')
    assert(capturedBody.params.id === 'tid-42', 'getTaskStatus: passes taskId')
  }

  // ===========================================
  // DelegateActor
  // ===========================================

  // poll → pending delegate 폴링 → completed → eventActor.enqueue → drain → 처리
  {
    const state = createOriginState({
      turnState: TurnState.idle(),
      delegates: { pending: [
        { target: 'remote-agent', taskId: 'tid-1', endpoint: 'https://a2a.test/rpc' },
      ]},
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })
    const agentReg = createAgentRegistry()
    agentReg.register({ name: 'remote-agent', type: 'remote', endpoint: 'https://a2a.test/rpc' })

    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0', id: '1',
        result: { id: 'tid-1', status: { state: 'completed' }, artifacts: [{ parts: [{ kind: 'text', text: 'done!' }] }] },
      }),
    })

    const turnActor = turnActorR.run({ runTurn: async () => 'done' })
    const eventActor = eventActorR.run({ turnActor, state, logger: null })
    const delegateActor = delegateActorR.run({
      state, eventActor, agentRegistry: agentReg, fetchFn: mockFetch,
    })

    await forkTask(delegateActor.poll())
    // eventActor.enqueue + drain은 fire-and-forget이므로 처리 완료 대기
    await new Promise(r => setTimeout(r, 200))

    // drain이 이미 처리했으므로 lastProcessed에서 확인
    const lastProcessed = state.get('events.lastProcessed')
    assert(lastProcessed != null, 'DelegateActor poll: event processed')
    assert(lastProcessed.type === 'delegate_result', 'DelegateActor poll: event type')
    assert(lastProcessed.result.status === 'completed', 'DelegateActor poll: result status')
    assert(state.get('delegates.pending').length === 0, 'DelegateActor poll: removed from pending')
  }

  // tick 중복에도 poll 1회만
  {
    const state = createOriginState({
      turnState: TurnState.idle(),
      delegates: { pending: [
        { target: 'slow', taskId: 'tid-2', endpoint: 'https://a2a.test/rpc' },
      ]},
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })
    const agentReg = createAgentRegistry()
    agentReg.register({ name: 'slow', type: 'remote', endpoint: 'https://a2a.test/rpc' })

    let pollCount = 0
    const mockFetch = async () => {
      pollCount++
      const taskState = pollCount <= 1 ? 'working' : 'completed'
      return {
        ok: true,
        json: async () => ({
          jsonrpc: '2.0', id: '1',
          result: {
            id: 'tid-2',
            status: { state: taskState },
            ...(taskState === 'completed' ? { artifacts: [{ parts: [{ kind: 'text', text: 'finally' }] }] } : {}),
          },
        }),
      }
    }

    const turnActor = turnActorR.run({ runTurn: async () => 'done' })
    const eventActor = eventActorR.run({ turnActor, state, logger: null })
    const delegateActor = delegateActorR.run({
      state, eventActor, agentRegistry: agentReg,
      fetchFn: mockFetch, pollIntervalMs: 30,
    })
    await forkTask(delegateActor.start())

    // 첫 tick: working → pending 유지
    await new Promise(r => setTimeout(r, 50))
    assert(state.get('delegates.pending').length === 1, 'periodic poll: still pending after first tick')

    // 두 번째 tick: completed → eventActor.enqueue → drain
    await new Promise(r => setTimeout(r, 200))
    await forkTask(delegateActor.stop())

    // drain이 이미 처리했으므로 lastProcessed 확인
    const lastProcessed = state.get('events.lastProcessed')
    assert(lastProcessed != null && lastProcessed.type === 'delegate_result', 'periodic poll: completed event processed')
    assert(state.get('delegates.pending').length === 0, 'periodic poll: removed from pending')
  }

  summary()
}

run()
