import { createHooks, createState } from '../../src/infra/state.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

async function run() {
  console.log('createHooks tests')

  // 1. Basic registration + firing
  const h1 = createHooks()
  let called = false
  h1.on('a', (val) => { called = val })
  await h1.fire('a', true, null)
  assert(called === true, 'basic: on + fire calls callback')

  // 2. Multiple hooks on same path, order preserved
  const h2 = createHooks()
  const order = []
  h2.on('x', () => order.push(1))
  h2.on('x', () => order.push(2))
  await h2.fire('x', null, null)
  assert(order[0] === 1 && order[1] === 2, 'multiple hooks: both called in order')

  // 3. off: unregister
  const h3 = createHooks()
  let count = 0
  const cb = () => count++
  h3.on('y', cb)
  await h3.fire('y', null, null)
  assert(count === 1, 'off: called before off')
  h3.off('y', cb)
  await h3.fire('y', null, null)
  assert(count === 1, 'off: not called after off')

  // 4. Error isolation: first hook throws, second still runs
  const h4 = createHooks()
  let secondRan = false
  h4.on('err', () => { throw new Error('boom') })
  h4.on('err', () => { secondRan = true })
  await h4.fire('err', null, null)
  assert(secondRan === true, 'error isolation: second hook runs despite first throwing')

  // 5. Async hooks: sequential execution
  const h5 = createHooks()
  const asyncOrder = []
  h5.on('async', async () => {
    await new Promise(r => setTimeout(r, 10))
    asyncOrder.push(1)
  })
  h5.on('async', async () => {
    asyncOrder.push(2)
  })
  await h5.fire('async', null, null)
  assert(asyncOrder[0] === 1 && asyncOrder[1] === 2, 'async hooks: sequential (1 before 2)')

  // 6. Recursion prevention (depth limit)
  const h6 = createHooks()
  const state6 = createState()
  let depth = 0
  h6.on('recurse', async (val, s) => {
    depth++
    await h6.fire('recurse', val, s) // recursive
  })
  await h6.fire('recurse', 1, state6)
  assert(depth === 10, `recursion prevention: depth capped at 10 (got ${depth})`)

  // 7. Wildcard matching
  const h7 = createHooks()
  let wildcardVal = null
  h7.on('events.*', (val) => { wildcardVal = val })
  await h7.fire('events.github', 'pr-data', null)
  assert(wildcardVal === 'pr-data', 'wildcard: events.* matches events.github')

  // Wildcard should NOT match deeper paths
  wildcardVal = null
  await h7.fire('events.github.pr', 'deep', null)
  assert(wildcardVal === null, 'wildcard: events.* does not match events.github.pr')

  // 8. Fire on unregistered path does nothing
  const h8 = createHooks()
  await h8.fire('nothing', 1, null) // should not throw
  assert(true, 'fire on unregistered path: no error')

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
