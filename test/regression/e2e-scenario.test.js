/**
 * E2E 시나리오 회귀 테스트
 * 수동 테스트에서 발견된 실제 버그 패턴을 mock LLM으로 재현.
 * 전체 파이프라인: planner → parse → validate → (retry) → execute → format → finish
 */
import { initI18n } from '@presence/infra/i18n'
initI18n('ko')
import { PHASE, RESULT, ERROR_KIND, TurnState } from '@presence/core/core/policies.js'
import { Agent } from '@presence/core/core/agent.js'
import { applyFinalState } from '@presence/core/core/state-commit.js'
import { createTestInterpreter } from '@presence/core/interpreter/test.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { createLocalTools } from '@presence/infra/infra/tools/local-tools.js'
import { createToolRegistry } from '@presence/infra/infra/tools/tool-registry.js'
import { runFreeWithStateT } from '@presence/core/lib/runner.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { assert, summary } from '../lib/assert.js'

const testDir = join(tmpdir(), `presence-e2e-${Date.now()}`)
mkdirSync(testDir, { recursive: true })
writeFileSync(join(testDir, 'package.json'), '{"name":"test"}')
writeFileSync(join(testDir, 'readme.txt'), 'hello world')

const localTools = createLocalTools({ allowedDirs: [testDir] })
const toolRegistry = createToolRegistry()
for (const t of localTools) toolRegistry.register(t)
const tools = toolRegistry.list()

const initState = (overrides = {}) =>
  createOriginState({ turnState: TurnState.idle(), lastTurn: null, turn: 0, context: { memories: [] }, ...overrides })

