import express from 'express'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import { createTokenService } from '@presence/infra/infra/auth/token.js'
import { HttpAuthService } from '@presence/infra/infra/auth/http-service.js'
import { WsAuthService } from '@presence/infra/infra/auth/ws-service.js'

// =============================================================================
// Auth setup: cookie parser + auth routes + middleware 마운트.
// Returns: { authEnabled, userStore, tokenService, wsAuth }
// =============================================================================

const parseCookiesMiddleware = (req, _res, next) => {
  req.cookies = {}
  const cookieStr = req.headers.cookie || ''
  for (const pair of cookieStr.split(';')) {
    const [key, ...rest] = pair.trim().split('=')
    if (key) req.cookies[key] = rest.join('=')
  }
  next()
}

const setupAuth = (expressApp) => {
  const userStore = createUserStore()
  if (!userStore.hasUsers()) throw new Error(`No users configured. Run: npm run user -- init`)

  const tokenService = createTokenService()

  const publicPaths = ['/auth/login', '/auth/refresh', '/auth/logout', '/instance', '/auth/status']
  const httpAuth = new HttpAuthService(tokenService, userStore, { publicPaths })
  const wsAuth = new WsAuthService(tokenService, userStore)

  expressApp.use(parseCookiesMiddleware)

  // Auth routes (public — 미들웨어 이전 마운트)
  expressApp.post('/api/auth/login', express.json(), httpAuth.loginHandler())
  expressApp.post('/api/auth/refresh', express.json(), httpAuth.refreshHandler())
  expressApp.post('/api/auth/logout', express.json(), httpAuth.logoutHandler())
  expressApp.get('/api/auth/status', (_req, res) => {
    const users = userStore.listUsers() || []
    res.json({ username: users.length > 0 ? users[0].username : null })
  })

  // Auth middleware
  expressApp.use('/api', httpAuth.authMiddleware())

  // Authenticated routes (미들웨어 이후 마운트)
  expressApp.post('/api/auth/change-password', express.json(), httpAuth.changePasswordHandler())

  return { authEnabled: true, userStore, tokenService, wsAuth }
}

export { setupAuth }
