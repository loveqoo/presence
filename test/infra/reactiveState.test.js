import { createReactiveState } from '@presence/infra/infra/state.js'
import { assert, summary } from '../lib/assert.js'

function run() {
  console.log('createReactiveState tests')

  // 1. set triggers hook synchronously
  const s1 = createReactiveState({ x: 0 })
  let hookValue = null
  s1.hooks.on('x', (val) => { hookValue = val })
  s1.set('x', 42)
  assert(hookValue === 42, 'set triggers hook synchronously')

  // 2. Hook inside hook: set('y') triggers y's hook (sync re-entrant)
  const s2 = createReactiveState()
  let yFired = false
  s2.hooks.on('x', (val, state) => { state.set('y', val * 2) })
  s2.hooks.on('y', (val) => { yFired = val })
  s2.set('x', 5)
  assert(s2.get('y') === 10, 'hook-in-hook: x hook sets y')
  assert(yFired === 10, 'hook-in-hook: y hook fires')

  // 3. No hooks registered: set works normally
  const s3 = createReactiveState({ a: 1 })
  s3.set('a', 2)
  assert(s3.get('a') === 2, 'no hooks: set works without hooks')

  // 4. snapshot in hook reflects current state
  const s4 = createReactiveState({ status: 'idle', turn: 0 })
  let snapInHook = null
  s4.hooks.on('status', (val, state) => { snapInHook = state.snapshot() })
  s4.set('status', 'working')
  assert(snapInHook.status === 'working', 'snapshot in hook reflects current state')

  // 5. get with dot notation
  const s5 = createReactiveState({ a: { b: 1 } })
  assert(s5.get('a.b') === 1, 'get with dot notation')

  // 6. async hook is fire-and-forget (does not block set)
  const s6 = createReactiveState({ v: 0 })
  let asyncDone = false
  s6.hooks.on('v', async () => {
    await new Promise(r => setTimeout(r, 10))
    asyncDone = true
  })
  s6.set('v', 1)
  assert(asyncDone === false, 'async hook: set returns before async work completes')

  summary()
}

run()
