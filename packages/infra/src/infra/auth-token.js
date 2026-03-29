import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs'
import { join } from 'path'
import { defaultPresenceDir } from './config.js'
import fp from '@presence/core/lib/fun-fp.js'

const { Either } = fp

// =============================================================================
// TokenService: JWT sign/verify with node:crypto HMAC-SHA256
// Secret 파일: ~/.presence/instances/{instanceId}.secret.json (권한 0600)
// =============================================================================

const ACCESS_TOKEN_EXPIRY_S = 15 * 60       // 15분
const REFRESH_TOKEN_EXPIRY_S = 7 * 24 * 3600 // 7일
const ISSUER = 'presence'

// --- Base64url 유틸 ---

const base64url = (data) =>
  (typeof data === 'string' ? Buffer.from(data) : data)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const base64urlDecode = (str) =>
  Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')

// --- Secret 파일 관리 ---

/**
 * Returns the filesystem path of the JWT secret file for an instance.
 * @param {string} instanceId
 * @param {string} [basePath] - Override for ~/.presence directory
 * @returns {string}
 */
const secretFilePath = (instanceId, basePath) => {
  const dir = basePath || process.env.PRESENCE_DIR || defaultPresenceDir()
  return join(dir, 'instances', `${instanceId}.secret.json`)
}

/**
 * Loads the JWT secret from PRESENCE_JWT_SECRET env var or the instance secret file.
 * @param {string} instanceId
 * @param {{ basePath?: string }} [opts]
 * @returns {string|null}
 */
const loadSecret = (instanceId, { basePath } = {}) => {
  const envSecret = process.env.PRESENCE_JWT_SECRET
  if (envSecret) return envSecret

  const filePath = secretFilePath(instanceId, basePath)
  if (!existsSync(filePath)) return null
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
  return raw.jwtSecret || null
}

/**
 * Generates and persists a new random JWT secret for an instance (chmod 0600).
 * @param {string} instanceId
 * @param {{ basePath?: string }} [opts]
 * @returns {string} The generated secret
 */
const generateSecret = (instanceId, { basePath } = {}) => {
  const filePath = secretFilePath(instanceId, basePath)
  const jwtSecret = randomBytes(32).toString('hex')
  writeFileSync(filePath, JSON.stringify({ jwtSecret }, null, 2), 'utf-8')
  try { chmodSync(filePath, 0o600) } catch { /* best-effort on non-POSIX */ }
  return jwtSecret
}

/**
 * Returns the existing JWT secret for an instance, generating one if none exists.
 * @param {string} instanceId
 * @param {{ basePath?: string }} [opts]
 * @returns {string}
 */
const ensureSecret = (instanceId, { basePath } = {}) => {
  const existing = loadSecret(instanceId, { basePath })
  if (existing) return existing
  return generateSecret(instanceId, { basePath })
}

// --- JWT 구현 ---

/**
 * Signs a JWT payload using HMAC-SHA256.
 * @param {object} payload
 * @param {string} secret
 * @returns {string} Signed JWT string
 */
const sign = (payload, secret) => {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  const signature = base64url(
    createHmac('sha256', secret).update(`${header}.${body}`).digest()
  )
  return `${header}.${body}.${signature}`
}

/**
 * Verifies a JWT: checks signature, expiry, issuer, and optional audience.
 * @param {string} token
 * @param {string} secret
 * @param {{ audience?: string }} [opts]
 * @returns {Either} Either.Right(payload) | Either.Left(error)
 */
const verify = (token, secret, { audience } = {}) => {
  if (!token || typeof token !== 'string') return Either.Left('missing token')

  const parts = token.split('.')
  if (parts.length !== 3) return Either.Left('malformed token')

  const [header, body, sig] = parts

  // 서명 검증
  const expected = base64url(
    createHmac('sha256', secret).update(`${header}.${body}`).digest()
  )
  if (sig !== expected) return Either.Left('invalid signature')

  // 페이로드 파싱
  return Either.fold(
    () => Either.Left('invalid payload'),
    payload => {
      const now = Math.floor(Date.now() / 1000)
      if (payload.exp && payload.exp < now) return Either.Left('token expired')
      if (payload.iss !== ISSUER) return Either.Left('invalid issuer')
      if (audience && payload.aud !== audience) return Either.Left('invalid audience')
      return Either.Right(payload)
    },
    Either.catch(() => JSON.parse(base64urlDecode(body))),
  )
}

// --- TokenService 팩토리 ---

/**
 * Creates a TokenService for the given instance using its persisted JWT secret.
 * @param {string} instanceId
 * @param {{ basePath?: string }} [opts]
 * @returns {{ signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken, secret }}
 */

const createTokenService = (instanceId, { basePath } = {}) => {
  const secret = ensureSecret(instanceId, { basePath })
  const audience = `presence:${instanceId}`

  const signAccessToken = ({ sub, roles, mustChangePassword }) => {
    const now = Math.floor(Date.now() / 1000)
    return sign({
      sub, roles,
      mustChangePassword: mustChangePassword || false,
      iss: ISSUER,
      aud: audience,
      iat: now,
      exp: now + ACCESS_TOKEN_EXPIRY_S,
    }, secret)
  }

  const signRefreshToken = ({ sub, tokenVersion }) => {
    const now = Math.floor(Date.now() / 1000)
    const jti = randomUUID()
    const token = sign({
      sub, tokenVersion,
      type: 'refresh',
      jti,
      iss: ISSUER,
      aud: audience,
      iat: now,
      exp: now + REFRESH_TOKEN_EXPIRY_S,
    }, secret)
    return { token, jti }
  }

  // Either.Right(payload) | Either.Left(error)
  const verifyAccessToken = (token) => verify(token, secret, { audience })

  // Either.Right(payload) | Either.Left(error)
  const verifyRefreshToken = (token) =>
    Either.fold(
      err => Either.Left(err),
      payload => payload.type !== 'refresh'
        ? Either.Left('not a refresh token')
        : Either.Right(payload),
      verify(token, secret, { audience }),
    )

  return {
    signAccessToken,
    signRefreshToken,
    verifyAccessToken,
    verifyRefreshToken,
    secret, // 테스트용 노출
  }
}

export { createTokenService, ensureSecret }
