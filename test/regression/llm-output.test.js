/**
 * LLM Malformed Output 카탈로그
 * 실제 로컬 모델 테스트 중 발견된 패턴들.
 * 각 케이스는 시스템이 크래시 없이 실패 처리해야 함.
 */
import { initI18n } from '@presence/infra/i18n'
initI18n('ko')
import { createAgentTurn, createAgent, PHASE, RESULT, Phase } from '@presence/core/core/agent.js'
import { createTestInterpreter } from '@presence/core/interpreter/test.js'
import { createReactiveState } from '@presence/infra/infra/state.js'
import { createLocalTools } from '@presence/infra/infra/local-tools.js'
import { createToolRegistry } from '@presence/infra/infra/tools.js'
import { runFreeWithStateT } from '@presence/core/core/op.js'

import { assert, summary } from '../lib/assert.js'

const initState = () =>
  createReactiveState({ turnState: Phase.idle(), lastTurn: null, turn: 0, context: { memories: [] } })

const tools = createLocalTools({ allowedDirs: ['/tmp/test'] })
const toolRegistry = createToolRegistry()
for (const t of tools) toolRegistry.register(t)

async function run() {
  console.log('LLM malformed output regression tests')

  // 각 케이스: mock LLM이 malformed 응답 → 시스템이 안전하게 실패 처리

  const testMalformed = async (label, llmResponse) => {
    const state = initState()
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => typeof llmResponse === 'string' ? llmResponse : JSON.stringify(llmResponse),
    })
    const agent = createAgent({ interpret, ST, state, tools: toolRegistry.list() })
    await agent.run('test')
    const lt = state.get('lastTurn')
    assert(state.get('turnState').tag === PHASE.IDLE, `${label}: turnState idle`)
    assert(lt != null, `${label}: lastTurn set`)
    return lt
  }

  // === 1. JSON 구조 문제 ===

  await testMalformed('invalid JSON', 'NOT VALID JSON {{{')
  await testMalformed('JSON with trailing text', '{"type":"direct_response","message":"hi"} extra text')
  await testMalformed('empty string', '')
  await testMalformed('markdown wrapped', '```json\n{"type":"direct_response","message":"hi"}\n```')
  await testMalformed('null string', 'null')
  await testMalformed('number string', '42')

  // === 2. 필드명 오류 ===

  await testMalformed('content instead of message',
    { type: 'direct_response', content: 'hello' })
  await testMalformed('response instead of message',
    { type: 'direct_response', response: 'hello' })
  await testMalformed('text instead of message',
    { type: 'direct_response', text: 'hello' })
  await testMalformed('message is number',
    { type: 'direct_response', message: 42 })
  await testMalformed('message is null',
    { type: 'direct_response', message: null })
  await testMalformed('message is array',
    { type: 'direct_response', message: ['hello'] })

  // === 3. type 오류 ===

  await testMalformed('type=tool_calls',
    { type: 'tool_calls', toolCalls: [] })
  await testMalformed('type=response',
    { type: 'response', message: 'hi' })
  await testMalformed('type missing',
    { message: 'hi' })
  await testMalformed('type is number',
    { type: 1, message: 'hi' })

  // === 4. plan step 오류 ===

  await testMalformed('step without op',
    { type: 'plan', steps: [{ args: { tool: 'file_read' } }] })
  await testMalformed('step op is number',
    { type: 'plan', steps: [{ op: 1 }] })
  await testMalformed('unknown op',
    { type: 'plan', steps: [{ op: 'UNKNOWN_OP', args: {} }] })
  await testMalformed('empty steps',
    { type: 'plan', steps: [] })
  await testMalformed('steps is string',
    { type: 'plan', steps: 'EXEC file_read' })

  // === 5. EXEC tool_args 오류 (실제 발견) ===

  await testMalformed('EXEC without tool_args',
    { type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'file_read' } },
      { op: 'RESPOND', args: { ref: 1 } },
    ]})
  await testMalformed('EXEC args flat (tool_args 밖)',
    { type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'shell_exec', command: 'ls' } },
      { op: 'RESPOND', args: { ref: 1 } },
    ]})
  await testMalformed('EXEC tool is number',
    { type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 123 } },
    ]})

  // === 6. RESPOND ref 오류 (실제 발견) ===

  await testMalformed('RESPOND ref=0',
    { type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
      { op: 'RESPOND', args: { ref: 0 } },
    ]})
  await testMalformed('RESPOND ref exceeds steps',
    { type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
      { op: 'RESPOND', args: { ref: 3 } },
    ]})
  await testMalformed('RESPOND ref is string',
    { type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
      { op: 'RESPOND', args: { ref: 'first' } },
    ]})
  await testMalformed('RESPOND ref negative',
    { type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
      { op: 'RESPOND', args: { ref: -1 } },
    ]})
  await testMalformed('RESPOND without ref or message',
    { type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
      { op: 'RESPOND', args: {} },
    ]})

  // === 7. ASK_LLM ctx 오류 ===

  await testMalformed('ASK_LLM ctx is string',
    { type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
      { op: 'ASK_LLM', args: { prompt: 'summarize', ctx: '1' } },
      { op: 'RESPOND', args: { ref: 2 } },
    ]})
  await testMalformed('ASK_LLM ctx has zero',
    { type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
      { op: 'ASK_LLM', args: { prompt: 'summarize', ctx: [0] } },
      { op: 'RESPOND', args: { ref: 2 } },
    ]})
  await testMalformed('ASK_LLM ctx exceeds steps',
    { type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
      { op: 'ASK_LLM', args: { prompt: 'summarize', ctx: [99] } },
      { op: 'RESPOND', args: { ref: 2 } },
    ]})
  await testMalformed('ASK_LLM ctx self-reference',
    { type: 'plan', steps: [
      { op: 'ASK_LLM', args: { prompt: 'think', ctx: [1] } },
      { op: 'RESPOND', args: { ref: 1 } },
    ]})

  // === 8. 복합 오류 ===

  await testMalformed('valid JSON but not object',
    [1, 2, 3])
  await testMalformed('nested invalid',
    { type: 'plan', steps: [{ op: 'EXEC', args: null }] })

  summary()
}

run()
