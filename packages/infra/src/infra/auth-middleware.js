import fp from '@presence/core/lib/fun-fp.js'

const { Either, Task, Reader } = fp

// =============================================================================
// Auth Middleware: Express + WebSocket 인증
// 의존성 전파: Reader(AuthEnv)
// 검증: Either, 비동기 파이프라인: Task(Either)
// Express 경계에서 .fork() 실행
//
// AuthEnv = { authProvider, tokenService, userStore, publicPaths }
// =============================================================================

// --- Rate Limiter (best-effort, in-memory) ---
// Reader 대상 아님: 내부 상태(Map) 보유, 외부 deps 없음

const createRateLimiter = ({ maxAttempts = 5, windowMs = 60_000 } = {}) => {
  const attempts = new Map()

  const isAllowed = (ip) => {
    const now = Date.now()
    const list = (attempts.get(ip) || []).filter(t => now - t < windowMs)
    attempts.set(ip, list)
    return list.length < maxAttempts
  }

  const record = (ip) => {
    const list = attempts.get(ip) || []
    list.push(Date.now())
    attempts.set(ip, list)
  }

  return { isAllowed, record }
}

// --- 쿠키 헬퍼 (순수, deps 없음) ---

const setRefreshCookie = (res, token, { maxAge = 7 * 24 * 60 * 60 * 1000 } = {}) => {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge,
  })
}

const clearRefreshCookie = (res) => setRefreshCookie(res, '', { maxAge: 0 })

const parseCookies = (cookieStr) => {
  const cookies = {}
  for (const pair of cookieStr.split(';')) {
    const [key, ...rest] = pair.trim().split('=')
    if (key) cookies[key] = rest.join('=')
  }
  return cookies
}

// =============================================================================
// Reader 기반 인증 함수
// =============================================================================

// --- 토큰 발행: (user) → Reader(AuthEnv → tokens) ---

/**
 * Issues access and refresh tokens for the given user.
 * @param {object} user - Authenticated user object with username, roles, tokenVersion
 * @returns {Reader} Reader(AuthEnv → { accessToken, refreshToken, user })
 */
const issueTokensR = (user) =>
  Reader.asks(({ tokenService, userStore }) => {
    const accessToken = tokenService.signAccessToken({ sub: user.username, roles: user.roles })
    const { token: refreshToken, jti } = tokenService.signRefreshToken({
      sub: user.username,
      tokenVersion: user.tokenVersion,
    })
    userStore.addRefreshSession(user.username, jti)
    return { accessToken, refreshToken, user }
  })

// --- Refresh 검증: (refreshToken) → Reader(AuthEnv → Either) ---

/**
 * Validates a refresh token and checks active session + tokenVersion.
 * Revokes all sessions if a stolen token is detected.
 * @param {string} refreshToken
 * @returns {Reader} Reader(AuthEnv → Either<error, { user, jti }>)
 */
const validateRefreshChainR = (refreshToken) =>
  Reader.asks(({ tokenService, userStore }) => {
    if (!refreshToken) return Either.Left('Refresh token required')

    return Either.fold(
      () => Either.Left('Invalid refresh token'),
      payload => {
        const { sub, jti, tokenVersion } = payload

        if (!userStore.hasRefreshSession(sub, jti)) {
          userStore.revokeAllRefreshSessions(sub)
          return Either.Left('Refresh token revoked (possible theft detected)')
        }

        const user = userStore.findUser(sub)
        if (!user || user.tokenVersion !== tokenVersion) {
          userStore.revokeAllRefreshSessions(sub)
          return Either.Left('Token invalidated (password changed)')
        }

        return Either.Right({ user, jti })
      },
      tokenService.verifyRefreshToken(refreshToken),
    )
  })

// --- Refresh 토큰 회전: Reader 합성 — deps 암묵 전파 ---

/**
 * Rotates a refresh token: removes the old session and issues new tokens.
 * @param {{ user: object, jti: string }} validated - Result from validateRefreshChainR
 * @returns {Reader} Reader(AuthEnv → { accessToken, refreshToken, user })
 */
const rotateRefreshTokenR = ({ user, jti }) =>
  Reader.asks(({ userStore }) => userStore.removeRefreshSession(user.username, jti))
    .chain(() => issueTokensR(user))

// --- Express Auth Middleware: Reader(AuthEnv → ExpressMiddleware) ---

