import fp from '@presence/core/lib/fun-fp.js'

const { Either, Reader } = fp

// =============================================================================
// WebSocket 인증: Bearer header → query param → HttpOnly cookie 순서로 시도.
// 의존성 전파: Reader(AuthEnv)
// =============================================================================

// --- Cookie 파싱 (WS upgrade request는 cookie-parser 미적용) ---

const parseCookies = (cookieStr) => {
  const cookies = {}
  for (const pair of cookieStr.split(';')) {
    const [key, ...rest] = pair.trim().split('=')
    if (key) cookies[key] = rest.join('=')
  }
  return cookies
}

// --- 인증 전략 ---

/**
 * Authenticates a WebSocket upgrade request via Bearer Authorization header.
 * @param {object} req - HTTP upgrade request
 * @returns {Reader} Reader({ tokenService } → Either<error, payload>)
 */
const authenticateViaHeaderR = (req) =>
  Reader.asks(({ tokenService }) => {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) return Either.Left('no auth header')
    return tokenService.verifyAccessToken(authHeader.slice(7))
  })

/**
 * Authenticates a WebSocket upgrade request via `token` query parameter (access token).
 * @param {object} req - HTTP upgrade request
 * @returns {Reader} Reader({ tokenService } → Either<error, payload>)
 */
const authenticateViaQueryR = (req) =>
  Reader.asks(({ tokenService }) => {
    const url = req.url || ''
    const idx = url.indexOf('?')
    if (idx === -1) return Either.Left('no token query param')
    const params = new URLSearchParams(url.slice(idx + 1))
    const token = params.get('token')
    if (!token) return Either.Left('no token query param')
    return tokenService.verifyAccessToken(token)
  })

/**
 * Authenticates a WebSocket upgrade request via HttpOnly refreshToken cookie.
 * @param {object} req - HTTP upgrade request
 * @returns {Reader} Reader({ tokenService, userStore } → Either<error, { sub }>)
 */
const authenticateViaCookieR = (req) =>
  Reader.asks(({ tokenService, userStore }) => {
    const cookies = parseCookies(req.headers.cookie || '')
    if (!cookies.refreshToken) return Either.Left('no refresh cookie')

    return Either.fold(
      err => Either.Left(err),
      payload => {
        const { sub, jti, tokenVersion } = payload
        if (!userStore.hasRefreshSession(sub, jti)) return Either.Left('Refresh token revoked')
        const user = userStore.findUser(sub)
        if (!user || user.tokenVersion !== tokenVersion) return Either.Left('Token invalidated')
        return Either.Right({ sub })
      },
      tokenService.verifyRefreshToken(cookies.refreshToken),
    )
  })

// --- mustChangePassword 게이트 ---

const rejectIfMustChangePassword = (result) =>
  Either.fold(
    err => Either.Left(err),
    payload => payload.mustChangePassword === true
      ? Either.Left('Password change required')
      : Either.Right(payload),
    result,
  )

/**
 * Authenticates a WebSocket request: tries Bearer header → query param → cookie, in that order.
 * @param {object} req - HTTP upgrade request
 * @returns {Reader} Reader(AuthEnv → Either<error, payload>)
 */
const authenticateWsR = (req) =>
  Reader.asks(env => {
    const headerResult = authenticateViaHeaderR(req).run(env)
    return Either.fold(
      () => {
        const queryResult = authenticateViaQueryR(req).run(env)
        return Either.fold(
          () => {
            const cookieResult = env.userStore ? authenticateViaCookieR(req).run(env) : Either.Left('No valid authentication')
            return rejectIfMustChangePassword(cookieResult)
          },
          payload => rejectIfMustChangePassword(Either.Right(payload)),
          queryResult,
        )
      },
      payload => rejectIfMustChangePassword(Either.Right(payload)),
      headerResult,
    )
  })

export {
  parseCookies,
  authenticateViaHeaderR,
  authenticateViaQueryR,
  authenticateViaCookieR,
  authenticateWsR,
}
