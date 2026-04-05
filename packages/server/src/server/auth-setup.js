import express from 'express'
import { createUserStore } from '@presence/infra/infra/auth/auth-user-store.js'
import { createTokenService } from '@presence/infra/infra/auth/auth-token.js'
import { createLocalAuthProvider } from '@presence/infra/infra/auth/auth-provider.js'
import {
  loginHandlerR, refreshHandlerR, logoutHandlerR, authMiddlewareR,
} from '@presence/infra/infra/auth/auth-middleware.js'

// =============================================================================
// Auth setup: cookie parser + auth routes + middleware 마운트.
// change-password 엔드포인트 포함.
// Returns: { authEnabled, userStore, tokenService, authProvider } (다른 핸들러에서 사용).
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

const mountChangePasswordHandler = (expressApp, deps) => {
  const { authProvider, tokenService, userStore } = deps
  expressApp.post('/api/auth/change-password', express.json(), async (req, res) => {
    const username = req.user?.username
    if (!username) return res.status(401).json({ error: 'Unauthorized' })
    const { currentPassword, newPassword } = req.body || {}
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword required' })
    if (typeof newPassword !== 'string' || newPassword.length < 8) return res.status(400).json({ error: 'newPassword must be at least 8 characters' })
    const authResult = await new Promise(resolve => {
      authProvider.authenticate(username, currentPassword).fork(() => resolve(null), user => resolve(user))
    })
    if (!authResult) return res.status(401).json({ error: 'Invalid credentials' })
    userStore.changePassword(username, newPassword)
    const newUser = userStore.findByUsername(username)
    const accessToken = tokenService.signAccessToken({ username: newUser.username, roles: newUser.roles, mustChangePassword: false, tokenVersion: newUser.tokenVersion })
    const refreshToken = tokenService.signRefreshToken({ username: newUser.username, tokenVersion: newUser.tokenVersion })
    res.json({ accessToken, refreshToken, username: newUser.username, roles: newUser.roles, mustChangePassword: false })
  })
}

const setupAuth = (expressApp) => {
  const userStore = createUserStore()
  if (!userStore.hasUsers()) throw new Error(`No users configured. Run: npm run user -- init`)

  const tokenService = createTokenService()
  const authProvider = createLocalAuthProvider(userStore)

  expressApp.use(parseCookiesMiddleware)

  const authEnv = {
    authProvider, tokenService, userStore,
    publicPaths: ['/auth/login', '/auth/refresh', '/auth/logout', '/instance', '/auth/status'],
  }
  expressApp.post('/api/auth/login', express.json(), loginHandlerR.run(authEnv))
  expressApp.post('/api/auth/refresh', express.json(), refreshHandlerR.run(authEnv))
  expressApp.post('/api/auth/logout', express.json(), logoutHandlerR.run(authEnv))
  expressApp.get('/api/auth/status', (_req, res) => {
    const users = userStore.listUsers() || []
    res.json({ username: users.length > 0 ? users[0].username : null })
  })
  expressApp.use('/api', authMiddlewareR.run(authEnv))

  mountChangePasswordHandler(expressApp, { authProvider, tokenService, userStore })

  return { authEnabled: true, userStore, tokenService, authProvider }
}

export { setupAuth }
