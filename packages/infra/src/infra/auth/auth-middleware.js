import fp from '@presence/core/lib/fun-fp.js'

const { Either, Reader } = fp

// =============================================================================
// Auth Middleware: Express HTTP 인증
// 의존성 전파: Reader(AuthEnv)
// 검증: Either
// Express 경계에서 Task.fork() 실행
//
// AuthEnv = { authProvider, tokenService, userStore, publicPaths }
// =============================================================================

// --- Rate Limiter (best-effort, in-memory) ---

const createRateLimiter = (opts = {}) => {
  const { maxAttempts = 5, windowMs = 60_000 } = opts
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

// --- 쿠키 헬퍼 ---

const setRefreshCookie = (res, token, opts = {}) => {
  const { maxAge = 7 * 24 * 60 * 60 * 1000 } = opts
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge,
  })
}

const clearRefreshCookie = (res) => setRefreshCookie(res, '', { maxAge: 0 })

// =============================================================================
// Reader 기반 토큰 연산
// =============================================================================

/**
 * Issues access and refresh tokens for the given user.
 * @param {object} user - Authenticated user object with username, roles, tokenVersion
 * @returns {Reader} Reader(AuthEnv → { accessToken, refreshToken, user })
 */
const issueTokensR = (user) =>
  Reader.asks(({ tokenService, userStore }) => {
    const accessToken = tokenService.signAccessToken({ sub: user.username, roles: user.roles, mustChangePassword: user.mustChangePassword || false })
    const { token: refreshToken, jti } = tokenService.signRefreshToken({
      sub: user.username,
      tokenVersion: user.tokenVersion,
    })
    userStore.addRefreshSession(user.username, jti)
    return { accessToken, refreshToken, user }
  })

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

/**
 * Rotates a refresh token: removes the old session and issues new tokens.
 * @param {{ user: object, jti: string }} validated - Result from validateRefreshChainR
 * @returns {Reader} Reader(AuthEnv → { accessToken, refreshToken, user })
 */
const rotateRefreshTokenR = (validated) =>
  Reader.asks(({ userStore }) => userStore.removeRefreshSession(validated.user.username, validated.jti))
    .chain(() => issueTokensR(validated.user))

// =============================================================================
// Express Middleware / Handlers
// =============================================================================

const MUST_CHANGE_PASSWORD_ALLOWLIST = ['/auth/change-password', '/auth/refresh', '/auth/logout']

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
      payload => {
        req.user = payload
        if (payload.mustChangePassword === true) {
          const allowed = MUST_CHANGE_PASSWORD_ALLOWLIST.some(
            p => req.path === p || req.path.startsWith(p + '/')
          )
          if (!allowed) return res.status(403).json({ error: 'Password change required' })
        }
        next()
      },
      tokenService.verifyAccessToken(authHeader.slice(7)),
    )
  }
)

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
      err => res.status(err.status).json({ error: err.error }),
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
              res.json({ accessToken, refreshToken, username: user.username, roles: user.roles, mustChangePassword: user.mustChangePassword || false })
            },
          )
      },
      validateInput(req),
    )
  }
})

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
        res.json({ accessToken, refreshToken: newRefreshToken, username: user.username, roles: user.roles, mustChangePassword: user.mustChangePassword || false })
      },
      validateRefreshChainR(refreshToken).run(env),
    )
  }
)

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

export {
  loginHandlerR,
  refreshHandlerR,
  logoutHandlerR,
  authMiddlewareR,
  issueTokensR,
  validateRefreshChainR,
  rotateRefreshTokenR,
}
