import {
  createTokenService, ensureSecret,
} from '@presence/infra/infra/auth/token.js'
import fp from '@presence/core/lib/fun-fp.js'
import { mkdirSync, rmSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert, summary } from '../../../test/lib/assert.js'

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

  // --- KG-17: A2A token sign/verify ---

  // A2A1. sign + verify happy path
  {
    const dir = createTmpDir()
    const service = createTokenService({ basePath: dir })
    const token = service.signA2aToken('alice')
    const result = service.verifyA2aToken(token)
    assert(isRight(result), 'A2A1: verifyA2aToken Right')
    const payload = getRight(result)
    assert(payload.sub === 'alice', 'A2A1: sub=alice')
    assert(payload.type === 'a2a', 'A2A1: type=a2a')
    rmSync(dir, { recursive: true, force: true })
  }

  // A2A2. access token 을 verifyA2aToken 으로 검증 → not an a2a token
  {
    const dir = createTmpDir()
    const service = createTokenService({ basePath: dir })
    const accessToken = service.signAccessToken({ sub: 'alice', roles: ['user'] })
    const result = service.verifyA2aToken(accessToken)
    assert(isLeft(result), 'A2A2: access token → Left')
    assert(getLeft(result) === 'not an a2a token', 'A2A2: type 분리 메시지')
    rmSync(dir, { recursive: true, force: true })
  }

  // A2A3. A2A token 을 verifyAccessToken 으로 검증 → 'not an access token' (type 분리 강화).
  //       이전엔 verifyAccessToken 이 type 검사를 안 해서 A2A 토큰이 access 경로로 우회 가능했음.
  //       이번에 verifyAccessToken 도 payload.type === 'access' 검사 추가 — 세 토큰 type 분리 완전.
  {
    const dir = createTmpDir()
    const service = createTokenService({ basePath: dir })
    const a2aToken = service.signA2aToken('bob')
    const result = service.verifyAccessToken(a2aToken)
    assert(isLeft(result), 'A2A3: A2A token → verifyAccessToken Left (type=a2a 거부)')
    assert(getLeft(result) === 'not an access token', 'A2A3: type 분리 메시지')
    rmSync(dir, { recursive: true, force: true })
  }

  // A2A5. refresh token 을 verifyAccessToken 으로 검증 → 'not an access token'
  {
    const dir = createTmpDir()
    const service = createTokenService({ basePath: dir })
    const { token: refreshToken } = service.signRefreshToken({ sub: 'carol', tokenVersion: 0 })
    const result = service.verifyAccessToken(refreshToken)
    assert(isLeft(result), 'A2A5: refresh token → verifyAccessToken Left')
    assert(getLeft(result) === 'not an access token', 'A2A5: type 분리 메시지')
    rmSync(dir, { recursive: true, force: true })
  }

  // A2A6. access token payload 에 type='access' 박혀있는지 확인
  {
    const dir = createTmpDir()
    const service = createTokenService({ basePath: dir })
    const accessToken = service.signAccessToken({ sub: 'dave', roles: ['user'] })
    const payload = getRight(service.verifyAccessToken(accessToken))
    assert(payload && payload.type === 'access', 'A2A6: access token payload 에 type=access')
    rmSync(dir, { recursive: true, force: true })
  }

  // A2A4. malformed token → Left
  {
    const dir = createTmpDir()
    const service = createTokenService({ basePath: dir })
    assert(isLeft(service.verifyA2aToken('not.a.token')), 'A2A4: malformed → Left')
    assert(isLeft(service.verifyA2aToken('')), 'A2A4: empty → Left')
    assert(isLeft(service.verifyA2aToken(null)), 'A2A4: null → Left')
    rmSync(dir, { recursive: true, force: true })
  }

  summary()
}

run()
