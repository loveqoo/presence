import { makeOp, FUNCTOR, Free } from '@presence/core/core/op.js'

import { assert, summary } from '../lib/assert.js'

console.log('makeOp factory tests')

// 1. Functor Symbol present
const op = makeOp('Test')({ value: 1 })
assert(op[FUNCTOR] === true, 'has Functor Symbol')
assert(op.tag === 'Test', 'has correct tag')
assert(op.value === 1, 'has correct data')

// 2. map applies to next (continuation), not data
const mapped = op.map(x => x * 2)
assert(mapped.value === 1, 'map preserves data (value unchanged)')
assert(mapped.next(10) === 20, 'map transforms continuation (next)')
assert(mapped.tag === 'Test', 'map preserves tag')

// 3. original next is identity
assert(op.next(42) === 42, 'default next is identity')

// 4. map composes: f(g(next(x)))
const double = x => x * 2
const inc = x => x + 1
const composed = op.map(double).map(inc)
assert(composed.next(5) === 11, 'map composes: inc(double(5)) = 11')

// 5. Free.liftF compatibility
const lifted = Free.liftF(makeOp('Test')({ value: 1 }))
assert(Free.isImpure(lifted), 'Free.liftF returns Impure')

// 6. chain works after liftF
const chained = lifted.chain(r => Free.of(r + 100))
assert(Free.isImpure(chained), 'chain returns Impure (still has work to do)')

// 7. Run through Free.runWithTask to verify full round-trip
import fp from '../../src/lib/fun-fp.js'
const { Task } = fp

const runner = (functor) => Task.of(functor.next('result'))
Free.runWithTask(runner)(lifted).then(result => {
  assert(result === 'result', 'Free.runWithTask resolves lifted op')

  // Also test chained
  return Free.runWithTask(runner)(chained)
}).then(result => {
  assert(result === 'result100', 'Free.runWithTask resolves chained op')

  summary()
})
