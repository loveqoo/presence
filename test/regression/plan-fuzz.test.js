/**
 * Plan fuzz 테스트
 * 무작위 plan 구조를 validatePlan에 던져 크래시 여부 확인.
 * 모든 입력에 대해 Either.Left 또는 Either.Right를 반환해야 함 (throw 금지).
 */
import { initI18n } from '@presence/infra/i18n'
initI18n('ko')
import { validatePlan, safeJsonParse } from '@presence/core/core/agent.js'
import { Free, Either } from '@presence/core/core/op.js'
import { assert, summary } from '../lib/assert.js'

function run() {
  console.log('Plan fuzz tests')

  // validatePlan은 어떤 입력이든 Either를 반환해야 함 (throw 금지)
  const fuzzValidate = (label, input) => {
    try {
      const result = validatePlan(input)
      assert(Either.isEither(result), `fuzz validate ${label}: returns Either`)
    } catch (e) {
      assert(false, `fuzz validate ${label}: threw ${e.message}`)
    }
  }

  // safeJsonParse도 어떤 입력이든 Either를 반환해야 함
  const fuzzParse = (label, input) => {
    try {
      const result = safeJsonParse(input)
      assert(Either.isEither(result), `fuzz parse ${label}: returns Either`)
    } catch (e) {
      assert(false, `fuzz parse ${label}: threw ${e.message}`)
    }
  }

  // === safeJsonParse fuzz ===

  const parseInputs = [
    ['undefined', undefined],
    ['null', null],
    ['number', 42],
    ['boolean', true],
    ['empty string', ''],
    ['whitespace', '   '],
    ['plain text', 'hello world'],
    ['partial JSON', '{"type":'],
    ['nested braces', '{{{}}}'],
    ['array string', '[1,2,3]'],
    ['valid object', '{"type":"plan"}'],
    ['very long string', 'x'.repeat(100000)],
    ['unicode', '{"type":"직접응답"}'],
    ['null byte', '{"type":"\0"}'],
    ['object input', { already: 'parsed' }],
    ['array input', [1, 2, 3]],
    ['number input', 99],
    ['boolean input', false],
  ]

  for (const [label, input] of parseInputs) {
    fuzzParse(label, input)
  }

  // === validatePlan fuzz ===

  const planInputs = [
    ['undefined', undefined],
    ['null', null],
    ['number', 42],
    ['string', 'hello'],
    ['boolean', true],
    ['empty object', {}],
    ['array', [1, 2]],
    ['empty array', []],
    ['type only', { type: 'plan' }],
    ['type unknown', { type: 'execute' }],
    ['direct_response no message', { type: 'direct_response' }],
    ['direct_response message null', { type: 'direct_response', message: null }],
    ['direct_response message number', { type: 'direct_response', message: 123 }],
    ['direct_response message object', { type: 'direct_response', message: {} }],
    ['plan steps null', { type: 'plan', steps: null }],
    ['plan steps string', { type: 'plan', steps: 'invalid' }],
    ['plan steps empty', { type: 'plan', steps: [] }],
    ['plan step null in array', { type: 'plan', steps: [null] }],
    ['plan step number', { type: 'plan', steps: [42] }],
    ['plan step string', { type: 'plan', steps: ['EXEC'] }],
    ['plan step empty object', { type: 'plan', steps: [{}] }],
    ['plan step op null', { type: 'plan', steps: [{ op: null }] }],
    ['plan step args null', { type: 'plan', steps: [{ op: 'EXEC', args: null }] }],
    ['plan step args string', { type: 'plan', steps: [{ op: 'EXEC', args: 'tool=x' }] }],
    ['deeply nested', { type: 'plan', steps: [{ op: 'EXEC', args: { tool: 'x', tool_args: { a: { b: { c: 1 } } } } }] }],
    ['extra fields', { type: 'plan', steps: [{ op: 'EXEC', args: { tool: 'x', tool_args: {} } }], extra: true, foo: 'bar' }],
    ['prototype pollution attempt', JSON.parse('{"type":"plan","steps":[{"op":"EXEC","args":{"tool":"x","tool_args":{}}}],"__proto__":{"polluted":true}}')],
    // RESPOND가 마지막이 아닌 경우
    ['RESPOND not last', { type: 'plan', steps: [
      { op: 'RESPOND', args: { message: 'hi' } },
      { op: 'EXEC', args: { tool: 'x', tool_args: {} } },
    ]}],
    ['RESPOND first of three', { type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'a', tool_args: {} } },
      { op: 'RESPOND', args: { ref: 1 } },
      { op: 'EXEC', args: { tool: 'b', tool_args: {} } },
    ]}],

    // 유효한 plan (Right여야 함)
    ['valid direct_response', { type: 'direct_response', message: 'hi' }],
    ['valid plan EXEC+RESPOND', { type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
      { op: 'RESPOND', args: { ref: 1 } },
    ]}],
    ['valid plan LOOKUP+RESPOND', { type: 'plan', steps: [
      { op: 'LOOKUP_MEMORY', args: { query: 'test' } },
      { op: 'RESPOND', args: { ref: 1 } },
    ]}],
  ]

  for (const [label, input] of planInputs) {
    fuzzValidate(label, input)
  }

  // 유효한 plan은 Right
  {
    const r1 = validatePlan({ type: 'direct_response', message: 'hello' })
    assert(Either.isRight(r1), 'valid direct_response: Right')

    const r2 = validatePlan({ type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
      { op: 'RESPOND', args: { ref: 1 } },
    ]})
    assert(Either.isRight(r2), 'valid plan: Right')
  }

  // 무효한 plan은 Left
  {
    const r1 = validatePlan(null)
    assert(Either.isLeft(r1), 'null: Left')

    const r2 = validatePlan({ type: 'plan', steps: [{ op: 'RESPOND', args: { ref: 0 } }] })
    assert(Either.isLeft(r2), 'ref=0: Left')

    // RESPOND가 마지막이 아닌 경우 Left
    const r3 = validatePlan({ type: 'plan', steps: [
      { op: 'RESPOND', args: { message: 'mid' } },
      { op: 'EXEC', args: { tool: 'x', tool_args: {} } },
    ]})
    assert(Either.isLeft(r3), 'RESPOND not last: Left')

    // RESPOND가 마지막이면 Right
    const r4 = validatePlan({ type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'x', tool_args: {} } },
      { op: 'RESPOND', args: { ref: 1 } },
    ]})
    assert(Either.isRight(r4), 'RESPOND last: Right')

    // RESPOND 없는 plan도 Right (intermediate)
    const r5 = validatePlan({ type: 'plan', steps: [
      { op: 'EXEC', args: { tool: 'x', tool_args: {} } },
    ]})
    assert(Either.isRight(r5), 'no RESPOND: Right (intermediate plan)')
  }

  summary()
}

run()
