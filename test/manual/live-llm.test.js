/**
 * 실제 LLM (로컬 MLX 서버) 기반 E2E 테스트
 * incremental planning engine의 실제 동작을 검증.
 *
 * 요구사항: http://127.0.0.1:8045/v1 에 LLM 서버가 실행 중이어야 함
 */
import { initI18n } from '@presence/infra/i18n'
initI18n('ko')
import { Config } from '@presence/infra/infra/config.js'
import { LLMClient } from '@presence/infra/infra/llm.js'
import { prodInterpreterR } from '@presence/infra/interpreter/prod.js'
import { PHASE, RESULT, TurnState } from '@presence/core/core/policies.js'
import { Agent } from '@presence/core/core/agent.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { createLocalTools } from '@presence/infra/infra/tools/local-tools.js'
import { createToolRegistry } from '@presence/infra/infra/tools/tool-registry.js'
import { createAgentRegistry } from '@presence/infra/infra/agents/agent-registry.js'
import { Free } from '@presence/core/core/op.js'

import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// --- 테스트 디렉토리 설정 ---
const testDir = join(tmpdir(), `presence-live-${Date.now()}`)
mkdirSync(testDir, { recursive: true })
writeFileSync(join(testDir, 'hello.txt'), 'Hello from presence!')
writeFileSync(join(testDir, 'numbers.txt'), '1\n2\n3\n4\n5')
mkdirSync(join(testDir, 'subdir'))
writeFileSync(join(testDir, 'subdir', 'nested.txt'), 'nested file content')

// --- 인프라 구성 ---
const config = Config.loadUserMerged(process.env.PRESENCE_USERNAME || 'default')
const llm = new LLMClient({
  baseUrl: config.llm.baseUrl,
  model: config.llm.model,
  apiKey: config.llm.apiKey,
})

const toolRegistry = createToolRegistry()
const localTools = createLocalTools({ allowedDirs: [testDir] })
for (const t of localTools) toolRegistry.register(t)

const agentRegistry = createAgentRegistry()

const initState = () =>
  createOriginState({
    turnState: TurnState.idle(),
    lastTurn: null,
    turn: 0,
    context: { memories: [], conversationHistory: [] },
  })

let passed = 0
let failed = 0
let skipped = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

const runScenario = async (label, input, opts = {}) => {
  const { maxRetries = 2, maxIterations = 5, validate } = opts
  const state = initState()
  const { interpret, ST } = prodInterpreterR.run({
    llm, toolRegistry, state, agentRegistry,
    onApprove: async () => true,  // 자동 승인
  })

  const agent = new Agent({
    resolveTools: () => toolRegistry.list(),
    resolveAgents: () => agentRegistry.list(),
    responseFormatMode: config.llm.responseFormat,
    maxRetries,
    maxIterations,
    interpret,
    ST,
    state,
  })

  console.log(`\n  [${label}] input: "${input}"`)

  try {
    const result = await agent.run(input)
    const lt = state.get('lastTurn')

    console.log(`  [${label}] result: ${typeof result === 'string' ? result.slice(0, 200) : JSON.stringify(result).slice(0, 200)}`)
    console.log(`  [${label}] status: ${lt?.tag}, turnState: ${state.get('turnState').tag}`)

    assert(state.get('turnState').tag === PHASE.IDLE, `${label}: turnState idle`)

    if (validate) {
      validate({ result, state, lt })
    } else {
      // 기본: 성공이고 결과가 있어야 함
      assert(lt?.tag === RESULT.SUCCESS, `${label}: success`)
      assert(result != null, `${label}: result not null`)
    }

    return { result, state, lt }
  } catch (err) {
    console.error(`  [${label}] ERROR: ${err.message}`)
    const lt = state.get('lastTurn')
    assert(state.get('turnState').tag === PHASE.IDLE, `${label}: turnState idle after error`)

    if (validate) {
      validate({ result: null, state, lt, error: err })
    } else {
      assert(false, `${label}: unexpected error: ${err.message}`)
    }

    return { result: null, state, lt, error: err }
  }
}

