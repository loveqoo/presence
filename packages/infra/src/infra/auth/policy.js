import fp from '@presence/core/lib/fun-fp.js'

const { Either } = fp

// =============================================================================
// Auth 정책 상수 + 공통 타입.
// =============================================================================

export const AUTH = Object.freeze({
  ACCESS_TOKEN_EXPIRY_S: 15 * 60,
  REFRESH_TOKEN_EXPIRY_S: 7 * 24 * 3600,
  // KG-17 — A2A 호출용 짧은 만료 토큰. self-A2A 는 발신/수신 동일 머신이므로
  // 클럭 드리프트 무시 가능, 60 초로 충분.
  A2A_TOKEN_EXPIRY_S: 60,
  REFRESH_COOKIE_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
  ISSUER: 'presence',
  AUDIENCE: 'presence',
  BCRYPT_ROUNDS: 12,
  MIN_PASSWORD_LENGTH: 8,
  RATE_LIMIT_MAX_ATTEMPTS: 5,
  RATE_LIMIT_WINDOW_MS: 60_000,
})

// --- AuthError: transport-agnostic 에러 ---

export const AUTH_ERROR = Object.freeze({
  NO_TOKEN: 'no_token',
  INVALID_TOKEN: 'invalid_token',
  TOKEN_EXPIRED: 'token_expired',
  TOKEN_REVOKED: 'token_revoked',
  TOKEN_INVALIDATED: 'token_invalidated',
  INVALID_CREDENTIALS: 'invalid_credentials',
  PASSWORD_CHANGE_REQUIRED: 'password_change_required',
  INVALID_PRINCIPAL: 'invalid_principal',
  RATE_LIMITED: 'rate_limited',
  MISSING_FIELDS: 'missing_fields',
})

export const AuthError = (code, message) => Object.freeze({ code, message })

// --- Principal 정규화 ---
// 모든 인증 경로(access token payload, refresh chain user)를 공통 shape로 변환.
// username 부재 시 Either.Left.

export const toPrincipal = (payload) => {
  const username = payload.sub ?? payload.username
  if (!username) return Either.Left(AuthError(AUTH_ERROR.INVALID_PRINCIPAL, 'Missing username in payload'))
  return Either.Right({
    username,
    roles: payload.roles ?? [],
    mustChangePassword: payload.mustChangePassword ?? false,
  })
}
