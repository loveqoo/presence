import { createLocalAuthProvider } from '@presence/infra/infra/auth/auth-provider.js'
import { createUserStore } from '@presence/infra/infra/auth/auth-user-store.js'
import { createTokenService } from '@presence/infra/infra/auth/auth-token.js'
import fp from '@presence/core/lib/fun-fp.js'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert, summary } from '../lib/assert.js'

const { Either } = fp
const isRight = (e) => Either.fold(() => false, () => true, e)
const isLeft = (e) => Either.fold(() => true, () => false, e)
const getRight = (e) => Either.fold(() => null, v => v, e)
const getLeft = (e) => Either.fold(v => v, () => null, e)

// Task(Either) → Promise(Either) 헬퍼
const forkToPromise = (task) => new Promise((resolve, reject) =>
  task.fork(reject, resolve)
)

function createTmpDir() {
  const dir = join(tmpdir(), `presence-auth-provider-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function run() {
  console.log('Auth Provider tests')

  // --- 성공 인증 ---

  {
    const dir = createTmpDir()
    const store = createUserStore({ basePath: dir })
    await store.addUser('alice', 'password123')

    const provider = createLocalAuthProvider(store)
    assert(provider.type === 'local', 'provider: type is local')

    const result = await forkToPromise(provider.authenticate('alice', 'password123'))
    assert(isRight(result), 'authenticate: Right with correct password')
    const user = getRight(result)
    assert(user.username === 'alice', 'authenticate: user.username correct')
    assert(Array.isArray(user.roles), 'authenticate: user.roles is array')
    assert(typeof user.tokenVersion === 'number', 'authenticate: user.tokenVersion present')

    rmSync(dir, { recursive: true, force: true })
  }

  // --- 잘못된 비밀번호 ---

  {
    const dir = createTmpDir()
    const store = createUserStore({ basePath: dir })
    await store.addUser('alice', 'password123')

    const provider = createLocalAuthProvider(store)
    const result = await forkToPromise(provider.authenticate('alice', 'wrongpassword'))
    assert(isLeft(result), 'authenticate: Left with wrong password')
    assert(getLeft(result) === 'Invalid credentials', 'authenticate: generic error message')

    rmSync(dir, { recursive: true, force: true })
  }

  // --- 존재하지 않는 사용자 ---

  {
    const dir = createTmpDir()
    const store = createUserStore({ basePath: dir })
    await store.addUser('alice', 'password123')

    const provider = createLocalAuthProvider(store)
    const result = await forkToPromise(provider.authenticate('nonexistent', 'password123'))
    assert(isLeft(result), 'authenticate: Left for nonexistent user')
    assert(getLeft(result) === 'Invalid credentials', 'authenticate: same error for nonexistent')

    rmSync(dir, { recursive: true, force: true })
  }

  // --- null/빈 입력 ---

  {
    const dir = createTmpDir()
    const store = createUserStore({ basePath: dir })
    await store.addUser('alice', 'password123')

    const provider = createLocalAuthProvider(store)

    assert(isLeft(await forkToPromise(provider.authenticate(null, 'password'))), 'authenticate: Left for null username')
    assert(isLeft(await forkToPromise(provider.authenticate('alice', null))), 'authenticate: Left for null password')
    assert(isLeft(await forkToPromise(provider.authenticate('', ''))), 'authenticate: Left for empty strings')
    assert(isLeft(await forkToPromise(provider.authenticate(undefined, undefined))), 'authenticate: Left for undefined')

    rmSync(dir, { recursive: true, force: true })
  }

  // --- tokenVersion 변경 후 인증 ---

  {
    const dir = createTmpDir()
    const store = createUserStore({ basePath: dir })
    await store.addUser('alice', 'password123')

    const provider = createLocalAuthProvider(store)

    const before = await forkToPromise(provider.authenticate('alice', 'password123'))
    assert(getRight(before).tokenVersion === 0, 'tokenVersion: starts at 0')

    await store.changePassword('alice', 'newpassword456')

    const after = await forkToPromise(provider.authenticate('alice', 'newpassword456'))
    assert(isRight(after), 'tokenVersion: Right with new password')
    assert(getRight(after).tokenVersion === 1, 'tokenVersion: bumped to 1')

    assert(isLeft(await forkToPromise(provider.authenticate('alice', 'password123'))), 'tokenVersion: Left with old password')

    rmSync(dir, { recursive: true, force: true })
  }

  // --- Refresh Token Rotation 전체 흐름 ---

  {
    const dir = createTmpDir()
    const store = createUserStore({ basePath: dir })
    const tokenService = createTokenService({ basePath: dir })
    await store.addUser('alice', 'password123')

    const provider = createLocalAuthProvider(store)
    const authResult = await forkToPromise(provider.authenticate('alice', 'password123'))
    assert(isRight(authResult), 'rotation: initial auth Right')

    const user = getRight(authResult)

    // 1. 로그인 → refresh token 발급
    const { token: rt1, jti: jti1 } = tokenService.signRefreshToken({
      sub: 'alice', tokenVersion: user.tokenVersion,
    })
    store.addRefreshSession('alice', jti1)
    assert(store.hasRefreshSession('alice', jti1), 'rotation: jti1 stored')

    // 2. Refresh → rotation
    const verifyResult = tokenService.verifyRefreshToken(rt1)
    assert(isRight(verifyResult), 'rotation: rt1 Right')

    const payload = getRight(verifyResult)
    const { jti: jti2 } = tokenService.signRefreshToken({
      sub: 'alice', tokenVersion: payload.tokenVersion,
    })
    store.removeRefreshSession('alice', jti1)
    store.addRefreshSession('alice', jti2)

    assert(!store.hasRefreshSession('alice', jti1), 'rotation: jti1 revoked')
    assert(store.hasRefreshSession('alice', jti2), 'rotation: jti2 active')

    // 3. 폐기된 jti1 → 탈취 감지
    if (!store.hasRefreshSession('alice', jti1)) {
      store.revokeAllRefreshSessions('alice')
    }
    assert(!store.hasRefreshSession('alice', jti2), 'rotation: jti2 also revoked (theft detection)')

    rmSync(dir, { recursive: true, force: true })
  }

  summary()
}

run()
