import { createPersistence, stripTransient } from '@presence/infra/infra/persistence.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { PERSISTENCE } from '@presence/core/core/policies.js'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert, summary } from '../../../test/lib/assert.js'

async function run() {
  console.log('Persistence tests')

  const testDir = join(tmpdir(), `presence-persist-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })

  // 헬퍼: store에 직접 쓰기 (PersistenceActor 없이 테스트)
  const saveDirect = (p, state) => {
    const snap = typeof state.snapshot === 'function' ? state.snapshot() : state
    p.store.set(PERSISTENCE.STORE_KEY, stripTransient(snap))
  }

  // 1. Save → restore
  {
    const cwd = join(testDir, 'test1')
    mkdirSync(cwd, { recursive: true })
    const p = createPersistence({ cwd })
    p.clear()

    const state = createOriginState({ turnState: { tag: 'idle' }, turn: 5 })
    saveDirect(p, state)

    const restored = p.restore()
    assert(restored !== null, 'save → restore: data exists')
    assert(restored.turnState.tag === 'idle', 'save → restore: turnState preserved')
    assert(restored.turn === 5, 'save → restore: turn preserved')
    p.clear()
  }

  // 2. Empty restore → null
  {
    const cwd = join(testDir, 'test2')
    mkdirSync(cwd, { recursive: true })
    const p = createPersistence({ cwd })
    p.clear()
    const restored = p.restore()
    assert(restored === null, 'empty restore: returns null')
  }

  // 3. _접두사 키는 persistence에서 제외
  {
    const cwd = join(testDir, 'test3')
    mkdirSync(cwd, { recursive: true })
    const p = createPersistence({ cwd })
    p.clear()

    const state = createOriginState({
      turnState: { tag: 'idle' },
      turn: 3,
      _toolResults: [{ tool: 'file_list', args: {}, result: 'data' }],
      _streaming: { content: 'hello' },
      _debug: { lastTurn: { input: 'test' } },
    })
    saveDirect(p, state)

    const restored = p.restore()
    assert(restored.turn === 3, 'transient exclusion: turn preserved')
    assert(restored.turnState.tag === 'idle', 'transient exclusion: turnState preserved')
    assert(restored._toolResults === undefined, 'transient exclusion: _toolResults excluded')
    assert(restored._streaming === undefined, 'transient exclusion: _streaming excluded')
    assert(restored._debug === undefined, 'transient exclusion: _debug excluded')
    p.clear()
  }

  // 4. stripTransient 단위 테스트
  {
    const input = { a: 1, b: 2, _x: 'transient', _y: 'skip' }
    const result = stripTransient(input)
    assert(result.a === 1 && result.b === 2, 'stripTransient: keeps non-prefix keys')
    assert(result._x === undefined && result._y === undefined, 'stripTransient: removes _ prefixed keys')
  }

  // Cleanup
  rmSync(testDir, { recursive: true, force: true })

  summary()
}

run()
