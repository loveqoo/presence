import { createAgentRegistry, DelegateResult } from '../../src/infra/agent-registry.js'
import fp from '../../src/lib/fun-fp.js'
import { assert, summary } from '../lib/assert.js'
const { Maybe } = fp

async function run() {
  console.log('Agent registry tests')

  // ===========================================
  // DelegateResult shape
  // ===========================================

  {
    const c = DelegateResult.completed('reviewer', 'LGTM')
    assert(c.mode === 'local', 'completed: default mode local')
    assert(c.target === 'reviewer', 'completed: target')
    assert(c.status === 'completed', 'completed: status')
    assert(c.output === 'LGTM', 'completed: output')
    assert(c.artifact === null, 'completed: artifact null')
  }

  {
    const s = DelegateResult.submitted('remote-agent', 'task-123', 'remote')
    assert(s.mode === 'remote', 'submitted: mode remote')
    assert(s.status === 'submitted', 'submitted: status')
    assert(s.taskId === 'task-123', 'submitted: taskId')
    assert(s.output === null, 'submitted: output null')
  }

  {
    const f = DelegateResult.failed('unknown', 'not found')
    assert(f.status === 'failed', 'failed: status')
    assert(f.error === 'not found', 'failed: error message')
    assert(f.mode === null, 'failed: default mode null')
  }

  // ===========================================
  // AgentRegistry
  // ===========================================

  // register + get
  {
    const reg = createAgentRegistry()
    reg.register({
      name: 'reviewer',
      description: 'Code reviewer',
      capabilities: ['review'],
      type: 'local',
      run: async (task) => `reviewed: ${task}`,
    })

    const maybeEntry = reg.get('reviewer')
    assert(maybeEntry.isJust(), 'register+get: Just')
    assert(maybeEntry.value.name === 'reviewer', 'register+get: name')
    assert(maybeEntry.value.description === 'Code reviewer', 'register+get: description')
    assert(maybeEntry.value.type === 'local', 'register+get: type')
    assert(typeof maybeEntry.value.run === 'function', 'register+get: run is function')
  }

  // get unknown → null
  {
    const reg = createAgentRegistry()
    assert(reg.get('nonexistent').isNothing(), 'get unknown: Nothing')
  }

  // list
  {
    const reg = createAgentRegistry()
    reg.register({ name: 'a', description: 'Agent A' })
    reg.register({ name: 'b', description: 'Agent B' })

    const all = reg.list()
    assert(all.length === 2, 'list: 2 agents')
    assert(all.some(a => a.name === 'a'), 'list: includes a')
    assert(all.some(a => a.name === 'b'), 'list: includes b')
  }

  // has
  {
    const reg = createAgentRegistry()
    reg.register({ name: 'x', description: '' })
    assert(reg.has('x'), 'has: registered → true')
    assert(!reg.has('y'), 'has: not registered → false')
  }

  // register remote agent
  {
    const reg = createAgentRegistry()
    reg.register({
      name: 'remote-helper',
      description: 'Remote agent',
      type: 'remote',
      endpoint: 'https://example.com/a2a',
    })

    const entry = reg.get('remote-helper').value
    assert(entry.type === 'remote', 'remote agent: type')
    assert(entry.endpoint === 'https://example.com/a2a', 'remote agent: endpoint')
    assert(entry.run === undefined, 'remote agent: no run function')
  }

  // local agent run
  {
    const reg = createAgentRegistry()
    reg.register({
      name: 'echo',
      description: 'Echo agent',
      run: async (task) => `echo: ${task}`,
    })

    const result = await reg.get('echo').value.run('hello')
    assert(result === 'echo: hello', 'local run: returns result')
  }

  summary()
}

run()
