import fp from '@presence/core/lib/fun-fp.js'
import { resolveDelegateTarget } from '@presence/infra/infra/agents/resolve-delegate-target.js'
import { assert, summary } from '../../../test/lib/assert.js'

const { Either } = fp

const right = (r) => Either.fold(() => null, v => v, r)
const left = (r) => Either.fold(e => e, () => null, r)

console.log('resolveDelegateTarget tests')

// RDT1. slash 없는 short name + currentUserId → qualify
{
  const r = resolveDelegateTarget('summarizer', { currentUserId: 'anthony' })
  assert(!Either.isLeft(r), 'RDT1: Right')
  assert(right(r) === 'anthony/summarizer', 'RDT1: qualified')
}

// RDT2. slash 포함 (절대 agentId) → pass-through + validate
{
  const r = resolveDelegateTarget('anthony/daily-report', { currentUserId: 'other' })
  assert(right(r) === 'anthony/daily-report', 'RDT2: 절대 agentId (currentUserId 무시)')
}

// RDT3. admin/manager → 절대 그대로
{
  const r = resolveDelegateTarget('admin/manager', { currentUserId: 'anthony' })
  assert(right(r) === 'admin/manager', 'RDT3: admin/manager pass-through')
}

// RDT4. slash 2+ → error
{
  const r = resolveDelegateTarget('a/b/c', { currentUserId: 'test' })
  assert(Either.isLeft(r), 'RDT4: 2 slash → Left')
  assert(/too many slashes/.test(left(r)), 'RDT4: error message')
}

// RDT5. 빈 문자열 / non-string → error
{
  assert(Either.isLeft(resolveDelegateTarget('', {})), 'RDT5a: 빈 문자열')
  assert(Either.isLeft(resolveDelegateTarget(null, {})), 'RDT5b: null')
  assert(Either.isLeft(resolveDelegateTarget(undefined, {})), 'RDT5c: undefined')
  assert(Either.isLeft(resolveDelegateTarget(123, {})), 'RDT5d: number')
}

// RDT6. short name 인데 currentUserId 없음 → error
{
  const r = resolveDelegateTarget('summarizer', {})
  assert(Either.isLeft(r), 'RDT6: currentUserId 없음 → Left')
  assert(/needs currentUserId/.test(left(r)), 'RDT6: error message')
}

// RDT7. reserved username 을 short name 으로 쓰면 reject
{
  const r = resolveDelegateTarget('admin', { currentUserId: 'alice' })
  assert(Either.isLeft(r), 'RDT7: short "admin" → Left')
  assert(/reserved username/.test(left(r)), 'RDT7: error message mentions reserved')
}

// RDT8. invalid agentId 형식 → validation error
{
  const r = resolveDelegateTarget('Alice/default', { currentUserId: 'test' })
  assert(Either.isLeft(r), 'RDT8: uppercase username → Left')
}

// RDT9. invalid short name → qualify 후 validation fail
{
  const r = resolveDelegateTarget('Summarizer', { currentUserId: 'anthony' })
  assert(Either.isLeft(r), 'RDT9: uppercase short name → Left')
}

summary()
