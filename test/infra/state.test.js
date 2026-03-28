import { createState } from '@presence/infra/infra/state.js'
import { assert, summary } from '../lib/assert.js'

console.log('createState tests')

// 1. Basic set/get
const s1 = createState()
s1.set('a', 1)
assert(s1.get('a') === 1, 'set/get simple key')

// 2. Nested path
s1.set('a.b.c', 42)
assert(s1.get('a.b.c') === 42, 'set/get nested path')

// 3. Nested path creates intermediate objects
const s2 = createState()
s2.set('x.y.z', 'deep')
assert(s2.get('x.y.z') === 'deep', 'creates intermediate objects')
assert(typeof s2.get('x.y') === 'object', 'intermediate is object')

// 4. Snapshot returns deep copy
const s3 = createState({ a: { b: 1 } })
const snap = s3.snapshot()
snap.a.b = 999
assert(s3.get('a.b') === 1, 'snapshot is deep copy (original unchanged)')

// 5. Non-existent path returns undefined
assert(s3.get('x.y.z') === undefined, 'non-existent path returns undefined')

// 6. Initial state preserved
const s4 = createState({ status: 'idle', turn: 0 })
assert(s4.get('status') === 'idle', 'initial state: status')
assert(s4.get('turn') === 0, 'initial state: turn')

// 7. Overwrite existing value
s4.set('status', 'working')
assert(s4.get('status') === 'working', 'overwrite existing value')

// 8. get with no args returns full state copy
const s5 = createState({ a: 1, b: { c: 2 } })
const full = s5.get()
assert(full.a === 1 && full.b.c === 2, 'get() returns full state')
full.a = 999
assert(s5.get('a') === 1, 'get() returns deep copy')

summary()
