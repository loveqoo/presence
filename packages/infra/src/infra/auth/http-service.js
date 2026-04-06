import fp from '@presence/core/lib/fun-fp.js'
import { AUTH, AUTH_ERROR, AuthError, toPrincipal } from './policy.js'
import { AuthService } from './service.js'

const { Either } = fp

// =============================================================================
// HttpAuthService: Express HTTP 인증.
// AuthService 서브클래스 — extractPrincipal, gate, 핸들러.
// =============================================================================

const MUST_CHANGE_PASSWORD_ALLOWLIST = ['/auth/change-password', '/auth/refresh', '/auth/logout']

// --- Rate Limiter (in-memory, 서버 수명과 동일) ---

const createRateLimiter = () => {
  const { RATE_LIMIT_MAX_ATTEMPTS: maxAttempts, RATE_LIMIT_WINDOW_MS: windowMs } = AUTH
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

// --- AuthError → HTTP 상태 코드 매핑 ---

const httpStatus = (authError) => {
  switch (authError.code) {
    case AUTH_ERROR.PASSWORD_CHANGE_REQUIRED: return 403
    case AUTH_ERROR.RATE_LIMITED: return 429
    case AUTH_ERROR.MISSING_FIELDS: return 400
    default: return 401
  }
}

class HttpAuthService extends AuthService {
  #rateLimiter
  #publicPaths

  constructor(tokenService, userStore, opts = {}) {
    super(tokenService, userStore)
    this.#rateLimiter = createRateLimiter()
    this.#publicPaths = opts.publicPaths || []
  }

  // --- virtual 구현 ---

  extractPrincipal(req) {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return Either.Left(AuthError(AUTH_ERROR.NO_TOKEN, 'Authentication required'))
    }
    const token = authHeader.slice(7)
    return Either.fold(
      error => Either.Left(error),
      payload => toPrincipal(payload),
      this.verifyAccess(token),
    )
  }

  extractRefreshToken(req) {
    return req.cookies?.refreshToken || req.body?.refreshToken || null
  }

  extractCredentials(req) {
    const { username, password } = req.body || {}
    if (!username || !password) return null
    return { username, password }
  }

  gate(principal, req) {
    if (principal.mustChangePassword === true) {
      const allowed = MUST_CHANGE_PASSWORD_ALLOWLIST.some(
        p => req.path === p || req.path.startsWith(p + '/'),
      )
      if (!allowed) return Either.Left(AuthError(AUTH_ERROR.PASSWORD_CHANGE_REQUIRED, 'Password change required'))
    }
    return Either.Right(principal)
  }

  // --- HTTP 핸들러 ---

  authMiddleware() {
    return (req, res, next) => {
      if (this.#publicPaths.some(p => req.path === p || req.path.startsWith(p + '/'))) return next()

      Either.fold(
        error => res.status(httpStatus(error)).json({ error: error.message }),
        principal => { req.user = principal; next() },
        this.resolveAuth(req),
      )
    }
  }

  loginHandler() {
    return (req, res) => {
      const ip = req.ip || req.socket.remoteAddress || 'unknown'
      if (!this.#rateLimiter.isAllowed(ip)) {
        return res.status(429).json({ error: 'Too many login attempts. Try again later.' })
      }
      this.#rateLimiter.record(ip)

      const credentials = this.extractCredentials(req)
      if (!credentials) return res.status(400).json({ error: 'username and password are required' })

      this.authenticate(credentials.username, credentials.password)
        .map(authResult => Either.fold(
          err => ({ left: err }),
          user => ({ right: this.issueTokens(user) }),
          authResult,
        ))
        .fork(
          () => res.status(500).json({ error: 'Internal error' }),
          result => {
            if (result.left) return res.status(401).json({ error: result.left })
            const { accessToken, refreshToken, user } = result.right
            this.#setRefreshCookie(res, refreshToken)
            res.json({
              accessToken, refreshToken,
              username: user.username, roles: user.roles,
              mustChangePassword: user.mustChangePassword || false,
            })
          },
        )
    }
  }

  refreshHandler() {
    return (req, res) => {
      Either.fold(
        error => res.status(httpStatus(error)).json({ error: error.message }),
        tokens => {
          this.#setRefreshCookie(res, tokens.refreshToken)
          res.json({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            username: tokens.user.username,
            roles: tokens.user.roles,
            mustChangePassword: tokens.user.mustChangePassword || false,
          })
        },
        this.refreshFlow(req),
      )
    }
  }

  logoutHandler() {
    return (req, res) => {
      const refreshToken = this.extractRefreshToken(req)
      this.revokeRefresh(refreshToken)
      this.#clearRefreshCookie(res)
      res.json({ ok: true })
    }
  }

  changePasswordHandler() {
    return async (req, res) => {
      const username = req.user?.username
      if (!username) return res.status(401).json({ error: 'Unauthorized' })

      const { currentPassword, newPassword } = req.body || {}
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'currentPassword and newPassword required' })
      }

      const result = this.changePassword(username, currentPassword, newPassword)
      // changePassword → Task(Either<AuthError, tokens>)
      result.fork(
        () => res.status(500).json({ error: 'Internal error' }),
        eitherResult => {
          Either.fold(
            error => res.status(httpStatus(error)).json({ error: error.message }),
            tokens => {
              this.#setRefreshCookie(res, tokens.refreshToken)
              res.json({
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                username: tokens.user.username,
                roles: tokens.user.roles,
                mustChangePassword: false,
              })
            },
            eitherResult,
          )
        },
      )
    }
  }

  // --- private: 쿠키 ---

  #setRefreshCookie(res, token, { maxAge = AUTH.REFRESH_COOKIE_MAX_AGE_MS } = {}) {
    res.cookie('refreshToken', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge,
    })
  }

  #clearRefreshCookie(res) {
    this.#setRefreshCookie(res, '', { maxAge: 0 })
  }
}

export { HttpAuthService }
