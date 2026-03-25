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

  // 4. _접두사 키는 persistence에서 제외
  {
    const cwd = join(testDir, 'test5')
    mkdirSync(cwd, { recursive: true })
    const p = createPersistence({ cwd, debounceMs: 0 })
    p.clear()

    const state = createReactiveState({
      turnState: { tag: 'idle' },
      turn: 3,
      _toolResults: [{ tool: 'file_list', args: {}, result: 'data' }],
      _streaming: { content: 'hello' },
      _debug: { lastTurn: { input: 'test' } },
    })
    p.saveImmediate(state)

    const restored = p.restore()
    assert(restored.turn === 3, 'transient exclusion: turn preserved')
    assert(restored.turnState.tag === 'idle', 'transient exclusion: turnState preserved')
    assert(restored._toolResults === undefined, 'transient exclusion: _toolResults excluded')
    assert(restored._streaming === undefined, 'transient exclusion: _streaming excluded')
    assert(restored._debug === undefined, 'transient exclusion: _debug excluded')
    p.clear()
  }

  // 6. debounce save도 _접두사 제외
  {
    const cwd = join(testDir, 'test6')
    mkdirSync(cwd, { recursive: true })
    const p = createPersistence({ cwd, debounceMs: 10 })
    p.clear()

    p.save({ snapshot: () => ({ turn: 1, _toolResults: [1, 2, 3] }) })
    await new Promise(r => setTimeout(r, 50))

    const restored = p.restore()
    assert(restored.turn === 1, 'debounce transient: turn saved')
    assert(restored._toolResults === undefined, 'debounce transient: _toolResults excluded')
    p.clear()
  }

  // Cleanup
  rmSync(testDir, { recursive: true, force: true })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
