import { createAgentTurn, safeRunTurn, createAgent } from '../../src/core/agent.js'
import { createTestInterpreter } from '../../src/interpreter/test.js'
import { createReactiveState } from '../../src/infra/state.js'
import { Free } from '../../src/core/op.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

async function run() {
  console.log('Agent turn tests')

  // 1. Simple conversation: LLM returns direct_response
  {
    const state = createReactiveState({ status: 'idle', turn: 0, context: { memories: [] } })
    const { interpreter, log } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: '안녕하세요!' })
    }, state)

    const turn = createAgentTurn()
    const result = await Free.runWithTask(interpreter)(turn('안녕'))

    assert(result === '안녕하세요!', 'direct_response: correct message')
    assert(state.get('status') === 'idle', 'direct_response: status back to idle')
    assert(state.get('lastResult') === '안녕하세요!', 'direct_response: lastResult saved')
    assert(log.some(l => l.tag === 'Respond'), 'direct_response: Respond op called')
  }

  // 2. Plan execution: LLM returns plan with steps
  {
    const state = createReactiveState({ status: 'idle', context: { memories: ['past context'] } })
    let askCallNum = 0
    const { interpreter, log } = createTestInterpreter({
      AskLLM: () => {
        askCallNum++
        if (askCallNum === 1) {
          return JSON.stringify({
            type: 'plan',
            steps: [
              { op: 'EXEC', args: { tool: 'github', tool_args: { repo: 'test' } } },
              { op: 'RESPOND', args: { ref: 1 } },
            ]
          })
        }
        return 'PR 3건이 있습니다.'
      },
      ExecuteTool: (op) => `${op.name}: 3 PRs found`
    }, state)

    const turn = createAgentTurn({ tools: [{ name: 'github', description: 'GH' }] })
    const result = await Free.runWithTask(interpreter)(turn('PR 현황'))

    assert(result === 'PR 3건이 있습니다.', 'plan: formatted response')
    assert(state.get('status') === 'idle', 'plan: status back to idle')
    assert(log.filter(l => l.tag === 'AskLLM').length === 2, 'plan: AskLLM called twice (planner + formatter)')
    assert(log.some(l => l.tag === 'ExecuteTool'), 'plan: ExecuteTool called')
  }

  // 3. State transitions: working → idle
  {
    const state = createReactiveState({ status: 'idle', context: {} })
    const statusHistory = []
    state.hooks.on('status', (val) => { statusHistory.push(val) })

    const { interpreter } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'ok' })
    }, state)

    const turn = createAgentTurn()
    await Free.runWithTask(interpreter)(turn('test'))
    await new Promise(r => setTimeout(r, 50))

    assert(statusHistory.includes('working'), 'state transition: working was set')
    assert(statusHistory[statusHistory.length - 1] === 'idle', 'state transition: ends with idle')
  }

  // 4. Memory hook: status=idle triggers hook
  {
    const state = createReactiveState({ status: 'idle', context: { memories: [] } })
    let idleHookFired = false
    state.hooks.on('status', (val) => {
      if (val === 'idle') idleHookFired = true
    })

    const { interpreter } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'hi' })
    }, state)

    const turn = createAgentTurn()
    await Free.runWithTask(interpreter)(turn('hello'))
    await new Promise(r => setTimeout(r, 50))
    assert(idleHookFired === true, 'memory hook: status=idle fires hook')
  }

  // 5. Fix 1: responseFormat flows into AskLLM op
  {
    const state = createReactiveState({ status: 'idle', context: { memories: [] } })
    let capturedOp = null
    const { interpreter } = createTestInterpreter({
      AskLLM: (op) => {
        if (!capturedOp) capturedOp = op
        return JSON.stringify({ type: 'direct_response', message: 'ok' })
      }
    }, state)

    const turn = createAgentTurn()
    await Free.runWithTask(interpreter)(turn('test'))

    assert(capturedOp.responseFormat !== undefined, 'responseFormat: planner AskLLM carries responseFormat')
    assert(capturedOp.responseFormat.type === 'json_schema', 'responseFormat: type is json_schema')
    assert(capturedOp.responseFormat.json_schema.name === 'agent_plan', 'responseFormat: schema name is agent_plan')
  }

  // 6. Fix 2: JSON parse failure → status recovers to idle
  {
    const state = createReactiveState({ status: 'idle', context: { memories: [] } })
    const { interpreter, log } = createTestInterpreter({
      AskLLM: () => 'NOT VALID JSON {{{' // planner returns garbage
    }, state)

    const turn = createAgentTurn()
    const result = await Free.runWithTask(interpreter)(turn('crash me'))

    assert(state.get('status') === 'idle', 'parse failure: status recovered to idle')
    assert(state.get('lastError') !== undefined, 'parse failure: lastError set')
    assert(typeof result === 'string' && result.includes('오류'), 'parse failure: error response returned')
  }

  // 7. Fix 2: safeRunTurn catches interpreter-level errors
  {
    const state = createReactiveState({ status: 'idle', context: { memories: [] } })
    const { interpreter } = createTestInterpreter({
      AskLLM: () => { throw new Error('LLM connection failed') }
    }, state)

    const turn = createAgentTurn()
    const safe = safeRunTurn(interpreter, state)

    try {
      await safe(turn('blow up'))
      assert(false, 'safeRunTurn: should have thrown')
    } catch (e) {
      assert(state.get('status') === 'idle', 'safeRunTurn: status recovered to idle')
      assert(state.get('lastError') === 'LLM connection failed', 'safeRunTurn: lastError set')
    }
  }

  // 8. Fix 4: AskLLM payload consistent between planner and formatter
  {
    const state = createReactiveState({ status: 'idle', context: { memories: [] } })
    const capturedOps = []
    const { interpreter } = createTestInterpreter({
      AskLLM: (op) => {
        capturedOps.push(op)
        if (capturedOps.length === 1) {
          return JSON.stringify({
            type: 'plan',
            steps: [{ op: 'EXEC', args: { tool: 'test', tool_args: {} } }]
          })
        }
        return 'formatted result'
      }
    }, state)

    const turn = createAgentTurn()
    await Free.runWithTask(interpreter)(turn('test'))

    // Both calls should have messages array
    assert(Array.isArray(capturedOps[0].messages), 'contract: planner AskLLM has messages array')
    assert(Array.isArray(capturedOps[1].messages), 'contract: formatter AskLLM has messages array')
    // Planner has responseFormat, formatter does not
    assert(capturedOps[0].responseFormat !== undefined, 'contract: planner has responseFormat')
    assert(capturedOps[1].responseFormat === undefined, 'contract: formatter has no responseFormat')
  }

  // 9. safeRunTurn with null state → still throws, no crash from null.set()
  {
    const realState = createReactiveState({ status: 'idle', context: { memories: [] } })
    const { interpreter } = createTestInterpreter({
      AskLLM: () => { throw new Error('fail') }
    }, realState)
    const turn = createAgentTurn()
    // Pass null as state to safeRunTurn — should not crash on state.set()
    const safe = safeRunTurn(interpreter, null)
    try {
      await safe(turn('x'))
      assert(false, 'safeRunTurn null state: should throw')
    } catch (e) {
      assert(e.message === 'fail', 'safeRunTurn null state: error still thrown')
      assert(true, 'safeRunTurn null state: no crash from null state')
    }
  }

  // 10. Formatter failure → safeRunTurn recovers state
  {
    const state = createReactiveState({ status: 'idle', context: { memories: [] } })
    let callNum = 0
    const { interpreter } = createTestInterpreter({
      AskLLM: () => {
        callNum++
        if (callNum === 1) {
          return JSON.stringify({
            type: 'plan',
            steps: [{ op: 'EXEC', args: { tool: 'x', tool_args: {} } }]
          })
        }
        // Formatter call: throw
        throw new Error('formatter exploded')
      }
    }, state)

    const turn = createAgentTurn()
    const safe = safeRunTurn(interpreter, state)
    try {
      await safe(turn('test'))
      assert(false, 'formatter failure: should throw')
    } catch (e) {
      assert(state.get('status') === 'idle', 'formatter failure: status recovered to idle')
      assert(state.get('lastError') === 'formatter exploded', 'formatter failure: lastError set')
    }
  }

  // 11. direct_response with null message → doesn't crash
  {
    const state = createReactiveState({ status: 'idle', context: { memories: [] } })
    const { interpreter } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: null })
    }, state)

    const turn = createAgentTurn()
    const result = await Free.runWithTask(interpreter)(turn('test'))
    assert(result === null, 'direct_response null message: returns null')
    assert(state.get('status') === 'idle', 'direct_response null message: status idle')
  }

  // 12. Plan step execution failure mid-chain → safeRunTurn catches
  {
    const state = createReactiveState({ status: 'idle', context: { memories: [] } })
    const { interpreter } = createTestInterpreter({
      AskLLM: () => JSON.stringify({
        type: 'plan',
        steps: [
          { op: 'EXEC', args: { tool: 'ok', tool_args: {} } },
          { op: 'EXEC', args: { tool: 'fail', tool_args: {} } },
        ]
      }),
      ExecuteTool: (op) => {
        if (op.name === 'fail') throw new Error('step 2 failed')
        return 'ok'
      }
    }, state)

    const turn = createAgentTurn()
    const safe = safeRunTurn(interpreter, state)
    try {
      await safe(turn('multi-step'))
      assert(false, 'mid-step failure: should throw')
    } catch (e) {
      assert(state.get('status') === 'idle', 'mid-step failure: status recovered')
      assert(e.message === 'step 2 failed', 'mid-step failure: correct error')
    }
  }

  // 13. Parse failure → error message contains actual parse error detail
  {
    const state = createReactiveState({ status: 'idle', context: { memories: [] } })
    const { interpreter } = createTestInterpreter({
      AskLLM: () => '<<<not json>>>'
    }, state)

    const turn = createAgentTurn()
    const result = await Free.runWithTask(interpreter)(turn('x'))
    const lastError = state.get('lastError')
    assert(typeof lastError === 'string' && lastError.length > 0, 'parse error detail: lastError is descriptive')
    assert(state.get('lastResult').includes('오류'), 'parse error detail: lastResult has error response')
  }

  // --- 지적 1: safeRunTurn이 실제 조립 경로에 연결되지 않았다 ---

  // 14. Free.runWithTask 직접 사용 시 → 예외 발생하면 status가 working에 잠김
  {
    const state = createReactiveState({ status: 'idle', context: { memories: [] } })
    const { interpreter } = createTestInterpreter({
      AskLLM: () => { throw new Error('crash') }
    }, state)

    const turn = createAgentTurn()
    try {
      await Free.runWithTask(interpreter)(turn('test'))
    } catch (_) {}

    // safeRunTurn을 거치지 않았으므로 status가 working에 잠겨 있다
    assert(state.get('status') === 'working',
      'bare runWithTask: status stays working (no recovery)')
  }

  // 15. createAgent.run() 사용 시 → 같은 예외에서 status가 idle로 복구됨
  {
    const state = createReactiveState({ status: 'idle', context: { memories: [] } })
    const { interpreter } = createTestInterpreter({
      AskLLM: () => { throw new Error('crash') }
    }, state)

    const agent = createAgent({ interpreter, state })
    try {
      await agent.run('test')
    } catch (_) {}

    assert(state.get('status') === 'idle',
      'createAgent.run: status recovered to idle')
    assert(state.get('lastError') === 'crash',
      'createAgent.run: lastError set')
  }

  // 16. createAgent.run() 정상 동작: 결과 반환 + idle
  {
    const state = createReactiveState({ status: 'idle', context: { memories: [] } })
    const { interpreter } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: '반갑습니다' })
    }, state)

    const agent = createAgent({ interpreter, state })
    const result = await agent.run('안녕')
    assert(result === '반갑습니다', 'createAgent.run success: returns result')
    assert(state.get('status') === 'idle', 'createAgent.run success: status idle')
  }

  // 17. createAgent.program()은 Free만 반환, 실행하지 않음 (dry-run)
  {
    const state = createReactiveState({ status: 'idle', context: { memories: [] } })
    const { interpreter } = createTestInterpreter({}, state)

    const agent = createAgent({ interpreter, state })
    const program = agent.program('test')
    assert(Free.isImpure(program), 'createAgent.program: returns Free.Impure')
    assert(state.get('status') === 'idle', 'createAgent.program: state unchanged (not executed)')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