async function run() {
  console.log('E2E scenario regression tests')

  // =============================================
  // 1. LLM이 절대경로 /package.json 반환
  //    normalizePath가 allowedDir 기준 상대경로로 복구
  // =============================================
  {
    const state = initState()
    let plannerCall = 0
    const { interpret, ST, log } = createTestInterpreter({
      AskLLM: () => {
        plannerCall++
        if (plannerCall === 1) {
          // 실제 버그: LLM이 /package.json 절대경로 생성
          return JSON.stringify({
            type: 'plan',
            steps: [
              { op: 'EXEC', args: { tool: 'file_read', tool_args: { path: '/package.json' } } },
              { op: 'RESPOND', args: { ref: 1 } },
            ]
          })
        }
        return 'package.json 내용입니다.'
      },
      ExecuteTool: (op) => {
        // normalizePath가 /package.json → testDir/package.json 으로 복구
        // 하지만 test interpreter는 실제 파일 접근 안 하므로
        // 여기서는 경로가 전달되었는지만 확인
        return `file content: ${JSON.stringify(op.args)}`
      },
    })

    const agent = new Agent({ resolveTools: () => tools, interpret, ST, state })
    await agent.run('package.json 파일 읽어줘')

    assert(state.get('turnState').tag === PHASE.IDLE, 'absolute path: turnState idle')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'absolute path: pipeline completes')
    assert(log.some(l => l.tag === 'ExecuteTool'), 'absolute path: tool was executed')
  }

  // =============================================
  // 2. LLM이 tool_args 없이 args에 직접 인자 삽입
  //    EXEC fallback: { tool, ...rest } → rest를 tool_args로 사용
  // =============================================
  {
    const state = initState()
    let plannerCall = 0
    let capturedToolArgs = null
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        plannerCall++
        if (plannerCall === 1) {
          // 실제 버그: LLM이 command를 args에 직접 넣음
          return JSON.stringify({
            type: 'plan',
            steps: [
              { op: 'EXEC', args: { tool: 'shell_exec', command: 'echo hello' } },
              { op: 'RESPOND', args: { ref: 1 } },
            ]
          })
        }
        return 'echo 결과입니다.'
      },
      ExecuteTool: (op) => {
        capturedToolArgs = op.args
        return 'hello'
      },
    })

    const agent = new Agent({ resolveTools: () => tools, interpret, ST, state })
    await agent.run('echo hello 실행해줘')

    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'flat args fallback: success')
    assert(capturedToolArgs != null, 'flat args fallback: tool was called')
    assert(capturedToolArgs.command === 'echo hello', 'flat args fallback: command extracted from args')
  }

  // =============================================
  // 3. LLM이 message 대신 content 사용
  //    validatePlan이 Left 반환 → finishFailure
  // =============================================
  {
    const state = initState()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', content: '안녕하세요!' })
    })

    const agent = new Agent({ interpret, ST, state })
    await agent.run('안녕')

    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'content field: rejected')
    assert(state.get('lastTurn').error.kind === ERROR_KIND.PLANNER_SHAPE, 'content field: PLANNER_SHAPE error')
    assert(state.get('turnState').tag === PHASE.IDLE, 'content field: turnState idle')
  }

  // =============================================
  // 4. LLM이 ref=3 생성, 실제 step은 2개
  //    validateRefRange가 Left 반환 → finishFailure
  // =============================================
  {
    const state = initState()
    let formatterCalled = false
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        if (!formatterCalled) {
          formatterCalled = true
          return JSON.stringify({
            type: 'plan',
            steps: [
              { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
              { op: 'RESPOND', args: { ref: 3 } },
            ]
          })
        }
        return 'should not reach here'
      },
    })

    const agent = new Agent({ resolveTools: () => tools, interpret, ST, state })
    await agent.run('파일 목록 보여줘')

    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'ref exceeds: rejected')
    assert(state.get('lastTurn').error.kind === ERROR_KIND.PLANNER_SHAPE, 'ref exceeds: PLANNER_SHAPE')
  }

  // =============================================
  // 5. LLM이 ref=0 생성 (0-based 실수)
  //    argValidators.RESPOND가 Left 반환
  // =============================================
  {
    const state = initState()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({
        type: 'plan',
        steps: [
          { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
          { op: 'RESPOND', args: { ref: 0 } },
        ]
      }),
    })

    const agent = new Agent({ resolveTools: () => tools, interpret, ST, state })
    await agent.run('파일 목록')

    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'ref=0: rejected')
  }

  // =============================================
  // 6. 재시도(retry) 시나리오: 첫 번째 응답 실패 → 두 번째 성공
  // =============================================
  {
    const state = initState()
    let attempt = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        attempt++
        if (attempt === 1) return '<<<invalid json>>>'
        // 재시도: 올바른 응답
        return JSON.stringify({ type: 'direct_response', message: '재시도 성공' })
      },
    })

    const agent = new Agent({ maxRetries: 1, interpret, ST })
    const initialState = state.snapshot()
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(agent.planner.program('테스트'))(initialState)
    applyFinalState(state, finalState)

    assert(attempt === 2, 'retry: LLM called twice')
    assert(result === '재시도 성공', 'retry: second attempt succeeds')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'retry: lastTurn success')
    // _retry 상태가 기록되었는지 확인 (UI 알림용)
    assert(state.get('_retry') != null, 'retry: _retry state recorded')
    assert(state.get('_retry').attempt === 1, 'retry: attempt number correct')
  }

  // =============================================
  // 7. 재시도 소진: maxRetries=1, 두 번 다 실패
  // =============================================
  {
    const state = initState()
    let attempt = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        attempt++
        return '<<<still invalid>>>'
      },
    })

    const agent = new Agent({ maxRetries: 1, interpret, ST })
    const initialState = state.snapshot()
    const [, finalState] = await runFreeWithStateT(interpret, ST)(agent.planner.program('계속 실패'))(initialState)
    applyFinalState(state, finalState)

    assert(attempt === 2, 'retry exhausted: LLM called twice')
    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'retry exhausted: lastTurn failure')
    assert(state.get('lastTurn').error.kind === ERROR_KIND.PLANNER_PARSE, 'retry exhausted: parse error')
  }

  // =============================================
  // 8. 성공 파이프라인 전체 검증 (iteration 모델)
  //    iteration 1: planner → EXEC (no RESPOND) → observe
  //    iteration 2: planner → direct_response → respond → finishSuccess
  // =============================================
  {
    const state = initState()
    let plannerCall = 0
    const executedTools = []
    const { interpret, ST, log } = createTestInterpreter({
      AskLLM: () => {
        plannerCall++
        if (plannerCall === 1) {
          // iteration 1: RESPOND 없음 → 중간 결과
          return JSON.stringify({
            type: 'plan',
            steps: [
              { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
              { op: 'EXEC', args: { tool: 'file_read', tool_args: { path: 'readme.txt' } } },
            ]
          })
        }
        // iteration 2: 결과를 보고 direct_response
        return JSON.stringify({ type: 'direct_response', message: '파일 내용은 hello world 입니다.' })
      },
      ExecuteTool: (op) => {
        executedTools.push(op.name)
        if (op.name === 'file_list') return '[file] readme.txt\n[file] package.json'
        if (op.name === 'file_read') return 'hello world'
        return 'unknown tool'
      },
    })

    const agent = new Agent({ resolveTools: () => tools, interpret, ST, state })
    const result = await agent.run('readme.txt 내용 알려줘')

    // 파이프라인 순서 검증
    assert(plannerCall === 2, 'full pipeline: 2 planner iterations')
    assert(executedTools.length === 2, 'full pipeline: 2 tools executed')
    assert(executedTools[0] === 'file_list', 'full pipeline: file_list first')
    assert(executedTools[1] === 'file_read', 'full pipeline: file_read second')
    assert(result === '파일 내용은 hello world 입니다.', 'full pipeline: direct_response result')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'full pipeline: lastTurn success')
    assert(state.get('lastTurn').input === 'readme.txt 내용 알려줘', 'full pipeline: input preserved')
    assert(state.get('turnState').tag === PHASE.IDLE, 'full pipeline: turnState idle')

    // Op 호출 순서 검증
    const tags = log.map(l => l.tag).filter(t => !['UpdateState', 'GetState'].includes(t))
    assert(tags.filter(t => t === 'AskLLM').length === 2, 'full pipeline order: 2 AskLLM total')
    assert(tags.includes('ExecuteTool'), 'full pipeline order: includes ExecuteTool')
    assert(tags[tags.length - 1] === 'Respond', 'full pipeline order: ends with Respond')
  }

  // =============================================
  // 9. direct_response 성공 파이프라인
  //    planner → validate → respond → finishSuccess (formatter 없음)
  // =============================================
  {
    const state = initState()
    let askLLMCount = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        askLLMCount++
        return JSON.stringify({ type: 'direct_response', message: '안녕하세요!' })
      },
    })

    const agent = new Agent({ interpret, ST, state })
    const result = await agent.run('안녕')

    assert(askLLMCount === 1, 'direct_response: AskLLM called once (no formatter)')
    assert(result === '안녕하세요!', 'direct_response: message returned directly')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'direct_response: success')
  }

  // =============================================
  // 10. EXEC 필수 인자 누락
  //     file_read에 path 없이 호출 → validateExecArgs가 Left 반환
  // =============================================
  {
    const state = initState()
    let toolExecuted = false
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({
        type: 'plan',
        steps: [
          { op: 'EXEC', args: { tool: 'file_read', tool_args: {} } },
          { op: 'RESPOND', args: { ref: 1 } },
        ]
      }),
      ExecuteTool: () => { toolExecuted = true; return 'should not run' },
    })

    const agent = new Agent({ resolveTools: () => tools, interpret, ST, state })
    await agent.run('파일 읽어줘')

    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'missing required args: rejected')
    assert(state.get('lastTurn').error.kind === ERROR_KIND.PLANNER_SHAPE, 'missing required args: PLANNER_SHAPE')
    assert(!toolExecuted, 'missing required args: tool never executed')
  }

  // =============================================
  // 10b. EXEC 필수 인자 값이 null
  //      키는 존재하지만 값이 null → validateExecArgs가 감지
  // =============================================
  {
    const state = initState()
    let toolExecuted = false
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({
        type: 'plan',
        steps: [
          { op: 'EXEC', args: { tool: 'file_read', tool_args: { path: null } } },
          { op: 'RESPOND', args: { ref: 1 } },
        ]
      }),
      ExecuteTool: () => { toolExecuted = true; return 'should not run' },
    })

    const agent = new Agent({ resolveTools: () => tools, interpret, ST, state })
    await agent.run('파일 읽어줘')

    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'null required arg: rejected')
    assert(state.get('lastTurn').error.kind === ERROR_KIND.PLANNER_SHAPE, 'null required arg: PLANNER_SHAPE')
    assert(!toolExecuted, 'null required arg: tool never executed')
  }

  // =============================================
  // 10c. EXEC 미등록 툴
  //      레지스트리에 없는 툴 → validateExecArgs가 Left 반환, 실행 전 거부
  // =============================================
  {
    const state = initState()
    let toolExecuted = false
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({
        type: 'plan',
        steps: [
          { op: 'EXEC', args: { tool: 'nonexistent_tool', tool_args: {} } },
        ]
      }),
      ExecuteTool: () => { toolExecuted = true; return 'should not run' },
    })

    const agent = new Agent({ resolveTools: () => tools, interpret, ST, state })
    await agent.run('존재하지 않는 툴')

    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'unknown tool: rejected')
    assert(state.get('lastTurn').error.kind === ERROR_KIND.PLANNER_SHAPE, 'unknown tool: PLANNER_SHAPE')
    assert(!toolExecuted, 'unknown tool: tool never executed')
  }

  // =============================================
  // 11. ASK_LLM ctx에 0 포함
  //     argValidators가 양의 정수만 허용
  // =============================================
  {
    const state = initState()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({
        type: 'plan',
        steps: [
          { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
          { op: 'ASK_LLM', args: { prompt: 'summarize', ctx: [0] } },
          { op: 'RESPOND', args: { ref: 2 } },
        ]
      }),
    })

    const agent = new Agent({ resolveTools: () => tools, interpret, ST, state })
    await agent.run('파일 분석해줘')

    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'ctx=[0]: rejected')
  }

  // =============================================
  // 12. ASK_LLM ctx가 자기 자신을 참조
  //     validateRefRange가 Left 반환
  // =============================================
  {
    const state = initState()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({
        type: 'plan',
        steps: [
          { op: 'ASK_LLM', args: { prompt: 'think', ctx: [1] } },
          { op: 'RESPOND', args: { ref: 1 } },
        ]
      }),
    })

    const agent = new Agent({ interpret, ST, state })
    await agent.run('생각해봐')

    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'ctx self-ref: rejected')
  }

  // =============================================
  // 13. 실패 후 성공: 상태 완전 교체 검증
  //     lastTurn.error가 null로 교체됨
  // =============================================
  {
    const state = initState()
    let turnNum = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        turnNum++
        if (turnNum === 1) return '<<<invalid>>>'
        return JSON.stringify({ type: 'direct_response', message: '성공' })
      },
    })

    const agent = new Agent({ interpret, ST, state })

    await agent.run('첫 번째')
    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'fail-then-success: first turn failure')
    assert(state.get('lastTurn').error != null, 'fail-then-success: error present after failure')

    await agent.run('두 번째')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'fail-then-success: second turn success')
    assert(state.get('lastTurn').error === undefined, 'fail-then-success: error absent after success')
  }

  // =============================================
  // 14. 재시도 + shape 에러: 첫 번째 parse 성공이지만 shape 실패 → 재시도
  // =============================================
  {
    const state = initState()
    let attempt = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        attempt++
        if (attempt === 1) {
          // valid JSON이지만 잘못된 shape
          return JSON.stringify({ type: 'plan', steps: [] })
        }
        return JSON.stringify({ type: 'direct_response', message: '수정됨' })
      },
    })

    const agent = new Agent({ maxRetries: 1, interpret, ST })
    const initialState = state.snapshot()
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(agent.planner.program('테스트'))(initialState)
    applyFinalState(state, finalState)

    assert(attempt === 2, 'shape retry: two attempts')
    assert(result === '수정됨', 'shape retry: second attempt succeeds')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'shape retry: lastTurn success')
  }

  // =============================================
  // 15. 메모리 컨텍스트가 플래너에 전달됨
  // =============================================
  {
    const state = initState({ context: { memories: ['이전 대화: 프로젝트 이름은 presence'] } })
    let capturedMessages = null
    const { interpret, ST } = createTestInterpreter({
      AskLLM: (op) => {
        if (!capturedMessages) capturedMessages = op.messages
        return JSON.stringify({ type: 'direct_response', message: 'ok' })
      },
    })

    const agent = new Agent({ interpret, ST, state })
    await agent.run('프로젝트 이름이 뭐야?')

    assert(capturedMessages != null, 'memory context: messages captured')
    const systemMsg = capturedMessages.find(m => m.role === 'system')
    assert(systemMsg && systemMsg.content.includes('presence'), 'memory context: memory included in system prompt')
  }

  // =============================================
  // 16. RESPOND message 직접 전달 (ref 없이)
  // =============================================
  {
    const state = initState()
    let plannerCall = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        plannerCall++
        if (plannerCall === 1) {
          return JSON.stringify({
            type: 'plan',
            steps: [
              { op: 'RESPOND', args: { message: '직접 메시지입니다' } },
            ]
          })
        }
        return '포매팅된 결과'
      },
    })

    const agent = new Agent({ interpret, ST, state })
    await agent.run('테스트')

    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'RESPOND message: success')
  }

  // =============================================
  // 17. DELEGATE + APPROVE 포함 플랜
  // =============================================
  {
    const state = initState()
    let plannerCall = 0
    const approvals = []
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        plannerCall++
        if (plannerCall === 1) {
          return JSON.stringify({
            type: 'plan',
            steps: [
              { op: 'APPROVE', args: { description: '파일 쓰기 승인' } },
              { op: 'EXEC', args: { tool: 'file_write', tool_args: { path: 'out.txt', content: 'data' } } },
              { op: 'RESPOND', args: { ref: 2 } },
            ]
          })
        }
        return '파일을 작성했습니다.'
      },
      Approve: (op) => {
        approvals.push(op.description)
        return true
      },
    })

    const agent = new Agent({ resolveTools: () => tools, interpret, ST, state })
    await agent.run('파일 작성해줘')

    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'approve flow: success')
    assert(approvals.length === 1, 'approve flow: approval requested')
    assert(approvals[0] === '파일 쓰기 승인', 'approve flow: correct description')
  }

  // =============================================
  // 18. 도구 예외: 에러가 결과 문자열로 캡처되어 턴 계속 진행
  // =============================================
  {
    const state = initState()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({
        type: 'plan',
        steps: [
          { op: 'EXEC', args: { tool: 'crash_tool', tool_args: {} } },
          { op: 'RESPOND', args: { ref: 1 } },
        ]
      }),
      ExecuteTool: () => { throw new Error('tool crashed at runtime') },
    })

    const agent = new Agent({ interpret, ST, state })
    const result = await agent.run('크래시 유발')

    assert(state.get('turnState').tag === PHASE.IDLE, 'tool error: turnState idle')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'tool error: turn succeeds with error result')
    assert(typeof result === 'string' && result.includes('[ERROR]'), 'tool error: result contains error string')
    assert(result.includes('tool crashed at runtime'), 'tool error: error message preserved')
  }

  // =============================================
  // 19. responseFormat이 AskLLM에 전달되는지 확인
  // =============================================
  {
    const state = initState()
    let capturedFormat = null
    const { interpret, ST } = createTestInterpreter({
      AskLLM: (op) => {
        if (!capturedFormat) capturedFormat = op.responseFormat
        return JSON.stringify({ type: 'direct_response', message: 'ok' })
      },
    })

    const agent = new Agent({ interpret, ST, state })
    await agent.run('test')

    assert(capturedFormat != null, 'responseFormat: captured')
    assert(capturedFormat.type === 'json_object', 'responseFormat: default is json_object')
  }

  // =============================================
  // 20. responseFormatMode=none → responseFormat 없음
  // =============================================
  {
    const state = initState()
    let capturedFormat = 'not-set'
    const { interpret, ST } = createTestInterpreter({
      AskLLM: (op) => {
        if (capturedFormat === 'not-set') capturedFormat = op.responseFormat
        return JSON.stringify({ type: 'direct_response', message: 'ok' })
      },
    })

    const agent = new Agent({ responseFormatMode: 'none', interpret, ST })
    await runFreeWithStateT(interpret, ST)(agent.planner.program('test'))({})

    assert(capturedFormat === undefined, 'responseFormat none: no format sent')
  }

  // Cleanup
  rmSync(testDir, { recursive: true, force: true })

  summary()
}

run()
