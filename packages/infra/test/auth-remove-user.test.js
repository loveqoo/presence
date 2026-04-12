import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import { removeUserCompletely } from '@presence/infra/infra/auth/remove-user.js'
import { assert, summary } from '../../../test/lib/assert.js'

// KG-04 해소 검증: 유저 삭제 시 Memory + 유저 디렉토리 + users.json 세 군데 모두 정리.

const setupStore = async (prefix, username) => {
  const dir = mkdtempSync(join(tmpdir(), `presence-${prefix}-`))
  const store = createUserStore({ basePath: dir })
  await store.addUser(username, 'password123')
  const userDir = join(dir, 'users', username)
  mkdirSync(userDir, { recursive: true })
  writeFileSync(join(userDir, 'notes.txt'), 'some data')
  return { dir, store, userDir }
}

const run = async () => {
  // --- 세 단계 모두 정리 ---
  {
    const { dir, store, userDir } = await setupStore('kg04a', 'alice')
    const cleared = []
    const memory = { clearAll: async (uid) => { cleared.push(uid); return 7 } }

    const result = await removeUserCompletely({
      store, memory, username: 'alice', userDir,
    })

    assert(result.memoryCount === 7, 'removeUserCompletely: memoryCount 반영')
    assert(result.dirRemoved === true, 'removeUserCompletely: dirRemoved=true')
    assert(cleared.length === 1 && cleared[0] === 'alice',
      'removeUserCompletely: memory.clearAll 이 username 으로 호출')
    assert(store.findUser('alice') === null,
      'removeUserCompletely: users.json 에서 제거됨')
    assert(!existsSync(userDir),
      'removeUserCompletely: 유저 디렉토리 재귀 삭제')

    rmSync(dir, { recursive: true, force: true })
  }

  // --- memory null 이면 store/dir 만 정리 ---
  {
    const { dir, store, userDir } = await setupStore('kg04b', 'bob')
    const result = await removeUserCompletely({
      store, memory: null, username: 'bob', userDir,
    })
    assert(result.memoryCount === 0,
      'removeUserCompletely: memory null → memoryCount=0')
    assert(result.dirRemoved === true,
      'removeUserCompletely: memory null 이어도 dir 삭제')
    assert(store.findUser('bob') === null,
      'removeUserCompletely: memory null 이어도 store 정리')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- memory.clearAll 실패 → best effort ---
  {
    const { dir, store, userDir } = await setupStore('kg04c', 'carol')
    const memory = { clearAll: async () => { throw new Error('mem0 backend down') } }
    const result = await removeUserCompletely({
      store, memory, username: 'carol', userDir,
    })
    assert(result.memoryCount === 0,
      'removeUserCompletely: clearAll throw → memoryCount=0 (best effort)')
    assert(result.dirRemoved === true,
      'removeUserCompletely: clearAll 실패해도 dir 삭제 진행')
    assert(store.findUser('carol') === null,
      'removeUserCompletely: clearAll 실패해도 store 정리 진행')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- 미존재 유저 → throw, 다른 상태 건드리지 않음 ---
  {
    const dir = mkdtempSync(join(tmpdir(), 'presence-kg04d-'))
    const store = createUserStore({ basePath: dir })
    await store.addUser('dave', 'password123')

    const cleared = []
    const memory = { clearAll: async (uid) => { cleared.push(uid); return 5 } }

    let thrown = null
    try {
      await removeUserCompletely({
        store, memory, username: 'ghost', userDir: join(dir, 'users', 'ghost'),
      })
    } catch (err) { thrown = err }

    assert(thrown !== null && /User not found/.test(thrown.message),
      'removeUserCompletely: 미존재 유저 → throw')
    assert(store.findUser('dave') !== null,
      'removeUserCompletely: 미존재 유저 throw 시 다른 유저는 영향 없음')
    assert(cleared.length === 0,
      'removeUserCompletely: 미존재 유저 throw 시 memory.clearAll 호출 안 함')

    rmSync(dir, { recursive: true, force: true })
  }

  // --- 디렉토리 없으면 dirRemoved=false ---
  {
    const dir = mkdtempSync(join(tmpdir(), 'presence-kg04e-'))
    const store = createUserStore({ basePath: dir })
    await store.addUser('eve', 'password123')
    const result = await removeUserCompletely({
      store, memory: null, username: 'eve',
      userDir: join(dir, 'users', 'eve'),
    })
    assert(result.dirRemoved === false,
      'removeUserCompletely: 디렉토리 부재 → dirRemoved=false')
    assert(store.findUser('eve') === null,
      'removeUserCompletely: 디렉토리 부재 시에도 store 정리')
    rmSync(dir, { recursive: true, force: true })
  }

  summary()
}

run()
