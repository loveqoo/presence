import { createStateCell } from '@presence/infra/infra/states/origin-state.js'
import { assert, summary } from '../../../test/lib/assert.js'

console.log('createStateCell tests')

// 1. Basic apply/get (set은 cell에 없음. apply로 new data 교체)
const s1 = createStateCell()
s1.apply({ a: 1 })
assert(s1.get('a') === 1, 'apply + get simple key')

// 2. Nested path 조회
s1.apply({ a: { b: { c: 42 } } })
assert(s1.get('a.b.c') === 42, 'get nested path')

// 3. Initial input aliasing 차단 (생성 시 1회 clone)
const initialInput = { a: { b: 1 } }
const s2 = createStateCell(initialInput)
initialInput.a.b = 999
assert(s2.get('a.b') === 1, 'mutating initial input does not affect cell')

// 4. Non-existent path returns undefined
assert(s2.get('x.y.z') === undefined, 'non-existent path returns undefined')

// 5. get() returns full state
const s3 = createStateCell({ a: 1, b: { c: 2 } })
const full = s3.get()
assert(full.a === 1 && full.b.c === 2, 'get() returns full state')

// 6. snapshot과 get()은 동일 참조 (apply 전까지 stable)
const s4 = createStateCell({ x: 1 })
const ref1 = s4.snapshot()
assert(s4.get() === ref1, 'snapshot and get share reference between applies')
s4.apply({ x: 2 })
const ref2 = s4.snapshot()
assert(ref2 !== ref1, 'apply swaps internal reference')
assert(ref1.x === 1, 'prior snapshot remains unchanged (immutable cell)')
assert(ref2.x === 2, 'new snapshot reflects latest value')

summary()
