import { initI18n } from '../../src/i18n/index.js'
initI18n('ko')
import { createReactLoop, createReactTurn, appendToolRound, buildInitialMessages, classifyResponse } from '../../src/core/react.js'
import { safeRunTurn, PHASE, RESULT, ERROR_KIND, Phase } from '../../src/core/agent.js'
import { createTestInterpreter } from '../../src/interpreter/test.js'
import { createReactiveState } from '../../src/infra/state.js'
import { Free, Either } from '../../src/core/op.js'

const initState = () =>
  createReactiveState({ turnState: Phase.idle(), lastTurn: null, turn: 0, context: { memories: [] } })

// tool call 응답 헬퍼
const toolCall = (id, name, args = {}) => ({
  type: 'tool_calls',
  toolCalls: [{
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }],
})

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

async function run() {
  console.log('ReAct loop tests')

  // ===========================================
  // appendToolRound 단위 테스트
  // ===========================================

  {
    const msgs = [{ role: 'user', content: 'hi' }]
    const tc = [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } }]
    const result = appendToolRound(msgs, tc, 'sunny')

    assert(result.length === 3, 'appendToolRound: 3 messages')
    assert(result[1].role === 'assistant', 'appendToolRound: assistant message')
    assert(result[1].tool_calls === tc, 'appendToolRound: tool_calls attached')
    assert(result[2].role === 'tool', 'appendToolRound: tool message')
    assert(result[2].tool_call_id === 'c1', 'appendToolRound: tool_call_id')
    assert(result[2].content === 'sunny', 'appendToolRound: string result')
  }

  {
    const tc = [{ id: 'c2', type: 'function', function: { name: 'calc', arguments: '{}' } }]
    const result = appendToolRound([], tc, { total: 42 })
    assert(result[1].content === '{"total":42}', 'appendToolRound: object result JSON-serialized')
  }

  // ===========================================
  // classifyResponse 단위 테스트
  // ===========================================

  {
    const r1 = classifyResponse('hello')
    assert(Either.isRight(r1), 'classifyResponse: string → Right')
    assert(r1.value === 'hello', 'classifyResponse: string value preserved')
  }

  {
    const r2 = classifyResponse({ type: 'tool_calls', toolCalls: [
      { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }
    ]})
    assert(r2 === null, 'classifyResponse: valid single tool_call → null (continue)')
  }

  {
    const r3 = classifyResponse({ type: 'tool_calls', toolCalls: [] })
    assert(Either.isLeft(r3), 'classifyResponse: empty toolCalls → Left')
    assert(r3.value.kind === ERROR_KIND.REACT_MULTI_TOOL, 'classifyResponse: empty toolCalls error kind')
  }

  {
    const r4 = classifyResponse({ type: 'tool_calls', toolCalls: [
      { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
      { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
    ]})
    assert(Either.isLeft(r4), 'classifyResponse: multi toolCalls → Left')
  }

  // ===========================================
  // createReactLoop 단위 테스트
  // ===========================================

  // 1. 도구 없이 직접 답변 → 1회 호출로 종료
  {
    const state = initState()
    const { interpreter, log } = createTestInterpreter({
      AskLLM: () => '안녕하세요!'
    }, state)

    const loop = createReactLoop()
    const outcome = await Free.runWithTask(interpreter)(loop('안녕'))

    assert(Either.isRight(outcome), 'direct answer: Right')
    assert(outcome.value === '안녕하세요!', 'direct answer: value')
    assert(log.filter(l => l.tag === 'AskLLM').length === 1, 'direct answer: 1 LLM call')
  }

  // 2. 도구 1회 호출 후 답변
  {
    const state = initState()
    let n = 0
    const { interpreter, log } = createTestInterpreter({
      AskLLM: () => {
        n++
        if (n === 1) return toolCall('c1', 'weather', { city: 'Seoul' })
        return '서울은 맑음입니다.'
      },
      ExecuteTool: (op) => `${op.name}: sunny`,
    }, state)

    const loop = createReactLoop({ tools: [{ name: 'weather' }] })
    const outcome = await Free.runWithTask(interpreter)(loop('날씨'))

    assert(Either.isRight(outcome), 'single tool: Right')
    assert(outcome.value === '서울은 맑음입니다.', 'single tool: final answer')
    assert(log.filter(l => l.tag === 'AskLLM').length === 2, 'single tool: 2 LLM calls')
    assert(log.filter(l => l.tag === 'ExecuteTool').length === 1, 'single tool: 1 tool call')
  }

  // 3. 도구 여러 번 호출 (2 iterations) 후 답변
  {
    const state = initState()
    let n = 0
    const { interpreter } = createTestInterpreter({
      AskLLM: () => {
        n++
        if (n === 1) return toolCall('c1', 'search', { q: 'PR' })
        if (n === 2) return toolCall('c2', 'format', { data: 'raw' })
        return '정리된 결과입니다.'
      },
      ExecuteTool: (op) => `${op.name}-result`,
    }, state)

    const loop = createReactLoop({ tools: [{ name: 'search' }, { name: 'format' }] })
    const outcome = await Free.runWithTask(interpreter)(loop('PR 정리'))

    assert(Either.isRight(outcome), 'multi iteration: Right')
    assert(outcome.value === '정리된 결과입니다.', 'multi iteration: final answer')
    assert(n === 3, 'multi iteration: 3 LLM calls')
  }

  // 4. maxSteps 초과 → 실패
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({
      AskLLM: () => toolCall('c1', 'loop_tool', {}),
      ExecuteTool: () => 'still going',
    }, state)

    const loop = createReactLoop({ maxSteps: 3 })
    const outcome = await Free.runWithTask(interpreter)(loop('무한루프'))

    assert(Either.isLeft(outcome), 'maxSteps: Left')
    assert(outcome.value.kind === ERROR_KIND.REACT_MAX_STEPS, 'maxSteps: correct error kind')
  }

  // 5. toolCalls 2개 이상 → 명시적 실패
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({
      AskLLM: () => ({
        type: 'tool_calls',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      }),
    }, state)

    const loop = createReactLoop()
    const outcome = await Free.runWithTask(interpreter)(loop('test'))

    assert(Either.isLeft(outcome), 'multi tool: Left')
    assert(outcome.value.kind === ERROR_KIND.REACT_MULTI_TOOL, 'multi tool: correct error kind')
    assert(outcome.value.message.includes('2'), 'multi tool: error mentions count')
  }

  // 6. toolCalls가 빈 배열 → 명시적 실패
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({
      AskLLM: () => ({ type: 'tool_calls', toolCalls: [] }),
    }, state)

    const loop = createReactLoop()
    const outcome = await Free.runWithTask(interpreter)(loop('test'))

    assert(Either.isLeft(outcome), 'empty toolCalls: Left')
    assert(outcome.value.kind === ERROR_KIND.REACT_MULTI_TOOL, 'empty toolCalls: correct error kind')
  }

  // ===========================================
  // createReactTurn 상태 전이 테스트
  // ===========================================

  // 성공 턴 → turnState=idle, lastTurn=success
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({
      AskLLM: () => '답변입니다.'
    }, state)

    const turn = createReactTurn()
    const result = await Free.runWithTask(interpreter)(turn('질문'))

    assert(result === '답변입니다.', 'success turn: returns result')
    assert(state.get('turnState').tag === PHASE.IDLE, 'success turn: turnState idle')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'success turn: lastTurn success')
    assert(state.get('lastTurn').input === '질문', 'success turn: input preserved')
  }

  // 실패 턴 (maxSteps) → turnState=idle, lastTurn=failure
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({
      AskLLM: () => toolCall('c1', 'x', {}),
      ExecuteTool: () => 'r',
    }, state)

    const turn = createReactTurn({ maxSteps: 2 })
    const result = await Free.runWithTask(interpreter)(turn('test'))

    assert(state.get('turnState').tag === PHASE.IDLE, 'maxSteps turn: turnState idle')
    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'maxSteps turn: lastTurn failure')
    assert(state.get('lastTurn').error.kind === ERROR_KIND.REACT_MAX_STEPS, 'maxSteps turn: error kind')
    assert(typeof result === 'string' && result.includes('오류'), 'maxSteps turn: error response')
  }

  // 실패 턴 (multi-tool) → turnState=idle, lastTurn=failure
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({
      AskLLM: () => ({
        type: 'tool_calls',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      }),
    }, state)

    const turn = createReactTurn()
    const result = await Free.runWithTask(interpreter)(turn('test'))

    assert(state.get('lastTurn').tag === RESULT.FAILURE, 'multi-tool turn: lastTurn failure')
    assert(state.get('lastTurn').error.kind === ERROR_KIND.REACT_MULTI_TOOL, 'multi-tool turn: error kind')
  }

  // tool 실행 실패 → safeRunTurn이 잡음
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({
      AskLLM: () => toolCall('c1', 'broken', {}),
      ExecuteTool: () => { throw new Error('tool crashed') },
    }, state)

    const turn = createReactTurn()
    const safe = safeRunTurn(interpreter, state)
    try {
      await safe(turn('test'), 'test')
      assert(false, 'tool failure: should throw')
    } catch (e) {
      assert(state.get('turnState').tag === PHASE.IDLE, 'tool failure: turnState idle')
      assert(state.get('lastTurn').tag === RESULT.FAILURE, 'tool failure: lastTurn failure')
      assert(state.get('lastTurn').error.kind === ERROR_KIND.INTERPRETER, 'tool failure: error kind')
      assert(e.message === 'tool crashed', 'tool failure: original error propagated')
    }
  }

  // LLM 호출 실패 → safeRunTurn이 잡음
  {
    const state = initState()
    const { interpreter } = createTestInterpreter({
      AskLLM: () => { throw new Error('LLM down') },
    }, state)

    const turn = createReactTurn()
    const safe = safeRunTurn(interpreter, state)
    try {
      await safe(turn('test'), 'test')
      assert(false, 'LLM failure: should throw')
    } catch (e) {
      assert(state.get('turnState').tag === PHASE.IDLE, 'LLM failure: turnState idle')
      assert(state.get('lastTurn').error.kind === ERROR_KIND.INTERPRETER, 'LLM failure: error kind')
    }
  }

  // beginTurn → turnState=working 확인
  {
    const state = initState()
    let sawWorking = false
    state.hooks.on('turnState', (phase) => {
      if (phase.tag === PHASE.WORKING) sawWorking = true
    })

    const { interpreter } = createTestInterpreter({
      AskLLM: () => 'ok'
    }, state)

    const turn = createReactTurn()
    await Free.runWithTask(interpreter)(turn('test'))
    await new Promise(r => setTimeout(r, 50))

    assert(sawWorking, 'react turn: beginTurn fires working')
  }

  // ===========================================
  // 메모리 통합 테스트
  // ===========================================

  // buildInitialMessages: 메모리가 있으면 system 메시지로 포함
  {
    const msgs = buildInitialMessages('질문', ['회의 정보', 'PR 현황'])
    assert(msgs.length === 2, 'buildInitialMessages: 2 messages (system + user)')
    assert(msgs[0].role === 'system', 'buildInitialMessages: first is system')
    assert(msgs[0].content.includes('회의 정보'), 'buildInitialMessages: includes memory 1')
    assert(msgs[0].content.includes('PR 현황'), 'buildInitialMessages: includes memory 2')
    assert(msgs[1].role === 'user', 'buildInitialMessages: second is user')
    assert(msgs[1].content === '질문', 'buildInitialMessages: user content')
  }

  // buildInitialMessages: 메모리가 비어있으면 system 메시지 없음
  {
    const msgs = buildInitialMessages('질문', [])
    assert(msgs.length === 1, 'buildInitialMessages empty: 1 message (user only)')
    assert(msgs[0].role === 'user', 'buildInitialMessages empty: user only')
  }

  // createReactLoop: 메모리가 첫 askLLM 호출 messages에 포함됨
  {
    const state = initState()
    let capturedMessages = null
    const { interpreter } = createTestInterpreter({
      AskLLM: (op) => {
        if (!capturedMessages) capturedMessages = op.messages
        return '답변'
      }
    }, state)

    const loop = createReactLoop()
    await Free.runWithTask(interpreter)(loop('질문', ['기억1', '기억2']))

    assert(capturedMessages.length === 2, 'loop with memories: 2 messages sent to LLM')
    assert(capturedMessages[0].role === 'system', 'loop with memories: system message first')
    assert(capturedMessages[0].content.includes('기억1'), 'loop with memories: memory included')
  }

  // createReactTurn: context.memories가 LLM에 전달됨 (회귀 방지)
  {
    const state = initState()
    state.set('context.memories', ['과거 대화', '중요 정보'])

    let capturedMessages = null
    const { interpreter } = createTestInterpreter({
      AskLLM: (op) => {
        if (!capturedMessages) capturedMessages = op.messages
        return '메모리 기반 답변'
      }
    }, state)

    const turn = createReactTurn()
    await Free.runWithTask(interpreter)(turn('질문'))

    assert(capturedMessages[0].role === 'system', 'react turn memories: system message')
    assert(capturedMessages[0].content.includes('과거 대화'), 'react turn memories: memory 1 passed to LLM')
    assert(capturedMessages[0].content.includes('중요 정보'), 'react turn memories: memory 2 passed to LLM')
  }

  // createReactTurn: context.memories가 비어있으면 system 메시지 없이 user만
  {
    const state = initState()
    let capturedMessages = null
    const { interpreter } = createTestInterpreter({
      AskLLM: (op) => {
        if (!capturedMessages) capturedMessages = op.messages
        return '답변'
      }
    }, state)

    const turn = createReactTurn()
    await Free.runWithTask(interpreter)(turn('질문'))

    assert(capturedMessages.length === 1, 'react turn no memories: 1 message')
    assert(capturedMessages[0].role === 'user', 'react turn no memories: user only')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