/**
 * Express middleware that verifies Bearer access tokens, bypassing publicPaths.
 * @type {Reader} Reader({ tokenService, publicPaths? } → ExpressMiddleware)
 */
const authMiddlewareR = Reader.asks(({ tokenService, publicPaths = [] }) =>
  (req, res, next) => {
    if (publicPaths.some(p => req.path === p || req.path.startsWith(p + '/'))) return next()

    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' })
    }

    Either.fold(
      () => res.status(401).json({ error: 'Invalid or expired token' }),
      payload => { req.user = payload; next() },
      tokenService.verifyAccessToken(authHeader.slice(7)),
    )
  }
)

// --- Login Handler: Reader(AuthEnv → ExpressHandler) ---

/**
 * Express handler for POST /api/auth/login with rate limiting.
 * Sets refreshToken HttpOnly cookie and returns accessToken on success.
 * @type {Reader} Reader({ authProvider, tokenService, userStore } → ExpressHandler)
 */
const loginHandlerR = Reader.ask.map(env => {
  const { authProvider } = env
  const rateLimiter = createRateLimiter()

  const validateInput = (req) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    if (!rateLimiter.isAllowed(ip)) return Either.Left({ status: 429, error: 'Too many login attempts. Try again later.' })
    rateLimiter.record(ip)
    const { username, password } = req.body || {}
    if (!username || !password) return Either.Left({ status: 400, error: 'username and password are required' })
    return Either.Right({ username, password })
  }

  return (req, res) => {
    Either.fold(
      ({ status, error }) => res.status(status).json({ error }),
      ({ username, password }) => {
        authProvider.authenticate(username, password)
          .map(authResult => Either.fold(
            err => ({ left: err }),
            user => ({ right: issueTokensR(user).run(env) }),
            authResult,
          ))
          .fork(
            () => res.status(500).json({ error: 'Internal error' }),
            result => {
              if (result.left) return res.status(401).json({ error: result.left })
              const { accessToken, refreshToken, user } = result.right
              setRefreshCookie(res, refreshToken)
              res.json({ accessToken, refreshToken, username: user.username, roles: user.roles })
            },
          )
      },
      validateInput(req),
    )
  }
})

// --- Refresh Handler: Reader(AuthEnv → ExpressHandler) ---

/**
 * Express handler for POST /api/auth/refresh. Rotates the refresh token and returns new tokens.
 * @type {Reader} Reader({ tokenService, userStore } → ExpressHandler)
 */
const refreshHandlerR = Reader.ask.map(env =>
  (req, res) => {
    const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken

    Either.fold(
      err => res.status(401).json({ error: err }),
      validated => {
        const { accessToken, refreshToken: newRefreshToken, user } = rotateRefreshTokenR(validated).run(env)
        setRefreshCookie(res, newRefreshToken)
        res.json({ accessToken, refreshToken: newRefreshToken, username: user.username, roles: user.roles })
      },
      validateRefreshChainR(refreshToken).run(env),
    )
  }
)

// --- Logout Handler: Reader(AuthEnv → ExpressHandler) ---

/**
 * Express handler for POST /api/auth/logout. Revokes the refresh session and clears the cookie.
 * @type {Reader} Reader({ tokenService, userStore } → ExpressHandler)
 */
const logoutHandlerR = Reader.asks(({ tokenService, userStore }) =>
  (req, res) => {
    const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken
    if (refreshToken) {
      Either.fold(
        () => {},
        payload => userStore.removeRefreshSession(payload.sub, payload.jti),
        tokenService.verifyRefreshToken(refreshToken),
      )
    }
    clearRefreshCookie(res)
    res.json({ ok: true })
  }
)

// --- WebSocket 인증: (req) → Reader(AuthEnv → Either) ---

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
          () => env.userStore ? authenticateViaCookieR(req).run(env) : Either.Left('No valid authentication'),
          payload => Either.Right(payload),
          queryResult,
        )
      },
      payload => Either.Right(payload),
      headerResult,
    )
  })

// =============================================================================
// Export: Reader 버전
// =============================================================================

export {
  loginHandlerR,
  refreshHandlerR,
  logoutHandlerR,
  authMiddlewareR,
  authenticateWsR,
  authenticateViaQueryR,
  issueTokensR,
  validateRefreshChainR,
  rotateRefreshTokenR,
}
