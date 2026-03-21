import { createPersistence } from '../../src/infra/persistence.js'
import { createReactiveState } from '../../src/infra/state.js'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

async function run() {
  console.log('Persistence tests')

  const testDir = join(tmpdir(), `presence-persist-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })

  // 1. Save and restore state
  {
    const cwd = join(testDir, 'test1')
    mkdirSync(cwd, { recursive: true })
    const p = createPersistence({ cwd, debounceMs: 0 })
    p.clear()

    const state = createReactiveState({ turnState: { tag: 'idle' }, turn: 5 })
    p.saveImmediate(state)

    const restored = p.restore()
    assert(restored !== null, 'save → restore: data exists')
    assert(restored.turnState.tag === 'idle', 'save → restore: turnState preserved')
    assert(restored.turn === 5, 'save → restore: turn preserved')
    p.clear()
  }

  // 2. Restore from empty → null
  {
    const cwd = join(testDir, 'test2')
    mkdirSync(cwd, { recursive: true })
    const p = createPersistence({ cwd })
    p.clear()
    const restored = p.restore()
    assert(restored === null, 'empty restore: returns null')
  }

  // 3. Debounce: multiple saves → single write
  {
    const cwd = join(testDir, 'test3')
    mkdirSync(cwd, { recursive: true })
    const p = createPersistence({ cwd, debounceMs: 50 })
    p.clear()

    p.save({ snapshot: () => ({ count: 1 }) })
    p.save({ snapshot: () => ({ count: 2 }) })
    p.save({ snapshot: () => ({ count: 3 }) })

    const before = p.restore()
    assert(before === null, 'debounce: not saved immediately')

    await new Promise(r => setTimeout(r, 100))
    const after = p.restore()
    assert(after !== null && after.count === 3, 'debounce: last value saved')
    p.clear()
  }

  // 4. connectToState: auto-save on state change
  {
    const cwd = join(testDir, 'test4')
    mkdirSync(cwd, { recursive: true })
    const p = createPersistence({ cwd, debounceMs: 10 })
    p.clear()

    const state = createReactiveState({ turnState: { tag: 'idle' }, turn: 0 })
    p.connectToState(state)

    state.set('turnState', { tag: 'working', input: 'test' })
    await new Promise(r => setTimeout(r, 100))

    const restored = p.restore()
    assert(restored !== null, 'connectToState: auto-saved')
    assert(restored.turnState.tag === 'working', 'connectToState: saved correct state')
    p.clear()
  }

  // Cleanup
  rmSync(testDir, { recursive: true, force: true })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
