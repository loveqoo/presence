import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import { AUTH } from '@presence/infra/infra/auth/policy.js'
const MIN_PASSWORD_LENGTH = AUTH.MIN_PASSWORD_LENGTH
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert, summary } from '../lib/assert.js'

function createTmpDir() {
  const dir = join(tmpdir(), `presence-auth-store-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function run() {
  console.log('Auth UserStore tests')

  // --- 기본 동작 ---

  {
    const dir = createTmpDir()
    const store = createUserStore({ basePath: dir })
    assert(!store.exists(), 'store: does not exist initially')
    assert(!store.hasUsers(), 'store: no users initially')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- 사용자 추가 ---

  {
    const dir = createTmpDir()
    const store = createUserStore({ basePath: dir })

    const user = await store.addUser('alice', 'password123')
    assert(user.username === 'alice', 'addUser: username correct')
    assert(user.roles.includes('admin'), 'addUser: first user is admin')
    assert(store.hasUsers(), 'addUser: hasUsers true after add')

    const user2 = await store.addUser('bob', 'password456')
    assert(user2.roles.includes('user'), 'addUser: second user is regular user')
    assert(!user2.roles.includes('admin'), 'addUser: second user not admin')

    rmSync(dir, { recursive: true, force: true })
  }

  // --- 중복 사용자 ---

  {
    const dir = createTmpDir()
    const store = createUserStore({ basePath: dir })
    await store.addUser('alice', 'password123')

    let threw = false
    try { await store.addUser('alice', 'password789') } catch { threw = true }
    assert(threw, 'addUser: throws on duplicate username')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- 비밀번호 최소 길이 ---

  {
    const dir = createTmpDir()
    const store = createUserStore({ basePath: dir })

    let threw = false
    try { await store.addUser('alice', 'short') } catch { threw = true }
    assert(threw, `addUser: throws on password < ${MIN_PASSWORD_LENGTH} chars`)
    rmSync(dir, { recursive: true, force: true })
  }

  // --- 잘못된 username ---

  {
    const dir = createTmpDir()
    const store = createUserStore({ basePath: dir })

    let threw = false
    try { await store.addUser('', 'password123') } catch { threw = true }
    assert(threw, 'addUser: throws on empty username')

    threw = false
    try { await store.addUser('invalid user!', 'password123') } catch { threw = true }
    assert(threw, 'addUser: throws on invalid username chars')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- 비밀번호 검증 ---

  {
    const dir = createTmpDir()
    const store = createUserStore({ basePath: dir })
    await store.addUser('alice', 'correctpassword')

    assert(await store.verifyPassword('alice', 'correctpassword'), 'verifyPassword: correct returns true')
    assert(!await store.verifyPassword('alice', 'wrongpassword'), 'verifyPassword: wrong returns false')
    assert(!await store.verifyPassword('nonexistent', 'password'), 'verifyPassword: unknown user returns false')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- 사용자 조회/목록 ---

  {
    const dir = createTmpDir()
    const store = createUserStore({ basePath: dir })
    await store.addUser('alice', 'password123')
    await store.addUser('bob', 'password456')

    const alice = store.findUser('alice')
    assert(alice !== null, 'findUser: found')
    assert(alice.username === 'alice', 'findUser: correct username')
    assert(typeof alice.passwordHash === 'string', 'findUser: has passwordHash')

    const nobody = store.findUser('nobody')
    assert(nobody === null, 'findUser: null for unknown')

    const list = store.listUsers()
    assert(list.length === 2, 'listUsers: 2 users')
    assert(!list[0].passwordHash, 'listUsers: no passwordHash exposed')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- 사용자 삭제 ---

  {
    const dir = createTmpDir()
    const store = createUserStore({ basePath: dir })
    await store.addUser('alice', 'password123')

    store.removeUser('alice')
    assert(!store.hasUsers(), 'removeUser: no users after remove')
    assert(store.findUser('alice') === null, 'removeUser: user not found after remove')

    let threw = false
    try { store.removeUser('nonexistent') } catch { threw = true }
    assert(threw, 'removeUser: throws on unknown user')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- 비밀번호 변경 + tokenVersion ---

  {
    const dir = createTmpDir()
    const store = createUserStore({ basePath: dir })
    await store.addUser('alice', 'password123')
    store.addRefreshSession('alice', 'jti-1')
    store.addRefreshSession('alice', 'jti-2')

    const before = store.findUser('alice')
    assert(before.tokenVersion === 0, 'changePassword: tokenVersion starts at 0')
    assert(before.refreshSessions.length === 2, 'changePassword: 2 refresh sessions before')

    await store.changePassword('alice', 'newpassword456')

    const after = store.findUser('alice')
    assert(after.tokenVersion === 1, 'changePassword: tokenVersion bumped')
    assert(after.refreshSessions.length === 0, 'changePassword: all refresh sessions cleared')
    assert(await store.verifyPassword('alice', 'newpassword456'), 'changePassword: new password works')
    assert(!await store.verifyPassword('alice', 'password123'), 'changePassword: old password rejected')

    let threw = false
    try { await store.changePassword('alice', 'short') } catch { threw = true }
    assert(threw, 'changePassword: throws on short password')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- Refresh session 관리 ---

  {
    const dir = createTmpDir()
    const store = createUserStore({ basePath: dir })
    await store.addUser('alice', 'password123')

    store.addRefreshSession('alice', 'jti-abc')
    assert(store.hasRefreshSession('alice', 'jti-abc'), 'refreshSession: added and found')
    assert(!store.hasRefreshSession('alice', 'jti-xyz'), 'refreshSession: unknown jti not found')

    const removed = store.removeRefreshSession('alice', 'jti-abc')
    assert(removed, 'refreshSession: remove returns true')
    assert(!store.hasRefreshSession('alice', 'jti-abc'), 'refreshSession: gone after remove')

    const removedAgain = store.removeRefreshSession('alice', 'jti-abc')
    assert(!removedAgain, 'refreshSession: remove of missing returns false')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- 전체 refresh session 폐기 (탈취 감지) ---

  {
    const dir = createTmpDir()
    const store = createUserStore({ basePath: dir })
    await store.addUser('alice', 'password123')

    store.addRefreshSession('alice', 'jti-1')
    store.addRefreshSession('alice', 'jti-2')
    store.addRefreshSession('alice', 'jti-3')

    store.revokeAllRefreshSessions('alice')
    assert(!store.hasRefreshSession('alice', 'jti-1'), 'revokeAll: jti-1 gone')
    assert(!store.hasRefreshSession('alice', 'jti-2'), 'revokeAll: jti-2 gone')
    assert(!store.hasRefreshSession('alice', 'jti-3'), 'revokeAll: jti-3 gone')
    assert(store.findUser('alice').refreshSessions.length === 0, 'revokeAll: empty array')
    rmSync(dir, { recursive: true, force: true })
  }

  summary()
}

run()
