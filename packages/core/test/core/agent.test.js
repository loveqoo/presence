import { initI18n } from '@presence/infra/i18n'
initI18n('ko')
import { PHASE, RESULT, ERROR_KIND, TurnState, TurnOutcome } from '@presence/core/core/policies.js'
import { validatePlan, safeJsonParse, extractJson } from '@presence/core/core/validate.js'
import { Agent } from '@presence/core/core/agent.js'
import { makeTestAgent, makeTestExecutor } from '../../../../test/lib/test-agent.js'
import { applyFinalState, MANAGED_PATHS } from '@presence/core/core/state-commit.js'
import { createTestInterpreter } from '@presence/core/interpreter/test.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { getByPath } from '@presence/core/lib/path.js'
import fp from '@presence/core/lib/fun-fp.js'

const { Free, Either } = fp
import { runFreeWithStateT } from '@presence/core/lib/runner.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// --- 초기 상태 헬퍼 ---
// reactive state (createAgent/safeRunTurn 경유 테스트용)
const initState = (overrides = {}) =>
  createOriginState({ turnState: TurnState.idle(), lastTurn: null, turn: 0, context: { memories: [] }, ...overrides })

// plain object (runFreeWithStateT 직접 실행 테스트용)
const initSnapshot = (overrides = {}) =>
  ({ turnState: TurnState.idle(), lastTurn: null, turn: 0, context: { memories: [] }, ...overrides })

import { assert, summary } from '../../../../test/lib/assert.js'

