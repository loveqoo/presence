import { Repl, COMMANDS } from '@presence/core/core/repl.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { createToolRegistry } from '@presence/infra/infra/tools/tool-registry.js'
import { createAgentRegistry } from '@presence/infra/infra/agent-registry.js'
import { TurnState } from '@presence/core/core/policies.js'

import { assert, summary } from '../../../../test/lib/assert.js'

const mockAgent = (response) => ({
  run: async () => response,
})

const mockState = () => createOriginState({
  turnState: TurnState.idle(),
  lastTurn: null,
  turn: 3,
  events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
  delegates: { pending: [] },
  todos: [],
  context: { memories: [] },
})

async function run() {
  console.log('REPL tests')

  // 1. Normal input → agent.run called
  {
    const outputs = []
    const repl = new Repl({
      agent: mockAgent('hello'),
      onOutput: (r) => outputs.push(r),
      state: mockState(),
    })
    const result = await repl.handleInput('hi')
    assert(result === 'hello', 'normal input: returns agent result')
    assert(outputs[0] === 'hello', 'normal input: onOutput called')
    assert(repl.turnCount === 1, 'normal input: turnCount incremented')
  }

  // 2. /quit
  {
    const repl = new Repl({ agent: mockAgent('x'), state: mockState() })
    assert(repl.running === true, 'before quit: running')
    await repl.handleInput('/quit')
    assert(repl.running === false, '/quit: stopped')
    assert(repl.turnCount === 0, '/quit: no turn counted')
  }

  // 3. /exit
  {
    const repl = new Repl({ agent: mockAgent('x'), state: mockState() })
    await repl.handleInput('/exit')
    assert(repl.running === false, '/exit: stopped')
  }

  // 4. Agent error
  {
    const errors = []
    const repl = new Repl({
      agent: { run: async () => { throw new Error('agent died') } },
      onError: (e) => errors.push(e),
      state: mockState(),
    })
    const result = await repl.handleInput('crash')
    assert(result === null, 'agent error: returns null')
    assert(errors[0].message === 'agent died', 'agent error: onError called')
    assert(repl.turnCount === 1, 'agent error: turn still counted')
  }

  // 5. Multiple turns
  {
    const repl = new Repl({ agent: mockAgent('ok'), state: mockState() })
    await repl.handleInput('a')
    await repl.handleInput('b')
    await repl.handleInput('c')
    assert(repl.turnCount === 3, 'multiple turns: turnCount = 3')
  }

  // 6. stop()
  {
    const repl = new Repl({ agent: mockAgent('x'), state: mockState() })
    repl.stop()
    assert(repl.running === false, 'stop(): running = false')
  }

  // 7. /status → onOutput, no agent.run
  {
    let agentCalled = false
    const outputs = []
    const repl = new Repl({
      agent: { run: async () => { agentCalled = true; return 'x' } },
      onOutput: (r) => outputs.push(r),
      state: mockState(),
    })
    await repl.handleInput('/status')
    assert(agentCalled === false, '/status: agent.run not called')
    assert(outputs[0].includes('turnState'), '/status: shows turnState')
    assert(outputs[0].includes('turn:'), '/status: shows turn count')
  }

  // 8. /help → lists commands
  {
    const outputs = []
    const repl = new Repl({
      agent: mockAgent('x'),
      onOutput: (r) => outputs.push(r),
      state: mockState(),
    })
    await repl.handleInput('/help')
    assert(outputs[0].includes('/status'), '/help: lists /status')
    assert(outputs[0].includes('/tools'), '/help: lists /tools')
    assert(outputs[0].includes('/quit'), '/help: lists /quit')
  }

  // 9. /tools
  {
    const outputs = []
    const toolReg = createToolRegistry()
    toolReg.register({ name: 'file_read', description: 'Read files', parameters: {}, handler: () => {} })
    const repl = new Repl({
      agent: mockAgent('x'),
      onOutput: (r) => outputs.push(r),
      state: mockState(),
      toolRegistry: toolReg,
    })
    await repl.handleInput('/tools')
    assert(outputs[0].includes('file_read'), '/tools: shows tool name')
    assert(outputs[0].includes('Read files'), '/tools: shows description')
  }

  // 10. /agents
  {
    const outputs = []
    const agentReg = createAgentRegistry()
    agentReg.register({ name: 'summarizer', description: 'Summarize text', type: 'local' })
    const repl = new Repl({
      agent: mockAgent('x'),
      onOutput: (r) => outputs.push(r),
      state: mockState(),
      agentRegistry: agentReg,
    })
    await repl.handleInput('/agents')
    assert(outputs[0].includes('summarizer'), '/agents: shows agent name')
    assert(outputs[0].includes('local'), '/agents: shows type')
  }

  // 11. /todos
  {
    const outputs = []
    const state = mockState()
    state.set('todos', [{ type: 'review', title: 'PR #42', done: false }])
    const repl = new Repl({
      agent: mockAgent('x'),
      onOutput: (r) => outputs.push(r),
      state,
    })
    await repl.handleInput('/todos')
    assert(outputs[0].includes('PR #42'), '/todos: shows title')
    assert(outputs[0].includes('○'), '/todos: shows not done marker')
  }

  // 12. /events
  {
    const outputs = []
    const state = mockState()
    state.set('events.deadLetter', [{ type: 'bad', error: 'crashed' }])
    const repl = new Repl({
      agent: mockAgent('x'),
      onOutput: (r) => outputs.push(r),
      state,
    })
    await repl.handleInput('/events')
    assert(outputs[0].includes('dead letters: 1'), '/events: shows dead letter count')
    assert(outputs[0].includes('crashed'), '/events: shows error')
  }

  // 13. COMMANDS export
  {
    assert(typeof COMMANDS === 'object', 'COMMANDS: exported')
    assert(Object.keys(COMMANDS).length >= 8, 'COMMANDS: at least 8 commands')
  }

  summary()
}

run()
