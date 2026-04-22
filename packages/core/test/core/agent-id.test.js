import fp from '@presence/core/lib/fun-fp.js'
import {
  validateAgentNamePart,
  validateAgentId,
  isReservedUsername,
  assertValidAgentId,
  RESERVED_USERNAMES,
} from '@presence/core/core/agent-id.js'
import { assert, summary } from '../../../../test/lib/assert.js'

const { Either } = fp

console.log('Agent ID validation tests')

// --- validateAgentId (fromdocs §3.2 표) ---

const validCases = [
  'anthony/default',
  'a/b',
  'anthony/daily-report',
  'admin/manager',
  'user1/a2',
  'a/b-c',
]

const invalidCases = [
  ['anthony/abc-', 'trailing hyphen'],
  ['anthony/-abc', 'leading hyphen'],
  ['anthony/a--b', 'consecutive hyphens'],
  ['Anthony/default', 'uppercase username'],
  ['anthony/Default', 'uppercase agentName'],
  ['3bot/default', 'digit-leading username'],
  ['anthony', 'no slash'],
  ['a/b/c', 'double slash'],
  ['a_b/default', 'underscore'],
  ['/default', 'empty username'],
  ['anthony/', 'empty agentName'],
]

for (const id of validCases) {
  const r = validateAgentId(id)
  assert(Either.isRight ? Either.isRight(r) : !r.isLeft(), `valid: ${id}`)
}

for (const [id, reason] of invalidCases) {
  const r = validateAgentId(id)
  assert(r.isLeft(), `invalid (${reason}): ${id}`)
}

// --- validateAgentNamePart ---

assert(!validateAgentNamePart('alice').isLeft(), 'name: alice valid')
assert(!validateAgentNamePart('a').isLeft(), 'name: a (single char) valid')
assert(validateAgentNamePart('').isLeft(), 'name: empty invalid')
assert(validateAgentNamePart('Alice').isLeft(), 'name: uppercase invalid')
assert(validateAgentNamePart('alice--bob').isLeft(), 'name: consecutive hyphens invalid')
assert(validateAgentNamePart('a'.repeat(64)).isLeft(), 'name: 64 chars invalid')
assert(!validateAgentNamePart('a'.repeat(63)).isLeft(), 'name: 63 chars valid')

// --- isReservedUsername ---

assert(isReservedUsername('admin') === true, 'admin reserved')
assert(isReservedUsername('alice') === false, 'alice not reserved')
assert(RESERVED_USERNAMES.includes('admin'), 'RESERVED_USERNAMES includes admin')

// --- assertValidAgentId (throw) ---

let thrown = null
try { assertValidAgentId('anthony/default') } catch (e) { thrown = e }
assert(thrown === null, 'assertValidAgentId valid → no throw')

thrown = null
try { assertValidAgentId('invalid') } catch (e) { thrown = e }
assert(thrown && /invalid agentId/.test(thrown.message), 'assertValidAgentId invalid → throw')

// --- 타입 가드 ---

assert(validateAgentId(null).isLeft(), 'null → Left')
assert(validateAgentId(undefined).isLeft(), 'undefined → Left')
assert(validateAgentId(123).isLeft(), 'number → Left')

summary()