async function run() {
  console.log('Agent turn tests')

  // ===========================================
  // 상태 전이 단위 테스트
  // ===========================================

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

    const agent = makeTestAgent({ interpret, ST, state })
    await agent.run('new input')

    assert(turnStateAtFreeStart.tag === PHASE.WORKING, 'safeRunTurn: turnState working before Free')
    assert(turnStateAtFreeStart.input === 'new input', 'safeRunTurn: input stored in working state')
  }

  // T2-T3: finishSuccess/finishFailure 단위 테스트 제거됨 (planner.js 내부 함수로 이동)

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

    const agent = makeTestAgent({ interpret, ST, state })

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

    // I10: direct_response 빈 메시지 차단
    const failEmpty = validatePlan({ type: 'direct_response', message: '' })
    assert(Either.isLeft(failEmpty), 'validatePlan: empty message → Left')

    const failWhitespace = validatePlan({ type: 'direct_response', message: '   \n  ' })
    assert(Either.isLeft(failWhitespace), 'validatePlan: whitespace-only message → Left')

    const fail3 = validatePlan({ type: 'plan', steps: [] })
    assert(Either.isLeft(fail3), 'validatePlan: empty steps → Left')

    const fail4 = validatePlan({ type: 'unknown' })
    assert(Either.isLeft(fail4), 'validatePlan: unknown type → Left')

    // KG-13: ASK_LLM 이 마지막 스텝이면 RESPOND 필수
    const failAskLast = validatePlan({ type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'test', tool_args: {} } },
      { op: 'ASK_LLM', args: { prompt: 'summarize', ctx: [1] } },
    ] })
    assert(Either.isLeft(failAskLast), 'validatePlan: ASK_LLM last without RESPOND → Left')
    assert(failAskLast.value.message.includes('ASK_LLM'), 'validatePlan: error mentions ASK_LLM')

    // ASK_LLM + RESPOND 는 정상
    const okAskRespond = validatePlan({ type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'test', tool_args: {} } },
      { op: 'ASK_LLM', args: { prompt: 'summarize', ctx: [1] } },
      { op: 'RESPOND', args: { ref: 2 } },
    ] })
    assert(Either.isRight(okAskRespond), 'validatePlan: ASK_LLM + RESPOND → Right')

    // EXEC 마지막 (RESPOND 없음) 은 허용 — 수렴 루프
    const okExecLast = validatePlan({ type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'test', tool_args: {} } },
    ] })
    assert(Either.isRight(okExecLast), 'validatePlan: EXEC last without RESPOND → Right (convergence)')
  }

  // T6b. KG-12: web_fetch SERP URL 차단
  {
    const webTools = [{ name: 'web_fetch', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } }]

    // SERP URL → Left
    const serpGoogle = validatePlan({ type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'web_fetch', tool_args: { url: 'https://www.google.com/search?q=busan+cafe' } } },
      { op: 'RESPOND', args: { ref: 1 } },
    ] }, { tools: webTools })
    assert(Either.isLeft(serpGoogle), 'validatePlan: google SERP → Left')
    assert(serpGoogle.value.message.includes('search engine'), 'validatePlan: SERP error message')

    const serpBing = validatePlan({ type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'web_fetch', tool_args: { url: 'https://bing.com/search?q=test' } } },
      { op: 'RESPOND', args: { ref: 1 } },
    ] }, { tools: webTools })
    assert(Either.isLeft(serpBing), 'validatePlan: bing SERP → Left')

    // 일반 URL → Right
    const okUrl = validatePlan({ type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'web_fetch', tool_args: { url: 'https://example.com/page' } } },
      { op: 'RESPOND', args: { ref: 1 } },
    ] }, { tools: webTools })
    assert(Either.isRight(okUrl), 'validatePlan: normal URL → Right')

    // google.com (SERP 아닌 경로) → Right
    const okGoogle = validatePlan({ type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'web_fetch', tool_args: { url: 'https://www.google.com/maps' } } },
      { op: 'RESPOND', args: { ref: 1 } },
    ] }, { tools: webTools })
    assert(Either.isRight(okGoogle), 'validatePlan: google non-SERP → Right')
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

    // FP-52: truncation 탐지 — 200자 이상이고 }, ], " 로 끝나지 않으면 truncated
    const truncatedStr = '{"type":"direct_response","message":"' + 'x'.repeat(300)
    const truncResult = safeJsonParse(truncatedStr)
    assert(Either.isLeft(truncResult), 'safeJsonParse: truncated → Left')
    assert(truncResult.value.truncated === true, 'safeJsonParse: truncated flag set')
    assert(truncResult.value.message.includes('truncated'), 'safeJsonParse: error mentions truncated')

    // 짧은 실패는 truncated 아님
    const shortFail = safeJsonParse('{"bad')
    assert(Either.isLeft(shortFail), 'safeJsonParse: short invalid → Left')
    assert(!shortFail.value.truncated, 'safeJsonParse: short fail not truncated')

    // 정상 종결 JSON 은 truncated 아님 (다른 이유로 실패해도)
    const validEndFail = safeJsonParse('{"type":"unknown"}')
    assert(Either.isLeft(validEndFail.chain(validatePlan)), 'safeJsonParse: valid JSON wrong type → Left via validate')
  }

  // T8. 구조 검증
  {
    const agentSrc = readFileSync(join(__dirname, '../../src/core/agent.js'), 'utf-8')
    const plannerSrc = readFileSync(join(__dirname, '../../src/core/planner.js'), 'utf-8')
    const executorSrc = readFileSync(join(__dirname, '../../src/core/executor.js'), 'utf-8')
    const validateSrc = readFileSync(join(__dirname, '../../src/core/validate.js'), 'utf-8')

    // Agent: Planner + Executor 조합
    assert(agentSrc.includes('class Agent'), 'structural: Agent class exists')
    assert(agentSrc.includes('this.planner'), 'structural: Agent delegates to Planner')
    assert(agentSrc.includes('this.executor'), 'structural: Agent delegates to Executor')

    // Planner: Free 프로그램 설계
    assert(plannerSrc.includes('class Planner'), 'structural: Planner class exists')
    assert(plannerSrc.includes('planCycle'), 'structural: Planner.planCycle exists')
    assert(plannerSrc.includes('executeCycle'), 'structural: Planner.executeCycle exists')

    // Executor: 실행 경계
    assert(executorSrc.includes('class Executor'), 'structural: Executor class exists')
    assert(executorSrc.includes('runFreeWithStateT'), 'structural: Executor uses runFreeWithStateT')
    assert(executorSrc.includes('applyFinalState'), 'structural: applyFinalState in Executor')

    // Validate: Either 기반
    assert(validateSrc.includes('Either.catch'), 'structural: Either.catch used for JSON parse (validate.js)')
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

      const agent = makeTestAgent({ interpret, ST, state })
      await agent.run('test')

      assert(state.get('turnState').tag === PHASE.IDLE, `invalid plan (${label}): turnState idle`)
      assert(state.get('lastTurn').tag === RESULT.FAILURE, `invalid plan (${label}): lastTurn failure`)
      assert(!formatterCalled, `invalid plan (${label}): formatter not called`)
    }
  }

  // T7. Agent.run — error recovery, input 캡처
  {
    const state = initState()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => { throw new Error('LLM down') }
    })

    const agent = makeTestAgent({ interpret, ST, state })
    try {
      await agent.run('x')
      assert(false, 'Agent.run error: should throw')
    } catch (_) {
      assert(state.get('turnState').tag === PHASE.IDLE, 'Agent.run error: turnState idle')
      const lt = state.get('lastTurn')
      assert(lt.tag === RESULT.FAILURE, 'Agent.run error: lastTurn failure')
      assert(lt.error.message === 'LLM down', 'Agent.run error: error.message')
      assert(lt.error.kind === ERROR_KIND.INTERPRETER, 'Agent.run error: error.kind is interpreter')
      assert(lt.input === 'x', 'Agent.run error: input captured from caller')
      assert(lt.response === null, 'Agent.run error: response is null')
    }
  }

  // T8. ErrorInfo kind — planner_parse vs planner_shape
  {
    // parse failure → PLANNER_PARSE
    const state1 = initState()
    const { interpret: i1, ST: ST1 } = createTestInterpreter({
      AskLLM: () => '<<<not json>>>'
    })
    const agent1 = makeTestAgent({ interpret: i1, ST: ST1, state: state1 })
    await agent1.run('test')
    assert(state1.get('lastTurn').error.kind === ERROR_KIND.PLANNER_PARSE,
      'error kind: parse failure → PLANNER_PARSE')

    // shape failure → PLANNER_SHAPE
    const state2 = initState()
    const { interpret: i2, ST: ST2 } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'unknown' })
    })
    const agent2 = makeTestAgent({ interpret: i2, ST: ST2, state: state2 })
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

    const agent = makeTestAgent({ interpret, ST })
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(agent.planner.program('안녕'))(initial)

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

    const agent = makeTestAgent({ resolveTools: () => [{ name: 'github', description: 'GH' }], interpret, ST })
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(agent.planner.program('PR 현황'))(initial)

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

    const agent = makeTestAgent({ interpret, ST })
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(agent.planner.program('파일 목록 보여줘'))(initial)

    assert(n === 2, 'iteration: 2 planner calls')
    assert(result === 'src와 test 디렉토리가 있습니다.', 'iteration: direct_response result')
    assert(finalState.lastTurn.tag === RESULT.SUCCESS, 'iteration: success')
  }

  // turnState 훅: working → idle 전이 (safeRunTurn 경유)
  {
    const state = initState()
    const history = []
    state.hooks.on("turnState", (change) => { const phase = change.nextValue; history.push(phase.tag) })

    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'ok' })
    })

    const agent = makeTestAgent({ interpret, ST, state })
    await agent.run('test')
    await new Promise(r => setTimeout(r, 50))

    assert(history.includes(PHASE.WORKING), 'turnState hook: working fired')
    assert(history[history.length - 1] === PHASE.IDLE, 'turnState hook: ends with idle')
  }

  // turnState idle 훅 발화 (safeRunTurn 경유)
  {
    const state = initState()
    let idleFired = false
    state.hooks.on("turnState", (change) => { const phase = change.nextValue;
      if (phase.tag === PHASE.IDLE) idleFired = true
    })

    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'hi' })
    })

    const agent = makeTestAgent({ interpret, ST, state })
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

    const agent = makeTestAgent({ interpret, ST })
    await runFreeWithStateT(interpret, ST)(agent.planner.program('test'))(initial)

    assert(capturedOp.responseFormat !== undefined, 'responseFormat: planner carries it')
    assert(capturedOp.responseFormat.type === 'json_object', 'responseFormat: type is json_object')
  }

  // JSON parse failure → finishFailure path
  {
    const initial = initSnapshot()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => 'NOT VALID JSON {{{'
    })

    const agent = makeTestAgent({ interpret, ST })
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(agent.planner.program('crash me'))(initial)

    assert(finalState.turnState.tag === PHASE.IDLE, 'parse failure: turnState idle')
    assert(finalState.lastTurn.tag === RESULT.FAILURE, 'parse failure: lastTurn failure')
    assert(typeof result === 'string' && (result.includes('오류') || result.includes('error')), 'parse failure: error response')
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

    const agent = makeTestAgent({ interpret, ST })
    await runFreeWithStateT(interpret, ST)(agent.planner.program('test'))(initial)

    assert(Array.isArray(capturedOps[0].messages), 'iteration contract: 1st planner has messages')
    assert(Array.isArray(capturedOps[1].messages), 'iteration contract: 2nd planner has messages')
    assert(capturedOps[0].responseFormat !== undefined, 'iteration contract: 1st has responseFormat')
    assert(capturedOps[1].responseFormat !== undefined, 'iteration contract: 2nd also has responseFormat')
    // 2nd call includes rolling context (previous results)
    assert(capturedOps[1].messages.length > capturedOps[0].messages.length, 'iteration contract: 2nd has rolling context')
    const lastMsg = capturedOps[1].messages[capturedOps[1].messages.length - 1]
    assert(lastMsg.content.includes('Step results'), 'iteration contract: rolling context has results')
  }

  // Agent.run with null state → still throws, no crash
  {
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => { throw new Error('fail') }
    })

    const agent = makeTestAgent({ interpret, ST, state: null })
    try {
      await agent.run('x')
      assert(false, 'Agent.run null state: should throw')
    } catch (e) {
      assert(e.message === 'fail', 'Agent.run null state: error still thrown')
      assert(true, 'Agent.run null state: no crash from null state')
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

    const agent = makeTestAgent({ interpret, ST, state })
    try {
      await agent.run('test')
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

    const agent = makeTestAgent({ interpret, ST, state })
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

    const agent = makeTestAgent({ interpret, ST, state })
    await agent.run('multi-step')
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

    const agent = makeTestAgent({ interpret, ST })
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(agent.planner.program('x'))(initial)

    const lt = finalState.lastTurn
    assert(lt.error.message.length > 0, 'parse error detail: error.message is descriptive')
    assert(lt.response.includes('오류') || lt.response.includes('error'), 'parse error detail: response has error text')
  }

  // Bare runFreeWithStateT: turnState stays idle (Free is pure, no safeRunTurn lifecycle)
  {
    const initial = initSnapshot()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => { throw new Error('crash') }
    })

    const agent = makeTestAgent({ interpret, ST })
    try {
      await runFreeWithStateT(interpret, ST)(agent.planner.program('test'))(initial)
    } catch (_) {}

    // StateT 실행이 실패해도 초기 상태는 불변 (순수)
    assert(initial.turnState.tag === PHASE.IDLE,
      'bare runFreeWithStateT: initial state unchanged (pure)')
  }

  // Agent.run() recovery
  {
    const state = initState()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => { throw new Error('crash') }
    })

    const agent = makeTestAgent({ interpret, ST, state })
    try {
      await agent.run('test')
    } catch (_) {}

    assert(state.get('turnState').tag === PHASE.IDLE, 'Agent.run: turnState recovered')
    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'Agent.run: lastTurn failure')
  }

  // Executor.recover() 단위 테스트 — runFreeWithStateT throw 경로
  {
    const { Executor } = await import('@presence/core/core/executor.js')
    const state = initState({ _streaming: { active: true }, lastTurn: null })
    state.set('turnState', TurnState.working('orig input'))

    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => { throw new Error('interpreter boom') }
    })
    const failingProgram = (await import('@presence/core/core/op.js')).askLLM({ messages: [] })

    const executor = makeTestExecutor({ interpret, ST, state })

    let thrown = null
    try {
      await executor.run(failingProgram, 'orig input')
    } catch (e) {
      thrown = e
    }

    // Executor 는 예외를 재전파한다
    assert(thrown !== null, 'Executor.run: re-throws on interpreter error')
    assert(thrown.message === 'interpreter boom', 'Executor.run: preserves error message')
    // recover() 가 세 경로를 원자적으로 초기화한다
    assert(state.get('_streaming') === null, 'Executor.recover: _streaming cleared')
    assert(state.get('_pendingInput') === null, 'Executor.recover: _pendingInput cleared')
    assert(state.get('turnState').tag === PHASE.IDLE, 'Executor.recover: turnState → idle')
    const last = state.get('lastTurn')
    assert(last.tag === RESULT.FAILURE, 'Executor.recover: lastTurn failure')
    assert(last.input === 'orig input', 'Executor.recover: failure retains original input')
    assert(last.error.kind === ERROR_KIND.INTERPRETER, 'Executor.recover: error kind INTERPRETER')
    assert(last.error.message === 'interpreter boom', 'Executor.recover: error message preserved')
  }

  // Executor.beginLifecycle → _pendingInput set (입력 즉시 표시)
  {
    const { Executor } = await import('@presence/core/core/executor.js')
    const state = initState()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'ok' })
    })
    const { askLLM } = await import('@presence/core/core/op.js')
    const executor = makeTestExecutor({ interpret, ST, state })
    // beginLifecycle 이 턴 시작 시 동기적으로 pending 을 set 하는지만 관찰.
    executor.beginLifecycle('hello world')
    const pending = state.get('_pendingInput')
    assert(pending?.input === 'hello world', 'Executor.beginLifecycle: _pendingInput.input set')
    assert(typeof pending?.ts === 'number' && pending.ts > 0, 'Executor.beginLifecycle: _pendingInput.ts set')
  }

  // Executor.recover — abort 경로 분기 (INV-ABT-1)
  {
    const { Executor } = await import('@presence/core/core/executor.js')
    const { TurnLifecycle } = await import('@presence/core/core/turn-lifecycle.js')
    const state = initState({ context: { memories: [], conversationHistory: [] } })
    state.set('turnState', TurnState.working('cancelled input'))

    const abortError = Object.assign(new Error('user cancelled'), { name: 'AbortError' })
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => { throw abortError }
    })
    const { askLLM } = await import('@presence/core/core/op.js')
    const program = askLLM({ messages: [] })

    const lifecycle = new TurnLifecycle()
    const executor = makeTestExecutor({
      interpret, ST, state,
      actors: { turnLifecycle: lifecycle, isAborted: () => true },
    })

    let thrown = null
    try { await executor.run(program, 'cancelled input') } catch (e) { thrown = e }

    assert(thrown !== null, 'Executor.recover abort: rethrows')
    const last = state.get('lastTurn')
    assert(last.tag === RESULT.FAILURE, 'Executor.recover abort: lastTurn failure')
    assert(last.error.kind === ERROR_KIND.ABORTED, 'Executor.recover abort: kind = ABORTED')

    const history = state.get('context.conversationHistory')
    assert(history.length === 2, 'Executor.recover abort: turn entry + SYSTEM entry appended')
    assert(history[0].cancelled === true, 'Executor.recover abort: turn entry cancelled')
    assert(history[0].errorKind === ERROR_KIND.ABORTED, 'Executor.recover abort: turn entry errorKind')
    assert(history[1].type === 'system', 'Executor.recover abort: SYSTEM entry')
    assert(history[1].tag === 'cancel', 'Executor.recover abort: SYSTEM tag=cancel')
  }

  // Executor.recover — 일반 error 경로는 SYSTEM entry 없음
  {
    const { Executor } = await import('@presence/core/core/executor.js')
    const { TurnLifecycle } = await import('@presence/core/core/turn-lifecycle.js')
    const state = initState({ context: { memories: [], conversationHistory: [] } })
    state.set('turnState', TurnState.working('input'))

    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => { throw new Error('boom') }
    })
    const { askLLM } = await import('@presence/core/core/op.js')
    const program = askLLM({ messages: [] })

    const lifecycle = new TurnLifecycle()
    const executor = makeTestExecutor({
      interpret, ST, state,
      actors: { turnLifecycle: lifecycle, isAborted: () => false },
    })

    try { await executor.run(program, 'input') } catch (_) {}

    const history = state.get('context.conversationHistory')
    assert(history.length === 1, 'Executor.recover failure: only failed turn entry (no SYSTEM)')
    assert(history[0].failed === true, 'Executor.recover failure: failed=true')
    assert(history[0].cancelled === undefined, 'Executor.recover failure: not cancelled')
    const last = state.get('lastTurn')
    assert(last.error.kind === ERROR_KIND.INTERPRETER, 'Executor.recover failure: kind = INTERPRETER')
  }

  // Agent 가 주입받은 lifecycle 을 Planner 로 forward (세션 내 단일 인스턴스 보장)
  {
    const { TurnLifecycle } = await import('@presence/core/core/turn-lifecycle.js')
    const lifecycle = new TurnLifecycle()
    const { interpret, ST } = createTestInterpreter({})
    const agent = makeTestAgent({ interpret, ST, state: initState(), lifecycle })
    assert(agent.planner.lifecycle === lifecycle, 'Agent: lifecycle forwarded to Planner (single instance)')
  }

  // Agent.run() success
  {
    const state = initState()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: '반갑습니다' })
    })

    const agent = makeTestAgent({ interpret, ST, state })
    const result = await agent.run('안녕')
    assert(result === '반갑습니다', 'Agent.run success: returns result')
    assert(state.get('turnState').tag === PHASE.IDLE, 'Agent.run success: turnState idle')
  }

  // Agent.program() dry-run
  {
    const { interpret, ST } = createTestInterpreter({})

    const agent = makeTestAgent({ interpret, ST, state: initState() })
    const program = agent.planner.program('test')
    assert(Free.isImpure(program), 'Agent.program: returns Free.Impure')
  }

  // Valid plan shapes accepted
  {
    const state = initState()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'ok' })
    })
    const agent = makeTestAgent({ interpret, ST, state })
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
    const agent = makeTestAgent({ interpret, ST, state })
    await agent.run('do something')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'valid plan (plan+steps): success')
  }

  // Agent defaults to incremental planning
  {
    const state = initState()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'plan 답변' })
    })

    const agent = makeTestAgent({ interpret, ST, state })
    const result = await agent.run('test')
    assert(result === 'plan 답변', 'Agent default: Plan-then-Execute')
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

    const agent = makeTestAgent({ maxIterations: 3, interpret, ST })
    const [, finalState] = await runFreeWithStateT(interpret, ST)(agent.planner.program('infinite'))(initial)

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

    const agent = makeTestAgent({ interpret, ST })
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(agent.planner.program('deep'))(initial)

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

    const agent = makeTestAgent({ interpret, ST, state })
    try {
      await agent.run('test')
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
      turnState: TurnState.idle(),
      lastTurn: TurnOutcome.success('q', 'ok'),
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
      turnState: TurnState.idle(),
      lastTurn: TurnOutcome.success('q', 'ok'),
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

  summary()
}

run()
