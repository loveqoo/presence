import {
  createTokenService, sign, verify, ensureSecret, secretFilePath,
} from '@presence/infra/infra/auth-token.js'
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

function createTmpDir() {
  const dir = join(tmpdir(), `presence-auth-token-${Date.now()}`)
  mkdirSync(join(dir, 'instances'), { recursive: true })
  return dir
}

async function run() {
  console.log('Auth Token tests')

  // --- low-level sign/verify ---

  {
    const secret = 'test-secret-32chars-for-testing!'
    const payload = { sub: 'alice', iss: 'presence', aud: 'presence:test', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }
    const token = sign(payload, secret)

    assert(typeof token === 'string', 'sign: returns string')
    assert(token.split('.').length === 3, 'sign: has 3 parts')

    const result = verify(token, secret)
    assert(isRight(result), 'verify: Right for valid token')
    assert(getRight(result).sub === 'alice', 'verify: payload.sub correct')
  }

  // --- 잘못된 서명 ---

  {
    const secret = 'test-secret-32chars-for-testing!'
    const payload = { sub: 'alice', iss: 'presence', aud: 'presence:test', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }
    const token = sign(payload, secret)

    const result = verify(token, 'wrong-secret')
    assert(isLeft(result), 'verify: Left with wrong secret')
    assert(getLeft(result) === 'invalid signature', 'verify: error message')
  }

  // --- 만료된 토큰 ---

  {
    const secret = 'test-secret-32chars-for-testing!'
    const payload = { sub: 'alice', iss: 'presence', aud: 'presence:test', iat: 1000, exp: 1001 }
    const token = sign(payload, secret)

    const result = verify(token, secret)
    assert(isLeft(result), 'verify: Left for expired token')
    assert(getLeft(result) === 'token expired', 'verify: expired error message')
  }

  // --- 잘못된 iss ---

  {
    const secret = 'test-secret-32chars-for-testing!'
    const payload = { sub: 'alice', iss: 'wrong-issuer', aud: 'presence:test', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }
    const token = sign(payload, secret)

    const result = verify(token, secret)
    assert(isLeft(result), 'verify: Left for wrong issuer')
    assert(getLeft(result) === 'invalid issuer', 'verify: issuer error message')
  }

  // --- aud 검증 ---

  {
    const secret = 'test-secret-32chars-for-testing!'
    const payload = { sub: 'alice', iss: 'presence', aud: 'presence:test', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }
    const token = sign(payload, secret)

    assert(isRight(verify(token, secret, { audience: 'presence:test' })), 'verify: Right for correct audience')
    const bad = verify(token, secret, { audience: 'presence:other' })
    assert(isLeft(bad), 'verify: Left for wrong audience')
    assert(getLeft(bad) === 'invalid audience', 'verify: audience error message')
  }

  // --- 엣지 케이스: null, undefined, malformed ---

  {
    const secret = 'test-secret-32chars-for-testing!'
    assert(isLeft(verify(null, secret)), 'verify: Left for null token')
    assert(isLeft(verify(undefined, secret)), 'verify: Left for undefined token')
    assert(isLeft(verify('', secret)), 'verify: Left for empty string')
    assert(isLeft(verify('not.a.jwt.token', secret)), 'verify: Left for 4-part string')
    assert(isLeft(verify('x.y.z', secret)), 'verify: Left for random 3-part')
  }

  // --- Secret 생성 + 파일 권한 ---

  {
    const dir = createTmpDir()
    const secret = ensureSecret('test', { basePath: dir })
    assert(typeof secret === 'string', 'ensureSecret: returns string')
    assert(secret.length === 64, 'ensureSecret: 32 bytes hex = 64 chars')

    const filePath = secretFilePath('test', dir)
    assert(existsSync(filePath), 'ensureSecret: file created')

    try {
      const stat = statSync(filePath)
      const mode = (stat.mode & 0o777).toString(8)
      assert(mode === '600', `ensureSecret: file permissions 0600 (got ${mode})`)
    } catch { /* non-POSIX */ }

    const secret2 = ensureSecret('test', { basePath: dir })
    assert(secret === secret2, 'ensureSecret: idempotent')

    rmSync(dir, { recursive: true, force: true })
  }

  // --- TokenService: access token ---

  {
    const dir = createTmpDir()
    const service = createTokenService('test', { basePath: dir })

    const token = service.signAccessToken({ sub: 'alice', roles: ['admin'] })
    assert(typeof token === 'string', 'signAccessToken: returns string')

    const result = service.verifyAccessToken(token)
    assert(isRight(result), 'verifyAccessToken: Right')
    const payload = getRight(result)
    assert(payload.sub === 'alice', 'verifyAccessToken: sub correct')
    assert(payload.roles.includes('admin'), 'verifyAccessToken: roles correct')
    assert(payload.iss === 'presence', 'verifyAccessToken: iss correct')
    assert(payload.aud === 'presence:test', 'verifyAccessToken: aud correct')
    assert(typeof payload.exp === 'number', 'verifyAccessToken: has exp')

    rmSync(dir, { recursive: true, force: true })
  }

  // --- TokenService: refresh token ---

  {
    const dir = createTmpDir()
    const service = createTokenService('test', { basePath: dir })

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
    const service = createTokenService('test', { basePath: dir })

    const accessToken = service.signAccessToken({ sub: 'alice', roles: ['user'] })
    const result = service.verifyRefreshToken(accessToken)
    assert(isLeft(result), 'verifyRefreshToken: Left for access token')
    assert(getLeft(result) === 'not a refresh token', 'verifyRefreshToken: correct error for access token')

    rmSync(dir, { recursive: true, force: true })
  }

  // --- 다른 인스턴스의 토큰 거부 ---

  {
    const dir = createTmpDir()
    const service1 = createTokenService('inst-a', { basePath: dir })
    const service2 = createTokenService('inst-b', { basePath: dir })

    const token = service1.signAccessToken({ sub: 'alice', roles: ['user'] })
    const result = service2.verifyAccessToken(token)
    assert(isLeft(result), 'cross-instance: Left for token from inst-a by inst-b')

    rmSync(dir, { recursive: true, force: true })
  }

  // --- PRESENCE_JWT_SECRET env override ---

  {
    const dir = createTmpDir()
    const origEnv = process.env.PRESENCE_JWT_SECRET
    process.env.PRESENCE_JWT_SECRET = 'env-override-secret-that-is-long-enough'

    const service = createTokenService('test', { basePath: dir })
    const token = service.signAccessToken({ sub: 'alice', roles: ['user'] })
    assert(isRight(service.verifyAccessToken(token)), 'env override: Right with env secret')

    if (origEnv) process.env.PRESENCE_JWT_SECRET = origEnv
    else delete process.env.PRESENCE_JWT_SECRET

    rmSync(dir, { recursive: true, force: true })
  }

  summary()
}

run()
