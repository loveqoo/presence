import { createAgentRegistry } from '@presence/infra/infra/agents/agent-registry.js'
import { Delegation } from '@presence/infra/infra/agents/delegation.js'
import fp from '@presence/core/lib/fun-fp.js'
import { assert, summary } from '../../../test/lib/assert.js'
const { Maybe } = fp

async function run() {
  console.log('Agent registry tests')

  // ===========================================
  // Delegation shape
  // ===========================================

  {
    const c = Delegation.completed('reviewer', 'LGTM')
    assert(c.mode === 'local', 'completed: default mode local')
    assert(c.target === 'reviewer', 'completed: target')
    assert(c.status === 'completed', 'completed: status')
    assert(c.output === 'LGTM', 'completed: output')
    assert(c.isCompleted() && c.isTerminal(), 'completed: isCompleted + isTerminal')
    assert(c.asOutput().isJust() && c.asTaskId().isNothing() && c.asError().isNothing(), 'completed: Maybe fields')
  }

  {
    const s = Delegation.submitted('remote-agent', 'task-123', 'remote')
    assert(s.mode === 'remote', 'submitted: mode remote')
    assert(s.status === 'submitted', 'submitted: status')
    assert(s.taskId === 'task-123', 'submitted: taskId')
    assert(s.isSubmitted() && s.isPending(), 'submitted: isSubmitted + isPending')
    assert(s.asTaskId().isJust() && s.asOutput().isNothing(), 'submitted: Maybe fields')
  }

  {
    const f = Delegation.failed('unknown', 'not found')
    assert(f.status === 'failed', 'failed: status')
    assert(f.error === 'not found', 'failed: error message')
    assert(f.mode === null, 'failed: default mode null')
    assert(f.isFailed() && f.isTerminal(), 'failed: isFailed + isTerminal')
    assert(f.asError().isJust() && f.asOutput().isNothing(), 'failed: Maybe fields')
  }

  // match: exhaustive dispatch
  {
    const c = Delegation.completed('x', 'out')
    const result = c.match({
      completed: r => `done: ${r.output}`,
      submitted: r => `pending: ${r.taskId}`,
      failed: r => `err: ${r.error}`,
    })
    assert(result === 'done: out', 'match: completed branch')
  }

  // match: missing handler throws
  {
    const s = Delegation.submitted('x', 'id-1')
    let threw = false
    try { s.match({ completed: () => 'c', failed: () => 'f' }) } catch { threw = true }
    assert(threw, 'match: missing handler throws')
  }

  // ===========================================
  // AgentRegistry
  // ===========================================

  // register + get (qualified agentId)
  {
    const reg = createAgentRegistry()
    reg.register({
      agentId: 'test/reviewer',
      description: 'Code reviewer',
      capabilities: ['review'],
      type: 'local',
      run: async (task) => `reviewed: ${task}`,
    })

    const maybeEntry = reg.get('test/reviewer')
    assert(maybeEntry.isJust(), 'register+get: Just')
    assert(maybeEntry.value.agentId === 'test/reviewer', 'register+get: agentId')
    assert(maybeEntry.value.name === 'reviewer', 'register+get: name (short) = reviewer')
    assert(maybeEntry.value.description === 'Code reviewer', 'register+get: description')
    assert(maybeEntry.value.type === 'local', 'register+get: type')
    assert(typeof maybeEntry.value.run === 'function', 'register+get: run is function')
  }

  // get unknown → Nothing
  {
    const reg = createAgentRegistry()
    assert(reg.get('test/nonexistent').isNothing(), 'get unknown: Nothing')
  }

  // register without agentId → throw
  {
    const reg = createAgentRegistry()
    let thrown = null
    try { reg.register({ description: 'no agentId' }) } catch (e) { thrown = e }
    assert(thrown && /agentId required/.test(thrown.message), 'register: agentId 누락 throw')
  }

  // register with invalid agentId → throw
  {
    const reg = createAgentRegistry()
    let thrown = null
    try { reg.register({ agentId: 'Invalid/agent', description: 'x' }) } catch (e) { thrown = e }
    assert(thrown && /invalid agentId/.test(thrown.message), 'register: invalid agentId throw')
  }

  // list
  {
    const reg = createAgentRegistry()
    reg.register({ agentId: 'test/a', description: 'Agent A' })
    reg.register({ agentId: 'test/b', description: 'Agent B' })

    const all = reg.list()
    assert(all.length === 2, 'list: 2 agents')
    assert(all.some(a => a.agentId === 'test/a'), 'list: includes test/a')
    assert(all.some(a => a.agentId === 'test/b'), 'list: includes test/b')
    assert(all.every(a => typeof a.name === 'string'), 'list: entries have name')
  }

  // has
  {
    const reg = createAgentRegistry()
    reg.register({ agentId: 'test/x', description: '' })
    assert(reg.has('test/x'), 'has: registered → true')
    assert(!reg.has('test/y'), 'has: not registered → false')
    assert(!reg.has('x'), 'has: short name → false (qualified only)')
  }

  // register remote agent
  {
    const reg = createAgentRegistry()
    reg.register({
      agentId: 'test/remote-helper',
      description: 'Remote agent',
      type: 'remote',
      endpoint: 'https://example.com/a2a',
    })

    const entry = reg.get('test/remote-helper').value
    assert(entry.type === 'remote', 'remote agent: type')
    assert(entry.endpoint === 'https://example.com/a2a', 'remote agent: endpoint')
    assert(entry.run === undefined, 'remote agent: no run function')
  }

  // local agent run
  {
    const reg = createAgentRegistry()
    reg.register({
      agentId: 'test/echo',
      description: 'Echo agent',
      run: async (task) => `echo: ${task}`,
    })

    const result = await reg.get('test/echo').value.run('hello')
    assert(result === 'echo: hello', 'local run: returns result')
  }

  summary()
}

run()
