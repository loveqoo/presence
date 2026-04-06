import {
  createTokenService, ensureSecret,
} from '@presence/infra/infra/auth/token.js'
import fp from '@presence/core/lib/fun-fp.js'
import { mkdirSync, rmSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert, summary } from '../lib/assert.js'

const { Either } = fp
const isRight = (e) => Either.fold(() => false, () => true, e)
const isLeft = (e) => Either.fold(() => true, () => false, e)
const getRight = (e) => Either.fold(() => null, v => v, e)
const getLeft = (e) => Either.fold(v => v, () => null, e)

let _tmpDirCounter = 0
function createTmpDir() {
  const dir = join(tmpdir(), `presence-auth-token-${Date.now()}-${_tmpDirCounter++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function run() {
  console.log('Auth Token tests')

  // --- Secret 생성 + 파일 권한 ---

  {
    const dir = createTmpDir()
    const secret = ensureSecret({ basePath: dir })
    assert(typeof secret === 'string', 'ensureSecret: returns string')
    assert(secret.length === 64, 'ensureSecret: 32 bytes hex = 64 chars')

    const filePath = join(dir, 'server.secret.json')
    assert(existsSync(filePath), 'ensureSecret: file created')

    try {
      const stat = statSync(filePath)
      const mode = (stat.mode & 0o777).toString(8)
      assert(mode === '600', `ensureSecret: file permissions 0600 (got ${mode})`)
    } catch { /* non-POSIX */ }

    const secret2 = ensureSecret({ basePath: dir })
    assert(secret === secret2, 'ensureSecret: idempotent')

    rmSync(dir, { recursive: true, force: true })
  }

  // --- TokenService: access token ---

  {
    const dir = createTmpDir()
    const service = createTokenService({ basePath: dir })

    const token = service.signAccessToken({ sub: 'alice', roles: ['admin'] })
    assert(typeof token === 'string', 'signAccessToken: returns string')

    const result = service.verifyAccessToken(token)
    assert(isRight(result), 'verifyAccessToken: Right')
    const payload = getRight(result)
    assert(payload.sub === 'alice', 'verifyAccessToken: sub correct')
    assert(payload.roles.includes('admin'), 'verifyAccessToken: roles correct')
    assert(payload.iss === 'presence', 'verifyAccessToken: iss correct')
    assert(payload.aud === 'presence', 'verifyAccessToken: aud correct')
    assert(typeof payload.exp === 'number', 'verifyAccessToken: has exp')

    rmSync(dir, { recursive: true, force: true })
  }

  // --- TokenService: refresh token ---

  {
    const dir = createTmpDir()
    const service = createTokenService({ basePath: dir })

    const { token, jti } = service.signRefreshToken({ sub: 'alice', tokenVersion: 0 })
    assert(typeof token === 'string', 'signRefreshToken: returns token')
    assert(typeof jti === 'string', 'signRefreshToken: returns jti')

    const result = service.verifyRefreshToken(token)
    assert(isRight(result), 'verifyRefreshToken: Right')
    const payload = getRight(result)
    assert(payload.sub === 'alice', 'verifyRefreshToken: sub correct')
    assert(payload.type === 'refresh', 'verifyRefreshToken: type is refresh')
    assert(payload.jti === jti, 'verifyRefreshToken: jti matches')
    assert(payload.tokenVersion === 0, 'verifyRefreshToken: tokenVersion correct')

    rmSync(dir, { recursive: true, force: true })
  }

  // --- access token을 refresh로 검증하면 실패 ---

  {
    const dir = createTmpDir()
    const service = createTokenService({ basePath: dir })

    const accessToken = service.signAccessToken({ sub: 'alice', roles: ['user'] })
    const result = service.verifyRefreshToken(accessToken)
    assert(isLeft(result), 'verifyRefreshToken: Left for access token')
    assert(getLeft(result) === 'not a refresh token', 'verifyRefreshToken: correct error for access token')

    rmSync(dir, { recursive: true, force: true })
  }

  // --- 다른 서버 시크릿으로 서명된 토큰 거부 ---

  {
    const dir1 = createTmpDir()
    const dir2 = createTmpDir()
    const service1 = createTokenService({ basePath: dir1 })
    const service2 = createTokenService({ basePath: dir2 })

    const token = service1.signAccessToken({ sub: 'alice', roles: ['user'] })
    const result = service2.verifyAccessToken(token)
    assert(isLeft(result), 'cross-secret: Left for token signed by different secret')

    rmSync(dir1, { recursive: true, force: true })
    rmSync(dir2, { recursive: true, force: true })
  }

  // --- PRESENCE_JWT_SECRET env override ---

  {
    const dir = createTmpDir()
    const origEnv = process.env.PRESENCE_JWT_SECRET
    process.env.PRESENCE_JWT_SECRET = 'env-override-secret-that-is-long-enough'

    const service = createTokenService({ basePath: dir })
    const token = service.signAccessToken({ sub: 'alice', roles: ['user'] })
    assert(isRight(service.verifyAccessToken(token)), 'env override: Right with env secret')

    if (origEnv) process.env.PRESENCE_JWT_SECRET = origEnv
    else delete process.env.PRESENCE_JWT_SECRET

    rmSync(dir, { recursive: true, force: true })
  }

  summary()
}

run()
