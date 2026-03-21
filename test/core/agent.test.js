import { initI18n } from '../../src/i18n/index.js'
initI18n('ko')
import {
  createAgentTurn, safeRunTurn, createAgent,
  beginTurn, finishSuccess, finishFailure,
  safeJsonParse, validatePlan,
  PHASE, RESULT, ERROR_KIND, Phase, TurnResult, ErrorInfo,
} from '../../src/core/agent.js'
import { createReactTurn } from '../../src/core/react.js'
import { createTestInterpreter } from '../../src/interpreter/test.js'
import { createReactiveState } from '../../src/infra/state.js'
import { Free, Either } from '../../src/core/op.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// --- 초기 상태 헬퍼 ---
const initState = (overrides = {}) =>
  createReactiveState({ turnState: Phase.idle(), lastTurn: null, turn: 0, context: { memories: [] }, ...overrides })

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

async function run() {
  console.log('Agent turn tests')

  // ===========================================
  // 상태 전이 단위 테스트
  // ===========================================

  // T1. beginTurn → turnState = working(input)
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({}, state)

    await Free.runWithTask(interpreter)(beginTurn('new input'))

    const ts = state.get('turnState')
    assert(ts.tag === PHASE.WORKING, 'beginTurn: tag is working')
    assert(ts.input === 'new input', 'beginTurn: input stored')
  }

  // T2. finishSuccess → lastTurn = success, turnState = idle
  {
    const state = initState()
    state.set('turnState', Phase.working('q'))
    const { interpreter } = createTestInterpreter({}, state)

    const result = await Free.runWithTask(interpreter)(finishSuccess('q', 'ok'))

    assert(result === 'ok', 'finishSuccess: returns result')
    const lt = state.get('lastTurn')
    assert(lt.tag === RESULT.SUCCESS, 'finishSuccess: lastTurn tag is success')
    assert(lt.input === 'q', 'finishSuccess: lastTurn.input preserved')
    assert(lt.result === 'ok', 'finishSuccess: lastTurn.result stored')
    assert(state.get('turnState').tag === PHASE.IDLE, 'finishSuccess: turnState idle')
  }

  // T3. finishFailure → lastTurn = failure, turnState = idle
  {
    const state = initState()
    state.set('turnState', Phase.working('q'))
    const { interpreter } = createTestInterpreter({}, state)

    const error = ErrorInfo('bad', ERROR_KIND.PLANNER_PARSE)
    const result = await Free.runWithTask(interpreter)(finishFailure('q', error, 'error resp'))

    assert(result === 'error resp', 'finishFailure: returns response')
    const lt = state.get('lastTurn')
    assert(lt.tag === RESULT.FAILURE, 'finishFailure: lastTurn tag is failure')
    assert(lt.error.message === 'bad', 'finishFailure: error.message stored')
    assert(lt.error.kind === ERROR_KIND.PLANNER_PARSE, 'finishFailure: error.kind stored')
    assert(lt.response === 'error resp', 'finishFailure: response stored')
    assert(state.get('turnState').tag === PHASE.IDLE, 'finishFailure: turnState idle')
  }

  // T4. 실패 후 성공 → lastTurn이 success로 교체됨
  {
    const state = initState()
    let n = 0
    const { interpreter } = createTestInterpreter({
      AskLLM: () => {
        n++
        if (n === 1) return '<<<invalid>>>'
        return JSON.stringify({ type: 'direct_response', message: 'ok' })
      }
    }, state)

    const agent = createAgent({ interpreter, state })

    await agent.run('fail')
    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'turn sequence: failure after bad turn')

    await agent.run('succeed')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'turn sequence: success replaces failure')
  }

  // T5. safeJsonParse — Either로 JSON 파싱
  {
    const r1 = safeJsonParse('{"type":"plan"}')
    assert(Either.isRight(r1), 'safeJsonParse: valid JSON → Right')
    assert(r1.value.type === 'plan', 'safeJsonParse: parsed value')

    const r2 = safeJsonParse('<<<bad>>>')
    assert(Either.isLeft(r2), 'safeJsonParse: invalid JSON → Left')
    assert(r2.value.kind === ERROR_KIND.PLANNER_PARSE, 'safeJsonParse: error kind')

    const obj = { type: 'direct_response', message: 'hi' }
    const r3 = safeJsonParse(obj)
    assert(Either.isRight(r3), 'safeJsonParse: object passthrough → Right')
    assert(r3.value === obj, 'safeJsonParse: same reference')
  }

  // T6. validatePlan — Either로 검증
  {
    const ok1 = validatePlan({ type: 'direct_response', message: 'hi' })
    assert(Either.isRight(ok1), 'validatePlan: valid direct_response → Right')

    const ok2 = validatePlan({ type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'test', tool_args: {} } },
      { op: 'RESPOND', args: { ref: 1 } },
    ] })
    assert(Either.isRight(ok2), 'validatePlan: valid plan → Right')

    const fail1 = validatePlan(null)
    assert(Either.isLeft(fail1), 'validatePlan: null → Left')
    assert(fail1.value.kind === ERROR_KIND.PLANNER_SHAPE, 'validatePlan: error kind')

    const fail2 = validatePlan({ type: 'direct_response', message: 42 })
    assert(Either.isLeft(fail2), 'validatePlan: non-string message → Left')

    const fail3 = validatePlan({ type: 'plan', steps: [] })
    assert(Either.isLeft(fail3), 'validatePlan: empty steps → Left')

    const fail4 = validatePlan({ type: 'unknown' })
    assert(Either.isLeft(fail4), 'validatePlan: unknown type → Left')
  }

  // T7. safeJsonParse.chain(validatePlan) — Either 합성
  {
    const ok = safeJsonParse('{"type":"direct_response","message":"hi"}').chain(validatePlan)
    assert(Either.isRight(ok), 'parse+validate chain: valid → Right')

    const parseFail = safeJsonParse('<<<bad>>>').chain(validatePlan)
    assert(Either.isLeft(parseFail), 'parse+validate chain: parse fail → Left (short-circuit)')
    assert(parseFail.value.kind === ERROR_KIND.PLANNER_PARSE, 'parse+validate chain: parse error kind preserved')

    const validateFail = safeJsonParse('{"type":"unknown"}').chain(validatePlan)
    assert(Either.isLeft(validateFail), 'parse+validate chain: validate fail → Left')
    assert(validateFail.value.kind === ERROR_KIND.PLANNER_SHAPE, 'parse+validate chain: validate error kind')
  }

  // T8. 구조 검증
  {
    const src = readFileSync(join(__dirname, '../../src/core/agent.js'), 'utf-8')

    assert(!src.includes('settleError'), 'structural: settleError removed')
    assert(!src.includes('turnTransitions'), 'structural: turnTransitions removed')
    assert(src.includes('Either.catch'), 'structural: Either.catch used for JSON parse')
    assert(src.includes('Either.fold'), 'structural: Either.fold used for branching')
    // createAgentTurn 내부에 try/catch 없음 (Either로 대체). safeRunTurn은 인터프리터 경계이므로 예외.
    const agentTurnBody = src.split('const createAgentTurn')[1]?.split('const safeRunTurn')[0] || ''
    assert(!/try\s*\{/.test(agentTurnBody), 'structural: no try/catch in createAgentTurn (Either replaces it)')

    // finishSuccess/finishFailure 상호 독립
    const lines = src.split('\n')
    const successStart = lines.findIndex(l => l.startsWith('const finishSuccess'))
    const failureStart = lines.findIndex(l => l.startsWith('const finishFailure'))
    const nextAfterSuccess = lines.findIndex((l, i) => i > successStart && /^const \w/.test(l))
    const nextAfterFailure = lines.findIndex((l, i) => i > failureStart && /^const \w/.test(l))
    const successBody = lines.slice(successStart, nextAfterSuccess).join('\n')
    const failureBody = lines.slice(failureStart, nextAfterFailure).join('\n')

    assert(!successBody.includes('finishFailure'), 'structural: finishSuccess independent')
    assert(!failureBody.includes('finishSuccess'), 'structural: finishFailure independent')
  }

  // T6. invalid plan shape → finishFailure
  {
    const cases = [
      ['tool_calls', { type: 'tool_calls', toolCalls: [] }],
      ['unknown type', { type: 'unknown' }],
      ['plan without steps', { type: 'plan' }],
      ['plan empty steps', { type: 'plan', steps: [] }],
      ['empty object', {}],
      ['관계없는 객체', { foo: 'bar' }],
      ['null', null],
      ['숫자', 42],
      ['배열', [1, 2, 3]],
      ['direct_response without message', { type: 'direct_response' }],
      ['direct_response null message', { type: 'direct_response', message: null }],
      ['direct_response numeric message', { type: 'direct_response', message: 42 }],
    ]

    for (const [label, badPlan] of cases) {
      const state = initState()
      let formatterCalled = false
      let n = 0
      const { interpreter } = createTestInterpreter({
        AskLLM: () => {
          n++
          if (n === 1) return badPlan
          formatterCalled = true
          return 'formatted'
        }
      }, state)

      const agent = createAgent({ interpreter, state })
      await agent.run('test')

      assert(state.get('turnState').tag === PHASE.IDLE, `invalid plan (${label}): turnState idle`)
      assert(state.get('lastTurn').tag === RESULT.FAILURE, `invalid plan (${label}): lastTurn failure`)
      assert(!formatterCalled, `invalid plan (${label}): formatter not called`)
    }
  }

  // T7. safeRunTurn — 같은 생성자, input 캡처
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({
      AskLLM: () => { throw new Error('LLM down') }
    }, state)

    const safe = safeRunTurn(interpreter, state)
    try {
      await safe(createAgentTurn()('x'), 'x')
      assert(false, 'safeRunTurn: should throw')
    } catch (_) {
      assert(state.get('turnState').tag === PHASE.IDLE, 'safeRunTurn: turnState idle')
      const lt = state.get('lastTurn')
      assert(lt.tag === RESULT.FAILURE, 'safeRunTurn: lastTurn failure')
      assert(lt.error.message === 'LLM down', 'safeRunTurn: error.message')
      assert(lt.error.kind === ERROR_KIND.INTERPRETER, 'safeRunTurn: error.kind is interpreter')
      assert(lt.input === 'x', 'safeRunTurn: input captured from caller')
      assert(lt.response === null, 'safeRunTurn: response is null')
    }
  }

  // T8. ErrorInfo kind — planner_parse vs planner_shape
  {
    // parse failure → PLANNER_PARSE
    const state1 = initState()
    const { interpreter: i1 } = createTestInterpreter({
      AskLLM: () => '<<<not json>>>'
    }, state1)
    const agent1 = createAgent({ interpreter: i1, state: state1 })
    await agent1.run('test')
    assert(state1.get('lastTurn').error.kind === ERROR_KIND.PLANNER_PARSE,
      'error kind: parse failure → PLANNER_PARSE')

    // shape failure → PLANNER_SHAPE
    const state2 = initState()
    const { interpreter: i2 } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'unknown' })
    }, state2)
    const agent2 = createAgent({ interpreter: i2, state: state2 })
    await agent2.run('test')
    assert(state2.get('lastTurn').error.kind === ERROR_KIND.PLANNER_SHAPE,
      'error kind: shape failure → PLANNER_SHAPE')
  }

  // ===========================================
  // 통합 테스트
  // ===========================================

  // direct_response
  {
    const state = initState()
    const { interpreter, log } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: '안녕하세요!' })
    }, state)

    const turn = createAgentTurn()
    const result = await Free.runWithTask(interpreter)(turn('안녕'))

    assert(result === '안녕하세요!', 'direct_response: correct message')
    assert(state.get('turnState').tag === PHASE.IDLE, 'direct_response: turnState idle')
    assert(state.get('lastTurn').result === '안녕하세요!', 'direct_response: lastTurn.result saved')
    assert(log.some(l => l.tag === 'Respond'), 'direct_response: Respond op called')
  }

  // plan execution
  {
    const state = initState({ context: { memories: ['past context'] } })
    let n = 0
    const { interpreter, log } = createTestInterpreter({
      AskLLM: () => {
        n++
        if (n === 1) {
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
    assert(state.get('turnState').tag === PHASE.IDLE, 'plan: turnState idle')
    assert(log.filter(l => l.tag === 'AskLLM').length === 2, 'plan: AskLLM called twice')
    assert(log.some(l => l.tag === 'ExecuteTool'), 'plan: ExecuteTool called')
  }

  // turnState 훅: working → idle 전이
  {
    const state = initState()
    const history = []
    state.hooks.on('turnState', (phase) => { history.push(phase.tag) })

    const { interpreter } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'ok' })
    }, state)

    const turn = createAgentTurn()
    await Free.runWithTask(interpreter)(turn('test'))
    await new Promise(r => setTimeout(r, 50))

    assert(history.includes(PHASE.WORKING), 'turnState hook: working fired')
    assert(history[history.length - 1] === PHASE.IDLE, 'turnState hook: ends with idle')
  }

  // turnState idle 훅 발화
  {
    const state = initState()
    let idleFired = false
    state.hooks.on('turnState', (phase) => {
      if (phase.tag === PHASE.IDLE) idleFired = true
    })

    const { interpreter } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'hi' })
    }, state)

    const turn = createAgentTurn()
    await Free.runWithTask(interpreter)(turn('hello'))
    await new Promise(r => setTimeout(r, 50))
    assert(idleFired === true, 'turnState idle hook: fires')
  }

  // responseFormat flows into AskLLM op
  {
    const state = initState()
    let capturedOp = null
    const { interpreter } = createTestInterpreter({
      AskLLM: (op) => {
        if (!capturedOp) capturedOp = op
        return JSON.stringify({ type: 'direct_response', message: 'ok' })
      }
    }, state)

    const turn = createAgentTurn()
    await Free.runWithTask(interpreter)(turn('test'))

    assert(capturedOp.responseFormat !== undefined, 'responseFormat: planner carries it')
    assert(capturedOp.responseFormat.type === 'json_object', 'responseFormat: type is json_object')
  }

  // JSON parse failure → finishFailure path
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({
      AskLLM: () => 'NOT VALID JSON {{{'
    }, state)

    const turn = createAgentTurn()
    const result = await Free.runWithTask(interpreter)(turn('crash me'))

    assert(state.get('turnState').tag === PHASE.IDLE, 'parse failure: turnState idle')
    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'parse failure: lastTurn failure')
    assert(typeof result === 'string' && result.includes('오류'), 'parse failure: error response')
  }

  // AskLLM payload consistent between planner and formatter
  {
    const state = initState()
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

    assert(Array.isArray(capturedOps[0].messages), 'contract: planner has messages')
    assert(Array.isArray(capturedOps[1].messages), 'contract: formatter has messages')
    assert(capturedOps[0].responseFormat !== undefined, 'contract: planner has responseFormat')
    assert(capturedOps[1].responseFormat === undefined, 'contract: formatter has no responseFormat')
  }

  // safeRunTurn with null state → still throws, no crash
  {
    const realState = initState()
    const { interpreter } = createTestInterpreter({
      AskLLM: () => { throw new Error('fail') }
    }, realState)

    const safe = safeRunTurn(interpreter, null)
    try {
      await safe(createAgentTurn()('x'), 'x')
      assert(false, 'safeRunTurn null state: should throw')
    } catch (e) {
      assert(e.message === 'fail', 'safeRunTurn null state: error still thrown')
      assert(true, 'safeRunTurn null state: no crash from null state')
    }
  }

  // Formatter failure → safeRunTurn recovery
  {
    const state = initState()
    let n = 0
    const { interpreter } = createTestInterpreter({
      AskLLM: () => {
        n++
        if (n === 1) {
          return JSON.stringify({
            type: 'plan',
            steps: [{ op: 'EXEC', args: { tool: 'x', tool_args: {} } }]
          })
        }
        throw new Error('formatter exploded')
      }
    }, state)

    const safe = safeRunTurn(interpreter, state)
    try {
      await safe(createAgentTurn()('test'), 'test')
      assert(false, 'formatter failure: should throw')
    } catch (e) {
      assert(state.get('turnState').tag === PHASE.IDLE, 'formatter failure: turnState idle')
      assert(state.get('lastTurn').error.message === 'formatter exploded', 'formatter failure: error stored')
    }
  }

  // direct_response with null message → rejected
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: null })
    }, state)

    const agent = createAgent({ interpreter, state })
    await agent.run('test')

    assert(state.get('turnState').tag === PHASE.IDLE, 'direct_response null: turnState idle')
    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'direct_response null: rejected')
  }

  // Plan step failure mid-chain → safeRunTurn catches
  {
    const state = initState()
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

    const safe = safeRunTurn(interpreter, state)
    try {
      await safe(createAgentTurn()('multi-step'), 'multi-step')
      assert(false, 'mid-step failure: should throw')
    } catch (e) {
      assert(state.get('turnState').tag === PHASE.IDLE, 'mid-step failure: turnState recovered')
      assert(e.message === 'step 2 failed', 'mid-step failure: correct error')
    }
  }

  // Parse error detail in lastTurn
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({
      AskLLM: () => '<<<not json>>>'
    }, state)

    const turn = createAgentTurn()
    await Free.runWithTask(interpreter)(turn('x'))

    const lt = state.get('lastTurn')
    assert(lt.error.message.length > 0, 'parse error detail: error.message is descriptive')
    assert(lt.response.includes('오류'), 'parse error detail: response has error text')
  }

  // Bare runWithTask: turnState stays working (no safeRunTurn)
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({
      AskLLM: () => { throw new Error('crash') }
    }, state)

    const turn = createAgentTurn()
    try {
      await Free.runWithTask(interpreter)(turn('test'))
    } catch (_) {}

    assert(state.get('turnState').tag === PHASE.WORKING,
      'bare runWithTask: turnState stays working')
  }

  // createAgent.run() recovery
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({
      AskLLM: () => { throw new Error('crash') }
    }, state)

    const agent = createAgent({ interpreter, state })
    try {
      await agent.run('test')
    } catch (_) {}

    assert(state.get('turnState').tag === PHASE.IDLE, 'createAgent.run: turnState recovered')
    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'createAgent.run: lastTurn failure')
  }

  // createAgent.run() success
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: '반갑습니다' })
    }, state)

    const agent = createAgent({ interpreter, state })
    const result = await agent.run('안녕')
    assert(result === '반갑습니다', 'createAgent.run success: returns result')
    assert(state.get('turnState').tag === PHASE.IDLE, 'createAgent.run success: turnState idle')
  }

  // createAgent.program() dry-run
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({}, state)

    const agent = createAgent({ interpreter, state })
    const program = agent.program('test')
    assert(Free.isImpure(program), 'createAgent.program: returns Free.Impure')
    assert(state.get('turnState').tag === PHASE.IDLE, 'createAgent.program: state unchanged')
  }

  // Valid plan shapes accepted
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'ok' })
    }, state)
    const agent = createAgent({ interpreter, state })
    const result = await agent.run('hi')
    assert(result === 'ok', 'valid plan (direct_response): accepted')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'valid plan (direct_response): success')
  }

  {
    const state = initState()
    let n = 0
    const { interpreter } = createTestInterpreter({
      AskLLM: () => {
        n++
        if (n === 1) return JSON.stringify({
          type: 'plan',
          steps: [{ op: 'RESPOND', args: { message: 'done' } }]
        })
        return 'formatted'
      }
    }, state)
    const agent = createAgent({ interpreter, state })
    await agent.run('do something')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'valid plan (plan+steps): success')
  }

  // createAgent with buildTurn (전략 주입)
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({
      AskLLM: () => 'ReAct 답변입니다.'
    }, state)

    const agent = createAgent({
      buildTurn: createReactTurn({ tools: [], maxSteps: 5 }),
      interpreter,
      state,
    })
    const result = await agent.run('test')
    assert(result === 'ReAct 답변입니다.', 'createAgent+react: returns result')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'createAgent+react: lastTurn success')
  }

  // createAgent without buildTurn → defaults to Plan-then-Execute
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'plan 답변' })
    }, state)

    const agent = createAgent({ interpreter, state })
    const result = await agent.run('test')
    assert(result === 'plan 답변', 'createAgent default: Plan-then-Execute')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
