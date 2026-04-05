import { createHookBus, StateChange } from '@presence/infra/infra/states/state.js'
import { assert, summary } from '../lib/assert.js'

async function run() {
  console.log('createHookBus tests')

  // 테스트용 StateChange 생성 헬퍼
  const mkChange = (path, prevValue, nextValue) => ({ path, prevValue, nextValue })

  // 1. Basic on/publish
  const bus1 = createHookBus()
  let called = false
  bus1.on('a', (change) => { called = change.nextValue })
  bus1.publish(mkChange('a', undefined, true), null)
  assert(called === true, 'basic: on + publish calls handler')

  // 2. Multiple handlers on same path, order preserved
  const bus2 = createHookBus()
  const order = []
  bus2.on('x', () => order.push(1))
  bus2.on('x', () => order.push(2))
  bus2.publish(mkChange('x', null, null), null)
  assert(order[0] === 1 && order[1] === 2, 'multiple handlers: both called in order')

  // 3. off: unregister
  const bus3 = createHookBus()
  let count = 0
  const handler = () => count++
  bus3.on('y', handler)
  bus3.publish(mkChange('y', null, null), null)
  assert(count === 1, 'off: called before off')
  bus3.off('y', handler)
  bus3.publish(mkChange('y', null, null), null)
  assert(count === 1, 'off: not called after off')

  // 4. Error isolation: first handler throws, second still runs
  const bus4 = createHookBus()
  let secondRan = false
  bus4.on('err', () => { throw new Error('boom') })
  bus4.on('err', () => { secondRan = true })
  bus4.publish(mkChange('err', null, null), null)
  assert(secondRan === true, 'error isolation: second handler runs despite first throwing')

  // 5. Sync publish: all handlers called immediately
  const bus5 = createHookBus()
  const syncOrder = []
  bus5.on('sync', () => { syncOrder.push(1) })
  bus5.on('sync', () => { syncOrder.push(2) })
  bus5.publish(mkChange('sync', null, null), null)
  assert(syncOrder[0] === 1 && syncOrder[1] === 2, 'sync publish: both handlers called in order immediately')

  // 5b. Async handlers: fire-and-forget (not awaited)
  const bus5b = createHookBus()
  let asyncDone = false
  bus5b.on('async', async () => {
    await new Promise(r => setTimeout(r, 10))
    asyncDone = true
  })
  bus5b.publish(mkChange('async', null, null), null)
  assert(asyncDone === false, 'async handlers: not awaited (fire-and-forget)')
  await new Promise(r => setTimeout(r, 20))
  assert(asyncDone === true, 'async handlers: completes in background')

  // 6. Recursion prevention (depth limit)
  const bus6 = createHookBus()
  let depth = 0
  bus6.on('recurse', (change, state) => {
    depth++
    bus6.publish(mkChange('recurse', null, change.nextValue), state)
  })
  bus6.publish(mkChange('recurse', null, 1), null)
  assert(depth === 10, `recursion prevention: depth capped at 10 (got ${depth})`)

  // 7. Wildcard matching
  const bus7 = createHookBus()
  let wildcardVal = null
  bus7.on('events.*', (change) => { wildcardVal = change.nextValue })
  bus7.publish(mkChange('events.github', null, 'pr-data'), null)
  assert(wildcardVal === 'pr-data', 'wildcard: events.* matches events.github')

  // Wildcard should NOT match deeper paths
  wildcardVal = null
  bus7.publish(mkChange('events.github.pr', null, 'deep'), null)
  assert(wildcardVal === null, 'wildcard: events.* does not match events.github.pr')

  // 8. Publish on unregistered path does nothing
  const bus8 = createHookBus()
  bus8.publish(mkChange('nothing', null, 1), null)
  assert(true, 'publish on unregistered path: no error')

  // 9. StateChange ADT: full shape
  const change = StateChange('a.b', { a: { b: 1 } }, { a: { b: 2 } })
  assert(change.path === 'a.b', 'StateChange: path')
  assert(change.prevValue === 1, 'StateChange: prevValue')
  assert(change.nextValue === 2, 'StateChange: nextValue')
  assert(change.prevRoot.a.b === 1, 'StateChange: prevRoot')
  assert(change.nextRoot.a.b === 2, 'StateChange: nextRoot')

  summary()
}

run()
