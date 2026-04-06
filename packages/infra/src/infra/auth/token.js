import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs'
import { join } from 'path'
import { Config } from '../config.js'
import fp from '@presence/core/lib/fun-fp.js'
import { AUTH } from './policy.js'

const { Either } = fp

// =============================================================================
// TokenService: JWT sign/verify with node:crypto HMAC-SHA256
// Secret 파일: ~/.presence/server.secret.json (권한 0600)
// =============================================================================

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
 * Returns the filesystem path of the JWT secret file.
 * @param {string} [basePath] - Override for ~/.presence directory
 * @returns {string}
 */
const secretFilePath = (basePath) => {
  const dir = basePath || process.env.PRESENCE_DIR || Config.presenceDir()
  return join(dir, 'server.secret.json')
}

/**
 * Loads the JWT secret from PRESENCE_JWT_SECRET env var or the secret file.
 * @param {{ basePath?: string }} [opts]
 * @returns {string|null}
 */
const loadSecret = ({ basePath } = {}) => {
  const envSecret = process.env.PRESENCE_JWT_SECRET
  if (envSecret) return envSecret

  const filePath = secretFilePath(basePath)
  if (!existsSync(filePath)) return null
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
  return raw.jwtSecret || null
}

/**
 * Generates and persists a new random JWT secret (chmod 0600).
 * @param {{ basePath?: string }} [opts]
 * @returns {string} The generated secret
 */
const generateSecret = ({ basePath } = {}) => {
  const filePath = secretFilePath(basePath)
  const jwtSecret = randomBytes(32).toString('hex')
  writeFileSync(filePath, JSON.stringify({ jwtSecret }, null, 2), 'utf-8')
  try { chmodSync(filePath, 0o600) } catch { /* best-effort on non-POSIX */ }
  return jwtSecret
}

/**
 * Returns the existing JWT secret, generating one if none exists.
 * @param {{ basePath?: string }} [opts]
 * @returns {string}
 */
const ensureSecret = ({ basePath } = {}) => {
  const existing = loadSecret({ basePath })
  if (existing) return existing
  return generateSecret({ basePath })
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
      if (payload.iss !== AUTH.ISSUER) return Either.Left('invalid issuer')
      if (audience && payload.aud !== audience) return Either.Left('invalid audience')
      return Either.Right(payload)
    },
    Either.catch(() => JSON.parse(base64urlDecode(body))),
  )
}

// --- TokenService 팩토리 ---

/**
 * Creates a TokenService using its persisted JWT secret.
 * @param {{ basePath?: string }} [opts]
 * @returns {{ signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken, secret }}
 */

const createTokenService = ({ basePath } = {}) => {
  const secret = ensureSecret({ basePath })
  const audience = AUTH.AUDIENCE

  const signAccessToken = ({ sub, roles, mustChangePassword }) => {
    const now = Math.floor(Date.now() / 1000)
    return sign({
      sub, roles,
      mustChangePassword: mustChangePassword || false,
      iss: AUTH.ISSUER,
      aud: audience,
      iat: now,
      exp: now + AUTH.ACCESS_TOKEN_EXPIRY_S,
    }, secret)
  }

  const signRefreshToken = ({ sub, tokenVersion }) => {
    const now = Math.floor(Date.now() / 1000)
    const jti = randomUUID()
    const token = sign({
      sub, tokenVersion,
      type: 'refresh',
      jti,
      iss: AUTH.ISSUER,
      aud: audience,
      iat: now,
      exp: now + AUTH.REFRESH_TOKEN_EXPIRY_S,
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

export { createTokenService, ensureSecret, sign }