async function run() {
  console.log('=== Live LLM E2E Tests ===')
  console.log(`  LLM: ${config.llm.baseUrl} / ${config.llm.model}`)
  console.log(`  Test dir: ${testDir}`)
  console.log(`  Tools: ${toolRegistry.list().map(t => t.name).join(', ')}`)

  // =============================================
  // 1. 단순 인사 → direct_response
  // =============================================
  await runScenario('인사', '안녕하세요', {
    validate: ({ result, lt }) => {
      assert(lt?.tag === RESULT.SUCCESS, '인사: success')
      assert(typeof result === 'string' && result.length > 0, '인사: non-empty string response')
    }
  })

  // =============================================
  // 2. 파일 목록 조회 → EXEC file_list (iteration)
  // =============================================
  await runScenario('파일목록', `${testDir} 디렉토리의 파일 목록을 보여주세요`, {
    validate: ({ result, lt }) => {
      assert(lt?.tag === RESULT.SUCCESS, '파일목록: success')
      assert(typeof result === 'string', '파일목록: string result')
      // 결과에 파일명이 포함되어야 함
      const hasFiles = result.includes('hello') || result.includes('numbers') || result.includes('subdir')
      assert(hasFiles, '파일목록: contains file names from test dir')
    }
  })

  // =============================================
  // 3. 파일 읽기 → EXEC file_read (iteration 또는 RESPOND)
  // =============================================
  await runScenario('파일읽기', `${join(testDir, 'hello.txt')} 파일을 읽어주세요`, {
    validate: ({ result, lt }) => {
      assert(lt?.tag === RESULT.SUCCESS, '파일읽기: success')
      // 파일 내용이 결과에 포함되어야 함
      const hasContent = typeof result === 'string' && result.includes('Hello')
      assert(hasContent, '파일읽기: contains file content "Hello"')
    }
  })

  // =============================================
  // 4. 계산 → EXEC calculate
  // =============================================
  await runScenario('계산', '123 * 456을 계산해주세요', {
    validate: ({ result, lt }) => {
      assert(lt?.tag === RESULT.SUCCESS, '계산: success')
      const has56088 = typeof result === 'string' && result.includes('56088')
      assert(has56088, '계산: contains correct result 56088')
    }
  })

  // =============================================
  // 5. 다단계 작업: 파일 목록 → 파일 읽기 (iteration)
  // =============================================
  await runScenario('다단계', `${testDir} 디렉토리에서 .txt 파일 목록을 확인하고, hello.txt 파일의 내용을 알려주세요`, {
    validate: ({ result, lt }) => {
      assert(lt?.tag === RESULT.SUCCESS, '다단계: success')
      const hasContent = typeof result === 'string' && result.includes('Hello')
      assert(hasContent, '다단계: final result includes file content')
    }
  })

  // =============================================
  // 6. 일반 지식 질문 → direct_response (도구 불필요)
  // =============================================
  await runScenario('지식질문', '대한민국의 수도는 어디인가요?', {
    validate: ({ result, lt }) => {
      assert(lt?.tag === RESULT.SUCCESS, '지식질문: success')
      const hasSeoul = typeof result === 'string' && result.includes('서울')
      assert(hasSeoul, '지식질문: mentions 서울')
    }
  })

  // =============================================
  // 7. 셸 명령 실행 → EXEC shell_exec
  // =============================================
  await runScenario('셸명령', 'echo "presence test" 명령을 실행해주세요', {
    validate: ({ result, lt }) => {
      assert(lt?.tag === RESULT.SUCCESS, '셸명령: success')
      assert(result != null, '셸명령: result exists')
    }
  })

  // =============================================
  // 8. 잘못된 파일 경로 → 에러 처리
  // =============================================
  await runScenario('잘못된경로', `${join(testDir, 'nonexistent_file_xyz.txt')} 파일을 읽어주세요`, {
    validate: ({ result, lt, state }) => {
      // 에러를 gracefully 처리하면 success (에러 메시지를 답변)
      // 또는 failure로 떨어질 수 있음
      assert(state.get('turnState').tag === PHASE.IDLE, '잘못된경로: turnState idle')
      assert(lt != null, '잘못된경로: lastTurn exists')
    }
  })

  // =============================================
  // 9. 3단계 iteration: 목록 → 읽기 → 분석
  // =============================================
  await runScenario('3단계분석',
    `${testDir} 디렉토리의 파일 목록을 확인하고, numbers.txt 파일을 읽은 다음, 그 숫자들의 합계를 계산해주세요`, {
    validate: ({ result, lt }) => {
      assert(lt?.tag === RESULT.SUCCESS, '3단계분석: success')
      // 1+2+3+4+5 = 15
      const has15 = typeof result === 'string' && result.includes('15')
      assert(has15, '3단계분석: contains sum 15')
    }
  })

  // =============================================
  // 10. 하위 디렉토리 탐색 (iteration: list → list subdir → read)
  // =============================================
  await runScenario('하위디렉토리',
    `${testDir} 디렉토리에서 subdir 폴더 안에 어떤 파일이 있는지 확인하고, 그 파일의 내용을 읽어주세요`, {
    validate: ({ result, lt }) => {
      assert(lt?.tag === RESULT.SUCCESS, '하위디렉토리: success')
      const hasNested = typeof result === 'string' && result.includes('nested')
      assert(hasNested, '하위디렉토리: found nested file content')
    }
  })

  // =============================================
  // 11. 두 파일 비교 (iteration: read A → read B → compare)
  // =============================================
  await runScenario('파일비교',
    `${join(testDir, 'hello.txt')}와 ${join(testDir, 'numbers.txt')} 두 파일을 읽고, 각 파일의 글자 수를 알려주세요`, {
    validate: ({ result, lt }) => {
      assert(lt?.tag === RESULT.SUCCESS, '파일비교: success')
      assert(typeof result === 'string' && result.length > 10, '파일비교: non-trivial response')
    }
  })

  // =============================================
  // 12. 계산 결과를 파일에 쓰기 (APPROVE 포함)
  // =============================================
  await runScenario('계산후쓰기',
    `7 * 8 * 9를 계산하고, 그 결과를 ${join(testDir, 'result.txt')} 파일에 저장해주세요`, {
    validate: ({ result, lt }) => {
      assert(lt?.tag === RESULT.SUCCESS, '계산후쓰기: success')
      // file_write는 APPROVE가 필요 → 자동 승인 설정되어 있음
      // 결과 파일이 존재하는지 또는 성공 응답인지 확인
      assert(result != null, '계산후쓰기: result exists')
    }
  })

  // =============================================
  // 13. 연속 도구 사용: 셸 → 계산 (다른 도구 조합)
  // =============================================
  await runScenario('도구조합',
    `현재 날짜를 date 명령으로 확인하고, 2025년 1월 1일부터 오늘까지 며칠이 지났는지 계산해주세요`, {
    validate: ({ result, lt }) => {
      assert(lt?.tag === RESULT.SUCCESS, '도구조합: success')
      assert(typeof result === 'string' && result.length > 5, '도구조합: meaningful response')
    }
  })

  // =============================================
  // 14. maxIterations=2 제한 + 복잡한 요청
  // =============================================
  await runScenario('iteration제한',
    `${testDir} 디렉토리의 모든 .txt 파일 내용을 읽어주세요`, {
    maxIterations: 2,
    validate: ({ result, lt, state }) => {
      assert(state.get('turnState').tag === PHASE.IDLE, 'iteration제한: turnState idle')
      assert(lt != null, 'iteration제한: lastTurn exists')
      // 2 iteration 안에 끝나면 success, 아니면 failure (둘 다 정상)
      const validOutcome = lt.tag === RESULT.SUCCESS || lt.tag === RESULT.FAILURE
      assert(validOutcome, 'iteration제한: valid outcome (success or max iterations)')
    }
  })

  // =============================================
  // --- 멀티턴 헬퍼 ---
  // =============================================

  const runMultiTurn = async (label, turns, opts = {}) => {
    const { maxRetries = 2, maxIterations = 5, budget, validate, setupState } = opts
    const state = initState()
    if (setupState) setupState(state)
    const { interpret, ST } = prodInterpreterR.run({
      llm, toolRegistry, state, agentRegistry,
      onApprove: async () => true,
    })
    const agent = new Agent({
      resolveTools: () => toolRegistry.list(),
      resolveAgents: () => agentRegistry.list(),
      responseFormatMode: config.llm.responseFormat,
      maxRetries, maxIterations, interpret, ST, state, budget,
    })

    console.log(`\n  [${label}] ${turns.length} turns`)
    const results = []
    for (const { input, source = 'user' } of turns) {
      try {
        const result = await agent.run(input, { source })
        results.push({ input, result, source })
        console.log(`  [${label}] "${input.slice(0, 40)}" → ${String(result).slice(0, 80)}`)
      } catch (err) {
        results.push({ input, result: null, source, error: err })
        console.log(`  [${label}] "${input.slice(0, 40)}" → ERROR: ${err.message}`)
      }
    }
    validate({ results, state, agent })
  }

  // =============================================
  // 15. 멀티턴 대화 — history recall
  // =============================================
  await runMultiTurn('멀티턴recall', [
    { input: '클로저(closure)가 뭔지 설명해줘' },
    { input: '방금 내가 뭐 물어봤지?' },
  ], {
    validate: ({ results, state }) => {
      const history = state.get('context.conversationHistory') || []
      assert(history.length === 2, '멀티턴recall: history.length === 2')
      const r1 = results[1]?.result
      const hasClosure = typeof r1 === 'string' && (r1.includes('클로저') || r1.includes('closure'))
      assert(hasClosure, '멀티턴recall: second turn references closure (history-based)')
    }
  })

  // =============================================
  // 16. history source 필터링
  // =============================================
  await runMultiTurn('source필터', [
    { input: '안녕', source: 'user' },
    { input: 'heartbeat check', source: 'heartbeat' },
    { input: '잘 지내?', source: 'user' },
  ], {
    validate: ({ results, state }) => {
      const history = state.get('context.conversationHistory') || []
      assert(history.length === 2, 'source필터: history.length === 2 (user only)')
      assert(history[0]?.input === '안녕', 'source필터: history[0].input === "안녕"')
      assert(history[1]?.input === '잘 지내?', 'source필터: history[1].input === "잘 지내?"')
    }
  })

  // =============================================
  // 17. 3턴 history 참조 품질
  // =============================================
  await runMultiTurn('3턴참조', [
    { input: '대한민국의 수도는 어디야?' },
    { input: '일본은?' },
    { input: '내가 처음에 어느 나라 수도를 물어봤지?' },
  ], {
    validate: ({ results, state }) => {
      const history = state.get('context.conversationHistory') || []
      assert(history.length === 3, '3턴참조: history.length === 3')
      assert(state.get('lastTurn')?.tag === RESULT.SUCCESS, '3턴참조: lastTurn SUCCESS')
      const r2 = results[2]?.result
      const refersToFirst = typeof r2 === 'string' && (r2.includes('대한민국') || r2.includes('수도'))
      assert(refersToFirst, '3턴참조: third turn references 대한민국 or 수도')
    }
  })

  // =============================================
  // 18. budget 제약 하의 prompt assembly
  // =============================================
  await runMultiTurn('budget제약', [
    { input: '1+1은?' },
    { input: '2+2는?' },
    { input: '3+3은?' },
    { input: '4+4는?' },
    { input: '5+5는?' },
  ], {
    budget: { maxContextChars: 8000, reservedOutputChars: 1500 },
    validate: ({ results, state }) => {
      const debug = state.get('_debug.lastTurn')
      const assembly = debug?.assembly
      if (assembly) {
        assert(assembly.used <= assembly.budget, 'budget제약: used <= budget')
        assert(assembly.historyDropped >= 0, 'budget제약: historyDropped >= 0')
      } else {
        assert(false, 'budget제약: assembly debug info exists')
      }
      const lastTurn = state.get('lastTurn')
      assert(lastTurn?.tag === RESULT.SUCCESS, 'budget제약: last turn succeeded')
    }
  })

  // Cleanup
  rmSync(testDir, { recursive: true, force: true })

  console.log(`\n=== Live LLM Results: ${passed} passed, ${failed} failed, ${skipped} skipped ===`)

  if (failed > 0) {
    console.log('\n⚠ 실패한 테스트가 있습니다. LLM 응답 품질에 따라 결과가 달라질 수 있습니다.')
    process.exit(1)
  }
}

run().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
