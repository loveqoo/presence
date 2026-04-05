import {
  sendA2ATask, getA2ATaskStatus, extractArtifactText,
  buildTaskSendRequest, buildTaskGetRequest, responseToResult,
} from '@presence/infra/infra/agents/a2a-client.js'
import { createAgentRegistry, DelegateResult } from '@presence/infra/infra/agents/agent-registry.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { TurnState } from '@presence/core/core/policies.js'
import { delegateActorR } from '@presence/infra/infra/actors/delegate-actor.js'
import { eventActorR } from '@presence/infra/infra/actors/event-actor.js'
import { turnActorR } from '@presence/infra/infra/actors/turn-actor.js'
import { forkTask } from '@presence/core/lib/task.js'
import { assert, summary } from '../lib/assert.js'

async function run() {
  console.log('A2A client tests')

  // ===========================================
  // extractArtifactText (순수)
  // ===========================================

  {
    const text = extractArtifactText([
      { parts: [{ kind: 'text', text: 'hello' }] },
      { parts: [{ kind: 'text', text: 'world' }, { kind: 'image', data: '...' }] },
    ])
    assert(text === 'hello\nworld', 'extractArtifact: text parts joined')
  }

  {
    assert(extractArtifactText(null) === null, 'extractArtifact: null → null')
    assert(extractArtifactText([]) === null, 'extractArtifact: empty → null')
    assert(extractArtifactText([{ parts: [] }]) === null, 'extractArtifact: no text parts → null')
  }

  // ===========================================
  // buildTaskSendRequest (순수)
  // ===========================================

  {
    const req = buildTaskSendRequest('t1', 'hello')
    assert(req.jsonrpc === '2.0', 'buildRequest: jsonrpc 2.0')
    assert(req.method === 'message/send', 'buildRequest: method')
    assert(req.params.id === 't1', 'buildRequest: task id')
    assert(req.params.message.role === 'user', 'buildRequest: role user')
    assert(req.params.message.parts[0].text === 'hello', 'buildRequest: message text')
  }

  // ===========================================
  // responseToResult (순수)
  // ===========================================

  // completed
  {
    const r = responseToResult('agent-x', 'tid', {
      result: {
        id: 'tid',
        status: { state: 'completed' },
        artifacts: [{ parts: [{ kind: 'text', text: 'done' }] }],
      },
    })
    assert(r.status === 'completed', 'responseToResult completed: status')
    assert(r.output === 'done', 'responseToResult completed: output')
    assert(r.mode === 'remote', 'responseToResult completed: mode')
  }

  // submitted
  {
    const r = responseToResult('agent-x', 'tid', {
      result: { id: 'tid', status: { state: 'submitted' } },
    })
    assert(r.status === 'submitted', 'responseToResult submitted: status')
    assert(r.taskId === 'tid', 'responseToResult submitted: taskId')
  }

  // working
  {
    const r = responseToResult('agent-x', 'tid', {
      result: { id: 'tid', status: { state: 'working' } },
    })
    assert(r.status === 'submitted', 'responseToResult working: maps to submitted')
  }

  // failed
  {
    const r = responseToResult('agent-x', 'tid', {
      result: {
        id: 'tid',
        status: {
          state: 'failed',
          message: { parts: [{ kind: 'text', text: 'something broke' }] },
        },
      },
    })
    assert(r.status === 'failed', 'responseToResult failed: status')
    assert(r.error === 'something broke', 'responseToResult failed: error')
  }

  // JSON-RPC error
  {
    const r = responseToResult('agent-x', 'tid', {
      error: { code: -32600, message: 'Invalid Request' },
    })
    assert(r.status === 'failed', 'responseToResult rpc error: failed')
    assert(r.error.includes('Invalid Request'), 'responseToResult rpc error: message')
  }

  // invalid response
  {
    const r = responseToResult('agent-x', 'tid', { result: {} })
    assert(r.status === 'failed', 'responseToResult invalid: failed')
  }

  // ===========================================
  // sendA2ATask (HTTP integration)
  // ===========================================

  // 성공: completed 즉시 반환
  {
    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body)
      return {
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            id: body.params.id,
            status: { state: 'completed' },
            artifacts: [{ parts: [{ kind: 'text', text: '요약 완료' }] }],
          },
        }),
      }
    }
    const r = await sendA2ATask('remote-agent', 'https://a2a.test/rpc', '요약해줘', { fetchFn: mockFetch })
    assert(r.status === 'completed', 'sendTask completed: status')
    assert(r.output === '요약 완료', 'sendTask completed: output')
    assert(r.target === 'remote-agent', 'sendTask completed: target')
    assert(r.mode === 'remote', 'sendTask completed: mode')
  }

  // 비동기: submitted 반환
  {
    const mockFetch = async (url, opts) => ({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: '1',
        result: { id: 'task-abc', status: { state: 'submitted' } },
      }),
    })
    const r = await sendA2ATask('agent', 'https://a2a.test/rpc', 'task', { fetchFn: mockFetch })
    assert(r.status === 'submitted', 'sendTask submitted: status')
    assert(r.taskId === 'task-abc', 'sendTask submitted: taskId from response')
  }

  // HTTP 에러
  {
    const mockFetch = async () => ({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    })
    const r = await sendA2ATask('agent', 'https://a2a.test/rpc', 'task', { fetchFn: mockFetch })
    assert(r.status === 'failed', 'sendTask http error: failed')
    assert(r.error.includes('503'), 'sendTask http error: status in error')
  }

  // 네트워크 에러
  {
    const mockFetch = async () => { throw new Error('ECONNREFUSED') }
    const r = await sendA2ATask('agent', 'https://a2a.test/rpc', 'task', { fetchFn: mockFetch })
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
    const r = await sendA2ATask('agent', 'https://a2a.test/rpc', 'task', { fetchFn: mockFetch })
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
    await sendA2ATask('agent', 'https://example.com/a2a', '작업 내용', { fetchFn: mockFetch })

    assert(capturedUrl === 'https://example.com/a2a', 'sendTask: correct endpoint')
    assert(capturedBody.jsonrpc === '2.0', 'sendTask: jsonrpc 2.0')
    assert(capturedBody.method === 'message/send', 'sendTask: correct method')
    assert(capturedBody.params.message.parts[0].text === '작업 내용', 'sendTask: task text')
  }

  // ===========================================
  // getA2ATaskStatus
  // ===========================================

  {
    const mockFetch = async (url, opts) => ({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0', id: '1',
        result: {
          id: 'tid',
          status: { state: 'completed' },
          artifacts: [{ parts: [{ kind: 'text', text: 'finally done' }] }],
        },
      }),
    })
    const r = await getA2ATaskStatus('agent', 'https://a2a.test/rpc', 'tid', { fetchFn: mockFetch })
    assert(r.status === 'completed', 'getTaskStatus completed: status')
    assert(r.output === 'finally done', 'getTaskStatus completed: output')
  }

  {
    const mockFetch = async () => { throw new Error('timeout') }
    const r = await getA2ATaskStatus('agent', 'https://a2a.test/rpc', 'tid', { fetchFn: mockFetch })
    assert(r.status === 'failed', 'getTaskStatus network error: failed')
  }

  // buildTaskGetRequest
  {
    const req = buildTaskGetRequest('tid-42')
    assert(req.method === 'tasks/get', 'buildGetRequest: method')
    assert(req.params.id === 'tid-42', 'buildGetRequest: task id')
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
