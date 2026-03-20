import { createRepl } from '../../src/core/repl.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

async function run() {
  console.log('REPL tests')

  // Mock agent
  const mockAgent = (response) => ({
    run: async (input) => response,
    program: (input) => null,
  })

  // 1. Normal input → agent.run called, result returned
  {
    const outputs = []
    const repl = createRepl({
      agent: mockAgent('hello'),
      onOutput: (r) => outputs.push(r),
    })
    const result = await repl.handleInput('hi')
    assert(result === 'hello', 'normal input: returns agent result')
    assert(outputs[0] === 'hello', 'normal input: onOutput called')
    assert(repl.turnCount === 1, 'normal input: turnCount incremented')
  }

  // 2. /quit → stops repl
  {
    const repl = createRepl({ agent: mockAgent('x') })
    assert(repl.running === true, 'before quit: running')
    await repl.handleInput('/quit')
    assert(repl.running === false, '/quit: stopped')
    assert(repl.turnCount === 0, '/quit: no turn counted')
  }

  // 3. /exit → same as /quit
  {
    const repl = createRepl({ agent: mockAgent('x') })
    await repl.handleInput('/exit')
    assert(repl.running === false, '/exit: stopped')
  }

  // 4. Agent error → onError called, returns null
  {
    const errors = []
    const repl = createRepl({
      agent: { run: async () => { throw new Error('agent died') } },
      onError: (e) => errors.push(e),
    })
    const result = await repl.handleInput('crash')
    assert(result === null, 'agent error: returns null')
    assert(errors[0].message === 'agent died', 'agent error: onError called')
    assert(repl.turnCount === 1, 'agent error: turn still counted')
  }

  // 5. Multiple turns → turnCount accumulates
  {
    const repl = createRepl({ agent: mockAgent('ok') })
    await repl.handleInput('a')
    await repl.handleInput('b')
    await repl.handleInput('c')
    assert(repl.turnCount === 3, 'multiple turns: turnCount = 3')
  }

  // 6. stop() method
  {
    const repl = createRepl({ agent: mockAgent('x') })
    repl.stop()
    assert(repl.running === false, 'stop(): running = false')
  }

  // 7. /status → returns status object, no agent.run
  {
    let agentCalled = false
    const repl = createRepl({
      agent: { run: async () => { agentCalled = true; return 'x' } },
    })
    const result = await repl.handleInput('/status')
    assert(agentCalled === false, '/status: agent.run not called')
    assert(result?.type === 'status', '/status: returns status object')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
