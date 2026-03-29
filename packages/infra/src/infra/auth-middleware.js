import fp from '@presence/core/lib/fun-fp.js'

const { Either, Task } = fp

// =============================================================================
// Auth Middleware: Express + WebSocket 인증
// 모든 검증은 Either, 비동기 파이프라인은 Task(Either)
// Express 경계에서 .fork() 실행
// =============================================================================

// --- Rate Limiter (best-effort, in-memory) ---

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

// --- 쿠키 헬퍼 ---

const setRefreshCookie = (res, token, { maxAge = 7 * 24 * 60 * 60 * 1000 } = {}) => {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/auth',
    maxAge,
  })
}

const clearRefreshCookie = (res) => setRefreshCookie(res, '', { maxAge: 0 })

// --- 토큰 발행 (순수) ---

const issueTokens = (tokenService, userStore, user) => {
  const accessToken = tokenService.signAccessToken({ sub: user.username, roles: user.roles })
  const { token: refreshToken, jti } = tokenService.signRefreshToken({
    sub: user.username,
    tokenVersion: user.tokenVersion,
  })
  userStore.addRefreshSession(user.username, jti)
  return { accessToken, refreshToken, user }
}

// --- Express Auth Middleware ---

const createAuthMiddleware = (tokenService, { publicPaths = [] } = {}) =>
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

// --- Login: Task 파이프라인 ---
// validateInput → authenticate → issueTokens → respond

const createLoginHandler = (authProvider, tokenService, userStore) => {
  const rateLimiter = createRateLimiter()

  // Either.Right({ username, password }) | Either.Left(errorResponse)
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
        // authenticate → Task(Either) → fork at Express boundary
        authProvider.authenticate(username, password)
          .map(authResult => Either.fold(
            err => ({ left: err }),
            user => ({ right: issueTokens(tokenService, userStore, user) }),
            authResult,
          ))
          .fork(
            err => res.status(500).json({ error: 'Internal error' }),
            result => {
              if (result.left) return res.status(401).json({ error: result.left })
              const { accessToken, refreshToken, user } = result.right
              setRefreshCookie(res, refreshToken)
              res.json({ accessToken, username: user.username, roles: user.roles })
            },
          )
      },
      validateInput(req),
    )
  }
}

// --- Refresh: Task 파이프라인 ---
// extractToken → verify → validateJti → validateVersion → rotate → respond

const validateRefreshChain = (tokenService, userStore, refreshToken) => {
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
}

const rotateRefreshToken = (tokenService, userStore, { user, jti }) => {
  userStore.removeRefreshSession(user.username, jti)
  return issueTokens(tokenService, userStore, user)
}

const createRefreshHandler = (tokenService, userStore) =>
  (req, res) => {
    const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken

    Either.fold(
      err => res.status(401).json({ error: err }),
      validated => {
        const { accessToken, refreshToken: newRefreshToken } = rotateRefreshToken(tokenService, userStore, validated)
        setRefreshCookie(res, newRefreshToken)
        res.json({ accessToken, refreshToken: newRefreshToken })
      },
      validateRefreshChain(tokenService, userStore, refreshToken),
    )
  }

// --- Logout ---

const createLogoutHandler = (tokenService, userStore) =>
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

// --- WebSocket 인증: Either 합성 (header → cookie 폴백) ---

const authenticateViaHeader = (req, tokenService) => {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) return Either.Left('no auth header')
  return tokenService.verifyAccessToken(authHeader.slice(7))
}

const authenticateViaCookie = (req, tokenService, userStore) => {
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
}

// Either.Right(payload) | Either.Left(error) — header 시도 후 cookie 폴백
const authenticateWs = (req, tokenService, { userStore } = {}) =>
  Either.fold(
    () => userStore ? authenticateViaCookie(req, tokenService, userStore) : Either.Left('No valid authentication'),
    payload => Either.Right(payload),
    authenticateViaHeader(req, tokenService),
  )

const parseCookies = (cookieStr) => {
  const cookies = {}
  for (const pair of cookieStr.split(';')) {
    const [key, ...rest] = pair.trim().split('=')
    if (key) cookies[key] = rest.join('=')
  }
  return cookies
}

export {
  createAuthMiddleware,
  createLoginHandler,
  createRefreshHandler,
  createLogoutHandler,
  authenticateWs,
  createRateLimiter,
}
