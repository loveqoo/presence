import { initI18n } from '../../src/i18n/index.js'
initI18n('ko')
import {
  createAgentTurn, safeRunTurn, createAgent, applyFinalState,
  beginTurn, finishSuccess, finishFailure,
  safeJsonParse, extractJson, validatePlan,
  PHASE, RESULT, ERROR_KIND, Phase, TurnResult, ErrorInfo, MANAGED_PATHS,
} from '../../src/core/agent.js'
import { createTestInterpreter } from '../../src/interpreter/test.js'
import { createReactiveState, getByPath } from '../../src/infra/state.js'
import { Free, Either, runFreeWithStateT } from '../../src/core/op.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// --- 초기 상태 헬퍼 ---
// reactive state (createAgent/safeRunTurn 경유 테스트용)
const initState = (overrides = {}) =>
  createReactiveState({ turnState: Phase.idle(), lastTurn: null, turn: 0, context: { memories: [] }, ...overrides })

// plain object (runFreeWithStateT 직접 실행 테스트용)
const initSnapshot = (overrides = {}) =>
  ({ turnState: Phase.idle(), lastTurn: null, turn: 0, context: { memories: [] }, ...overrides })

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

  // T1. beginTurn is no-op (lifecycle owned by safeRunTurn)
  {
    const { interpret, ST } = createTestInterpreter({})
    const [, finalState] = await runFreeWithStateT(interpret, ST)(beginTurn('new input'))(initSnapshot())

    assert(finalState.turnState.tag === PHASE.IDLE, 'beginTurn: no-op, turnState stays idle')
  }

  // T1b. safeRunTurn sets turnState=working before Free execution
  {
    const state = initState()
    let turnStateAtFreeStart = null
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        turnStateAtFreeStart = state.get('turnState')
        return JSON.stringify({ type: 'direct_response', message: 'ok' })
      }
    })

    const agent = createAgent({ interpret, ST, state })
    await agent.run('new input')

    assert(turnStateAtFreeStart.tag === PHASE.WORKING, 'safeRunTurn: turnState working before Free')
    assert(turnStateAtFreeStart.input === 'new input', 'safeRunTurn: input stored in working state')
  }

  // T2. finishSuccess → lastTurn = success, turnState = idle
  {
    const initial = initSnapshot({ turnState: Phase.working('q') })
    const { interpret, ST } = createTestInterpreter({})

    const [result, finalState] = await runFreeWithStateT(interpret, ST)(finishSuccess('q', 'ok'))(initial)

    assert(result === 'ok', 'finishSuccess: returns result')
    const lt = finalState.lastTurn
    assert(lt.tag === RESULT.SUCCESS, 'finishSuccess: lastTurn tag is success')
    assert(lt.input === 'q', 'finishSuccess: lastTurn.input preserved')
    assert(lt.result === 'ok', 'finishSuccess: lastTurn.result stored')
    assert(finalState.turnState.tag === PHASE.IDLE, 'finishSuccess: turnState idle')
  }

  // T3. finishFailure → lastTurn = failure, turnState = idle
  {
    const initial = initSnapshot({ turnState: Phase.working('q') })
    const { interpret, ST } = createTestInterpreter({})

    const error = ErrorInfo('bad', ERROR_KIND.PLANNER_PARSE)
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(finishFailure('q', error, 'error resp'))(initial)

    assert(result === 'error resp', 'finishFailure: returns response')
    const lt = finalState.lastTurn
    assert(lt.tag === RESULT.FAILURE, 'finishFailure: lastTurn tag is failure')
    assert(lt.error.message === 'bad', 'finishFailure: error.message stored')
    assert(lt.error.kind === ERROR_KIND.PLANNER_PARSE, 'finishFailure: error.kind stored')
    assert(lt.response === 'error resp', 'finishFailure: response stored')
    assert(finalState.turnState.tag === PHASE.IDLE, 'finishFailure: turnState idle')
  }

  // T4. 실패 후 성공 → lastTurn이 success로 교체됨
  {
    const state = initState()
    let n = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        n++
        if (n === 1) return '<<<invalid>>>'
        return JSON.stringify({ type: 'direct_response', message: 'ok' })
      }
    })

    const agent = createAgent({ interpret, ST, state })

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

  // T5b. extractJson — <think> 태그 및 비-JSON 접두사 제거
  {
    assert(extractJson('{"type":"plan"}') === '{"type":"plan"}', 'extractJson: clean JSON unchanged')
    assert(extractJson('<think>reasoning</think>\n{"type":"plan"}') === '{"type":"plan"}', 'extractJson: strips <think> prefix')
    assert(extractJson('some text\n\n{"type":"plan"}') === '{"type":"plan"}', 'extractJson: strips arbitrary prefix')
    assert(extractJson('no json here') === 'no json here', 'extractJson: no { returns as-is')
    assert(extractJson({ a: 1 }) !== undefined, 'extractJson: non-string passthrough')

    // safeJsonParse with <think> prefix
    const r4 = safeJsonParse('<think>\n사용자 인사\n</think>\n{"type":"direct_response","message":"안녕"}')
    assert(Either.isRight(r4), 'safeJsonParse: <think> prefix → Right')
    assert(r4.value.type === 'direct_response', 'safeJsonParse: <think> parsed type')
    assert(r4.value.message === '안녕', 'safeJsonParse: <think> parsed message')
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

    // StateT 구조 검증
    assert(src.includes('runFreeWithStateT'), 'structural: safeRunTurn uses runFreeWithStateT')
    assert(src.includes('applyFinalState'), 'structural: applyFinalState exists')
    assert(!src.includes('Free.runWithTask'), 'structural: Free.runWithTask removed from agent.js')
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
      const { interpret, ST } = createTestInterpreter({
        AskLLM: () => {
          n++
          if (n === 1) return badPlan
          formatterCalled = true
          return 'formatted'
        }
      })

      const agent = createAgent({ interpret, ST, state })
      await agent.run('test')

      assert(state.get('turnState').tag === PHASE.IDLE, `invalid plan (${label}): turnState idle`)
      assert(state.get('lastTurn').tag === RESULT.FAILURE, `invalid plan (${label}): lastTurn failure`)
      assert(!formatterCalled, `invalid plan (${label}): formatter not called`)
    }
  }

  // T7. safeRunTurn — 같은 생성자, input 캡처
  {
    const state = initState()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => { throw new Error('LLM down') }
    })

    const safe = safeRunTurn({ interpret, ST }, state)
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
    const { interpret: i1, ST: ST1 } = createTestInterpreter({
      AskLLM: () => '<<<not json>>>'
    })
    const agent1 = createAgent({ interpret: i1, ST: ST1, state: state1 })
    await agent1.run('test')
    assert(state1.get('lastTurn').error.kind === ERROR_KIND.PLANNER_PARSE,
      'error kind: parse failure → PLANNER_PARSE')

    // shape failure → PLANNER_SHAPE
    const state2 = initState()
    const { interpret: i2, ST: ST2 } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'unknown' })
    })
    const agent2 = createAgent({ interpret: i2, ST: ST2, state: state2 })
    await agent2.run('test')
    assert(state2.get('lastTurn').error.kind === ERROR_KIND.PLANNER_SHAPE,
      'error kind: shape failure → PLANNER_SHAPE')
  }

  // ===========================================
  // 통합 테스트
  // ===========================================

  // direct_response (runFreeWithStateT 직접 실행)
  {
    const initial = initSnapshot()
    const { interpret, ST, log } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: '안녕하세요!' })
    })

    const turn = createAgentTurn()
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(turn('안녕'))(initial)

    assert(result === '안녕하세요!', 'direct_response: correct message')
    assert(finalState.turnState.tag === PHASE.IDLE, 'direct_response: turnState idle')
    assert(finalState.lastTurn.result === '안녕하세요!', 'direct_response: lastTurn.result saved')
    assert(log.some(l => l.tag === 'Respond'), 'direct_response: Respond op called')
  }

  // plan with RESPOND (fast exit — no formatter)
  {
    const initial = initSnapshot({ context: { memories: ['past context'] } })
    const { interpret, ST, log } = createTestInterpreter({
      AskLLM: () => JSON.stringify({
        type: 'plan',
        steps: [
          { op: 'EXEC', args: { tool: 'github', tool_args: { repo: 'test' } } },
          { op: 'RESPOND', args: { ref: 1 } },
        ]
      }),
      ExecuteTool: (op) => `${op.name}: 3 PRs found`
    })

    const turn = createAgentTurn({ tools: [{ name: 'github', description: 'GH' }] })
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(turn('PR 현황'))(initial)

    assert(result === 'github: 3 PRs found', 'plan+RESPOND: tool result passed through')
    assert(finalState.turnState.tag === PHASE.IDLE, 'plan+RESPOND: turnState idle')
    assert(log.filter(l => l.tag === 'AskLLM').length === 1, 'plan+RESPOND: AskLLM once (no formatter)')
    assert(log.some(l => l.tag === 'ExecuteTool'), 'plan+RESPOND: ExecuteTool called')
    assert(log.some(l => l.tag === 'Respond'), 'plan+RESPOND: Respond op called')
  }

  // plan without RESPOND (iteration)
  {
    const initial = initSnapshot()
    let n = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        n++
        if (n === 1) {
          return JSON.stringify({
            type: 'plan',
            steps: [
              { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
            ]
          })
        }
        // iteration 2: direct_response로 종료
        return JSON.stringify({ type: 'direct_response', message: 'src와 test 디렉토리가 있습니다.' })
      },
      ExecuteTool: () => '[dir] src\n[dir] test'
    })

    const turn = createAgentTurn()
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(turn('파일 목록 보여줘'))(initial)

    assert(n === 2, 'iteration: 2 planner calls')
    assert(result === 'src와 test 디렉토리가 있습니다.', 'iteration: direct_response result')
    assert(finalState.lastTurn.tag === RESULT.SUCCESS, 'iteration: success')
  }

  // turnState 훅: working → idle 전이 (safeRunTurn 경유)
  {
    const state = initState()
    const history = []
    state.hooks.on('turnState', (phase) => { history.push(phase.tag) })

    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'ok' })
    })

    const agent = createAgent({ interpret, ST, state })
    await agent.run('test')
    await new Promise(r => setTimeout(r, 50))

    assert(history.includes(PHASE.WORKING), 'turnState hook: working fired')
    assert(history[history.length - 1] === PHASE.IDLE, 'turnState hook: ends with idle')
  }

  // turnState idle 훅 발화 (safeRunTurn 경유)
  {
    const state = initState()
    let idleFired = false
    state.hooks.on('turnState', (phase) => {
      if (phase.tag === PHASE.IDLE) idleFired = true
    })

    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'hi' })
    })

    const agent = createAgent({ interpret, ST, state })
    await agent.run('hello')
    await new Promise(r => setTimeout(r, 50))
    assert(idleFired === true, 'turnState idle hook: fires')
  }

  // responseFormat flows into AskLLM op
  {
    const initial = initSnapshot()
    let capturedOp = null
    const { interpret, ST } = createTestInterpreter({
      AskLLM: (op) => {
        if (!capturedOp) capturedOp = op
        return JSON.stringify({ type: 'direct_response', message: 'ok' })
      }
    })

    const turn = createAgentTurn()
    await runFreeWithStateT(interpret, ST)(turn('test'))(initial)

    assert(capturedOp.responseFormat !== undefined, 'responseFormat: planner carries it')
    assert(capturedOp.responseFormat.type === 'json_object', 'responseFormat: type is json_object')
  }

  // JSON parse failure → finishFailure path
  {
    const initial = initSnapshot()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => 'NOT VALID JSON {{{'
    })

    const turn = createAgentTurn()
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(turn('crash me'))(initial)

    assert(finalState.turnState.tag === PHASE.IDLE, 'parse failure: turnState idle')
    assert(finalState.lastTurn.tag === RESULT.FAILURE, 'parse failure: lastTurn failure')
    assert(typeof result === 'string' && result.includes('오류'), 'parse failure: error response')
  }

  // Iteration: rolling context in 2nd planner call
  {
    const initial = initSnapshot()
    const capturedOps = []
    const { interpret, ST } = createTestInterpreter({
      AskLLM: (op) => {
        capturedOps.push(op)
        if (capturedOps.length === 1) {
          return JSON.stringify({
            type: 'plan',
            steps: [{ op: 'EXEC', args: { tool: 'test', tool_args: {} } }]
          })
        }
        return JSON.stringify({ type: 'direct_response', message: 'done' })
      },
      ExecuteTool: () => 'tool result'
    })

    const turn = createAgentTurn()
    await runFreeWithStateT(interpret, ST)(turn('test'))(initial)

    assert(Array.isArray(capturedOps[0].messages), 'iteration contract: 1st planner has messages')
    assert(Array.isArray(capturedOps[1].messages), 'iteration contract: 2nd planner has messages')
    assert(capturedOps[0].responseFormat !== undefined, 'iteration contract: 1st has responseFormat')
    assert(capturedOps[1].responseFormat !== undefined, 'iteration contract: 2nd also has responseFormat')
    // 2nd call includes rolling context (previous results)
    assert(capturedOps[1].messages.length > capturedOps[0].messages.length, 'iteration contract: 2nd has rolling context')
    const lastMsg = capturedOps[1].messages[capturedOps[1].messages.length - 1]
    assert(lastMsg.content.includes('Step results'), 'iteration contract: rolling context has results')
  }

  // safeRunTurn with null state → still throws, no crash
  {
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => { throw new Error('fail') }
    })

    const safe = safeRunTurn({ interpret, ST }, null)
    try {
      await safe(createAgentTurn()('x'), 'x')
      assert(false, 'safeRunTurn null state: should throw')
    } catch (e) {
      assert(e.message === 'fail', 'safeRunTurn null state: error still thrown')
      assert(true, 'safeRunTurn null state: no crash from null state')
    }
  }

  // Iteration LLM failure → safeRunTurn recovery
  {
    const state = initState()
    let n = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        n++
        if (n === 1) {
          return JSON.stringify({
            type: 'plan',
            steps: [{ op: 'EXEC', args: { tool: 'x', tool_args: {} } }]
          })
        }
        throw new Error('iteration LLM exploded')
      }
    })

    const safe = safeRunTurn({ interpret, ST }, state)
    try {
      await safe(createAgentTurn()('test'), 'test')
      assert(false, 'iteration LLM failure: should throw')
    } catch (e) {
      assert(state.get('turnState').tag === PHASE.IDLE, 'iteration LLM failure: turnState idle')
      assert(state.get('lastTurn').error.message === 'iteration LLM exploded', 'iteration LLM failure: error stored')
    }
  }

  // direct_response with null message → rejected
  {
    const state = initState()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: null })
    })

    const agent = createAgent({ interpret, ST, state })
    await agent.run('test')

    assert(state.get('turnState').tag === PHASE.IDLE, 'direct_response null: turnState idle')
    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'direct_response null: rejected')
  }

  // Plan step failure mid-chain → error captured as result, turn continues
  {
    const state = initState()
    let askCount = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        askCount++
        if (askCount === 1) {
          return JSON.stringify({
            type: 'plan',
            steps: [
              { op: 'EXEC', args: { tool: 'ok', tool_args: {} } },
              { op: 'EXEC', args: { tool: 'fail', tool_args: {} } },
              { op: 'RESPOND', args: { ref: 2 } },
            ]
          })
        }
        return JSON.stringify({ type: 'direct_response', message: 'recovered' })
      },
      ExecuteTool: (op) => {
        if (op.name === 'fail') throw new Error('step 2 failed')
        return 'ok'
      }
    })

    const safe = safeRunTurn({ interpret, ST }, state)
    await safe(createAgentTurn()('multi-step'), 'multi-step')
    assert(state.get('turnState').tag === PHASE.IDLE, 'mid-step failure: turnState idle')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'mid-step failure: turn succeeds with error result')
    assert(state.get('lastTurn').result.includes('[ERROR]'), 'mid-step failure: result contains error string')
  }

  // Parse error detail in lastTurn
  {
    const initial = initSnapshot()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => '<<<not json>>>'
    })

    const turn = createAgentTurn()
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(turn('x'))(initial)

    const lt = finalState.lastTurn
    assert(lt.error.message.length > 0, 'parse error detail: error.message is descriptive')
    assert(lt.response.includes('오류'), 'parse error detail: response has error text')
  }

  // Bare runFreeWithStateT: turnState stays idle (Free is pure, no safeRunTurn lifecycle)
  {
    const initial = initSnapshot()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => { throw new Error('crash') }
    })

    const turn = createAgentTurn()
    try {
      await runFreeWithStateT(interpret, ST)(turn('test'))(initial)
    } catch (_) {}

    // StateT 실행이 실패해도 초기 상태는 불변 (순수)
    assert(initial.turnState.tag === PHASE.IDLE,
      'bare runFreeWithStateT: initial state unchanged (pure)')
  }

  // createAgent.run() recovery
  {
    const state = initState()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => { throw new Error('crash') }
    })

    const agent = createAgent({ interpret, ST, state })
    try {
      await agent.run('test')
    } catch (_) {}

    assert(state.get('turnState').tag === PHASE.IDLE, 'createAgent.run: turnState recovered')
    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'createAgent.run: lastTurn failure')
  }

  // createAgent.run() success
  {
    const state = initState()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: '반갑습니다' })
    })

    const agent = createAgent({ interpret, ST, state })
    const result = await agent.run('안녕')
    assert(result === '반갑습니다', 'createAgent.run success: returns result')
    assert(state.get('turnState').tag === PHASE.IDLE, 'createAgent.run success: turnState idle')
  }

  // createAgent.program() dry-run
  {
    const { interpret, ST } = createTestInterpreter({})

    const agent = createAgent({ interpret, ST, state: initState() })
    const program = agent.program('test')
    assert(Free.isImpure(program), 'createAgent.program: returns Free.Impure')
  }

  // Valid plan shapes accepted
  {
    const state = initState()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'ok' })
    })
    const agent = createAgent({ interpret, ST, state })
    const result = await agent.run('hi')
    assert(result === 'ok', 'valid plan (direct_response): accepted')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'valid plan (direct_response): success')
  }

  {
    const state = initState()
    let n = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        n++
        if (n === 1) return JSON.stringify({
          type: 'plan',
          steps: [{ op: 'RESPOND', args: { message: 'done' } }]
        })
        return 'formatted'
      }
    })
    const agent = createAgent({ interpret, ST, state })
    await agent.run('do something')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'valid plan (plan+steps): success')
  }

  // createAgent with buildTurn (커스텀 전략 주입)
  {
    const state = initState()
    const { interpret, ST } = createTestInterpreter({})

    const customTurn = (input) =>
      beginTurn(input)
        .chain(() => Free.of('커스텀 결과'))
        .chain(msg => finishSuccess(input, msg))

    const agent = createAgent({
      buildTurn: customTurn,
      interpret,
      ST,
      state,
    })
    const result = await agent.run('test')
    assert(result === '커스텀 결과', 'createAgent+custom: returns result')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'createAgent+custom: lastTurn success')
  }

  // createAgent without buildTurn → defaults to incremental planning
  {
    const state = initState()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'plan 답변' })
    })

    const agent = createAgent({ interpret, ST, state })
    const result = await agent.run('test')
    assert(result === 'plan 답변', 'createAgent default: Plan-then-Execute')
  }

  // ===========================================
  // Incremental Planning 테스트
  // ===========================================

  // maxIterations 초과 → failure
  {
    const initial = initSnapshot()
    let callCount = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        callCount++
        // 매번 RESPOND 없는 plan → 무한 iteration
        return JSON.stringify({
          type: 'plan',
          steps: [{ op: 'EXEC', args: { tool: 'x', tool_args: {} } }]
        })
      }
    })

    const turn = createAgentTurn({ maxIterations: 3 })
    const [, finalState] = await runFreeWithStateT(interpret, ST)(turn('infinite'))(initial)

    assert(callCount === 3, 'maxIterations: exactly 3 calls')
    assert(finalState.lastTurn.tag === RESULT.FAILURE, 'maxIterations: failure')
    assert(finalState.lastTurn.error.kind === ERROR_KIND.MAX_ITERATIONS, 'maxIterations: error kind')
  }

  // 다단계 iteration: plan → plan → direct_response
  {
    const initial = initSnapshot()
    let n = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        n++
        if (n === 1) return JSON.stringify({
          type: 'plan',
          steps: [{ op: 'EXEC', args: { tool: 'list', tool_args: {} } }]
        })
        if (n === 2) return JSON.stringify({
          type: 'plan',
          steps: [{ op: 'EXEC', args: { tool: 'read', tool_args: {} } }]
        })
        return JSON.stringify({ type: 'direct_response', message: '3단계 완료' })
      },
      ExecuteTool: (op) => `${op.name} result`
    })

    const turn = createAgentTurn()
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(turn('deep'))(initial)

    assert(n === 3, 'multi-iteration: 3 planner calls')
    assert(result === '3단계 완료', 'multi-iteration: final direct_response')
    assert(finalState.lastTurn.tag === RESULT.SUCCESS, 'multi-iteration: success')
  }

  // malformed intermediate plan → same validation (not silently passed)
  {
    const state = initState()
    let n = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        n++
        if (n === 1) return JSON.stringify({
          type: 'plan',
          steps: [{ op: 'EXEC', args: { tool: 'x', tool_args: {} } }]
        })
        // iteration 2: malformed response
        return '<<<invalid json>>>'
      }
    })

    const safe = safeRunTurn({ interpret, ST }, state)
    try {
      await safe(createAgentTurn()('test'), 'test')
    } catch (_) {}

    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'malformed iteration: failure')
  }

  // ===========================================
  // applyFinalState + epoch 경합 방어 테스트
  // ===========================================

  // applyFinalState: 정상 적용
  {
    const state = initState()
    const finalState = {
      turnState: Phase.idle(),
      lastTurn: TurnResult.success('q', 'ok'),
      _streaming: null,
    }
    applyFinalState(state, finalState, { initialEpoch: 0 })
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'applyFinalState: lastTurn applied')
    assert(state.get('turnState').tag === PHASE.IDLE, 'applyFinalState: turnState applied')
  }

  // applyFinalState: epoch 불일치 시 conversationHistory 스킵
  {
    const state = initState({ _compactionEpoch: 1, context: { conversationHistory: [] } })
    const finalState = {
      turnState: Phase.idle(),
      lastTurn: TurnResult.success('q', 'ok'),
      context: { conversationHistory: [{ id: 'h-1', input: 'old', output: 'data' }] },
    }
    applyFinalState(state, finalState, { initialEpoch: 0 }) // epoch mismatch
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'epoch guard: lastTurn still applied')
    const history = state.get('context.conversationHistory')
    assert(Array.isArray(history) && history.length === 0, 'epoch guard: conversationHistory skipped')
  }

  // ===========================================
  // ERROR_KIND 구조 검증
  // ===========================================

  {
    assert(ERROR_KIND.MAX_ITERATIONS === 'max_iterations', 'ERROR_KIND: MAX_ITERATIONS exists')
    assert(ERROR_KIND.PLANNER_PARSE === 'planner_parse', 'ERROR_KIND: PLANNER_PARSE exists')
    assert(ERROR_KIND.PLANNER_SHAPE === 'planner_shape', 'ERROR_KIND: PLANNER_SHAPE exists')
    assert(ERROR_KIND.INTERPRETER === 'interpreter', 'ERROR_KIND: INTERPRETER exists')
    assert(!('REACT_MAX_STEPS' in ERROR_KIND), 'ERROR_KIND: REACT_MAX_STEPS removed')
    assert(!('REACT_MULTI_TOOL' in ERROR_KIND), 'ERROR_KIND: REACT_MULTI_TOOL removed')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
