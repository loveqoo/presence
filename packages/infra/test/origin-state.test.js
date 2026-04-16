import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { assert, summary } from '../../../test/lib/assert.js'

function run() {
  console.log('createOriginState tests')

  // 1. set triggers hook synchronously (new contract: (change, state))
  const s1 = createOriginState({ x: 0 })
  let hookChange = null
  s1.hooks.on('x', (change) => { hookChange = change })
  s1.set('x', 42)
  assert(hookChange.path === 'x', 'change.path')
  assert(hookChange.prevValue === 0, 'change.prevValue')
  assert(hookChange.nextValue === 42, 'change.nextValue')

  // 2. Hook inside hook: set('y') triggers y's hook (sync re-entrant)
  const s2 = createOriginState()
  let yFired = false
  s2.hooks.on('x', (change, state) => { state.set('y', change.nextValue * 2) })
  s2.hooks.on('y', (change) => { yFired = change.nextValue })
  s2.set('x', 5)
  assert(s2.get('y') === 10, 'hook-in-hook: x hook sets y')
  assert(yFired === 10, 'hook-in-hook: y hook fires')

  // 3. No hooks registered: set works normally
  const s3 = createOriginState({ a: 1 })
  s3.set('a', 2)
  assert(s3.get('a') === 2, 'no hooks: set works without hooks')

  // 4. snapshot in hook reflects current state
  const s4 = createOriginState({ status: 'idle', turn: 0 })
  let snapInHook = null
  s4.hooks.on('status', (_change, state) => { snapInHook = state.snapshot() })
  s4.set('status', 'working')
  assert(snapInHook.status === 'working', 'snapshot in hook reflects current state')

  // 5. get with dot notation
  const s5 = createOriginState({ a: { b: 1 } })
  assert(s5.get('a.b') === 1, 'get with dot notation')

  // 6. async hook is fire-and-forget (does not block set)
  const s6 = createOriginState({ v: 0 })
  let asyncDone = false
  s6.hooks.on('v', async () => {
    await new Promise(r => setTimeout(r, 10))
    asyncDone = true
  })
  s6.set('v', 1)
  assert(asyncDone === false, 'async hook: set returns before async work completes')

  // 7. change carries prevValue/nextValue only (prevRoot/nextRoot 제거 — GC 리스크 해소)
  const s7 = createOriginState({ a: { b: 1 }, c: { d: 2 } })
  let changeNoPrevRoot = null
  s7.hooks.on('a.b', (change) => { changeNoPrevRoot = change })
  s7.set('a.b', 99)
  assert(changeNoPrevRoot.prevValue === 1, 'prevValue preserved')
  assert(changeNoPrevRoot.nextValue === 99, 'nextValue reflects new value')
  assert(changeNoPrevRoot.prevRoot === undefined, 'prevRoot removed from StateChange')
  assert(changeNoPrevRoot.nextRoot === undefined, 'nextRoot removed from StateChange')

  summary()
}

run()
