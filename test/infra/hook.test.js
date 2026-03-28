import { createHooks, createState } from '@presence/infra/infra/state.js'
import { assert, summary } from '../lib/assert.js'

async function run() {
  console.log('createHooks tests')

  // 1. Basic registration + firing
  const h1 = createHooks()
  let called = false
  h1.on('a', (val) => { called = val })
  h1.fire('a', true, null)
  assert(called === true, 'basic: on + fire calls callback')

  // 2. Multiple hooks on same path, order preserved
  const h2 = createHooks()
  const order = []
  h2.on('x', () => order.push(1))
  h2.on('x', () => order.push(2))
  h2.fire('x', null, null)
  assert(order[0] === 1 && order[1] === 2, 'multiple hooks: both called in order')

  // 3. off: unregister
  const h3 = createHooks()
  let count = 0
  const cb = () => count++
  h3.on('y', cb)
  h3.fire('y', null, null)
  assert(count === 1, 'off: called before off')
  h3.off('y', cb)
  h3.fire('y', null, null)
  assert(count === 1, 'off: not called after off')

  // 4. Error isolation: first hook throws, second still runs
  const h4 = createHooks()
  let secondRan = false
  h4.on('err', () => { throw new Error('boom') })
  h4.on('err', () => { secondRan = true })
  h4.fire('err', null, null)
  assert(secondRan === true, 'error isolation: second hook runs despite first throwing')

  // 5. Sync fire: all hooks called immediately (async hooks are fire-and-forget)
  const h5 = createHooks()
  const syncOrder = []
  h5.on('sync', () => { syncOrder.push(1) })
  h5.on('sync', () => { syncOrder.push(2) })
  h5.fire('sync', null, null)
  assert(syncOrder[0] === 1 && syncOrder[1] === 2, 'sync fire: both hooks called in order immediately')

  // 5b. Async hooks: fire-and-forget (not awaited)
  const h5b = createHooks()
  let asyncDone = false
  h5b.on('async', async () => {
    await new Promise(r => setTimeout(r, 10))
    asyncDone = true
  })
  h5b.fire('async', null, null) // sync return, async work in background
  assert(asyncDone === false, 'async hooks: not awaited (fire-and-forget)')
  await new Promise(r => setTimeout(r, 20))
  assert(asyncDone === true, 'async hooks: completes in background')

  // 6. Recursion prevention (depth limit)
  const h6 = createHooks()
  const state6 = createState()
  let depth = 0
  h6.on('recurse', (val, s) => {
    depth++
    h6.fire('recurse', val, s) // recursive (sync)
  })
  h6.fire('recurse', 1, state6)
  assert(depth === 10, `recursion prevention: depth capped at 10 (got ${depth})`)

  // 7. Wildcard matching
  const h7 = createHooks()
  let wildcardVal = null
  h7.on('events.*', (val) => { wildcardVal = val })
  h7.fire('events.github', 'pr-data', null)
  assert(wildcardVal === 'pr-data', 'wildcard: events.* matches events.github')

  // Wildcard should NOT match deeper paths
  wildcardVal = null
  h7.fire('events.github.pr', 'deep', null)
  assert(wildcardVal === null, 'wildcard: events.* does not match events.github.pr')

  // 8. Fire on unregistered path does nothing
  const h8 = createHooks()
  h8.fire('nothing', 1, null) // should not throw
  assert(true, 'fire on unregistered path: no error')

  summary()
}

run()
