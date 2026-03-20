import { createReactiveState } from '../../src/infra/state.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

async function run() {
  console.log('createReactiveState tests')

  // 1. set triggers hook automatically
  const s1 = createReactiveState({ x: 0 })
  let hookValue = null
  s1.hooks.on('x', (val) => { hookValue = val })
  s1.set('x', 42)
  // hooks.fire is async, give it a tick
  await new Promise(r => setTimeout(r, 0))
  assert(hookValue === 42, 'set triggers hook with new value')

  // 2. Hook inside hook: set('y') triggers y's hook
  const s2 = createReactiveState()
  let yFired = false
  s2.hooks.on('x', (val, state) => { state.set('y', val * 2) })
  s2.hooks.on('y', (val) => { yFired = val })
  s2.set('x', 5)
  await new Promise(r => setTimeout(r, 50))
  assert(s2.get('y') === 10, 'hook-in-hook: x hook sets y')
  assert(yFired === 10, 'hook-in-hook: y hook fires')

  // 3. No hooks registered: set works normally
  const s3 = createReactiveState({ a: 1 })
  s3.set('a', 2)
  assert(s3.get('a') === 2, 'no hooks: set works without hooks')

  // 4. snapshot is independent of hooks
  const s4 = createReactiveState({ status: 'idle', turn: 0 })
  let snapInHook = null
  s4.hooks.on('status', (val, state) => { snapInHook = state.snapshot() })
  s4.set('status', 'working')
  await new Promise(r => setTimeout(r, 0))
  assert(snapInHook.status === 'working', 'snapshot in hook reflects current state')

  // 5. get still works as expected
  const s5 = createReactiveState({ a: { b: 1 } })
  assert(s5.get('a.b') === 1, 'get with dot notation')

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
