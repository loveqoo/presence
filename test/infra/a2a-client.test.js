import {
  sendA2ATask, getA2ATaskStatus, extractArtifactText,
  buildTaskSendRequest, buildTaskGetRequest, responseToResult,
  wireDelegatePolling,
} from '../../src/infra/a2a-client.js'
import { createAgentRegistry, DelegateResult } from '../../src/infra/agent-registry.js'
import { createReactiveState } from '../../src/infra/state.js'
import { Phase } from '../../src/core/agent.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

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
  // wireDelegatePolling
  // ===========================================

  // idle hook → pending delegate 즉시 폴링 → completed → emit
  {
    const state = createReactiveState({
      turnState: Phase.idle(),
      delegates: { pending: [
        { target: 'remote-agent', taskId: 'tid-1', endpoint: 'https://a2a.test/rpc' },
      ]},
    })
    const agentReg = createAgentRegistry()
    agentReg.register({ name: 'remote-agent', type: 'remote', endpoint: 'https://a2a.test/rpc' })

    const emitted = []
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0', id: '1',
        result: { id: 'tid-1', status: { state: 'completed' }, artifacts: [{ parts: [{ kind: 'text', text: 'done!' }] }] },
      }),
    })

    const poller = wireDelegatePolling({ state, emit: (e) => emitted.push(e), agentRegistry: agentReg, fetchFn: mockFetch })
    state.set('turnState', Phase.idle())
    await new Promise(r => setTimeout(r, 50))
    poller.stop()

    assert(emitted.length === 1, 'polling completed: event emitted')
    assert(emitted[0].type === 'delegate_result', 'polling completed: event type')
    assert(emitted[0].result.status === 'completed', 'polling completed: result status')
    assert(state.get('delegates.pending').length === 0, 'polling completed: removed from pending')
  }

  // still working → pending 유지, 타이머 재시도 후 completed → emit
  {
    const state = createReactiveState({
      turnState: Phase.idle(),
      delegates: { pending: [
        { target: 'slow', taskId: 'tid-2', endpoint: 'https://a2a.test/rpc' },
      ]},
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

    const emitted = []
    const poller = wireDelegatePolling({
      state, emit: (e) => emitted.push(e), agentRegistry: agentReg,
      fetchFn: mockFetch, pollIntervalMs: 30,
    })
    poller.start()

    // 첫 tick: working → pending 유지
    await new Promise(r => setTimeout(r, 50))
    assert(emitted.length === 0, 'periodic poll: first tick still working')
    assert(state.get('delegates.pending').length === 1, 'periodic poll: still pending')

    // 두 번째 tick: completed → emit
    await new Promise(r => setTimeout(r, 80))
    poller.stop()

    assert(emitted.length === 1, 'periodic poll: completed on second tick')
    assert(emitted[0].result.output === 'finally', 'periodic poll: correct output')
    assert(state.get('delegates.pending').length === 0, 'periodic poll: removed from pending')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
