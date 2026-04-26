import express from 'express'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import { createTokenService } from '@presence/infra/infra/auth/token.js'
import { HttpAuthService } from '@presence/infra/infra/auth/http-service.js'
import { WsAuthService } from '@presence/infra/infra/auth/ws-service.js'

// =============================================================================
// Auth setup: 인증 미들웨어 + 라우터 생성. expressApp을 직접 변이하지 않는다.
// PresenceServer.#mountRoutes()에서 순서대로 마운트.
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

const createAuthSetup = (opts = {}) => {
  const userStore = createUserStore()
  if (!userStore.hasUsers()) throw new Error('No users configured. Run: npm run user -- init')

  const tokenService = createTokenService()

  const publicPaths = ['/auth/login', '/auth/refresh', '/auth/logout', '/instance', '/auth/status']
  // onPasswordChanged: 비밀번호 변경 성공 시 호출 (admin-bootstrap §7.3 의 initial-password 파일 삭제 연계)
  const httpAuth = new HttpAuthService(tokenService, userStore, { publicPaths, onPasswordChanged: opts.onPasswordChanged })
  const wsAuth = new WsAuthService(tokenService, userStore)

  // 인증 불필요 라우트 (login, refresh, logout, status)
  const publicRouter = express.Router()
  publicRouter.post('/login', express.json(), httpAuth.loginHandler())
  publicRouter.post('/refresh', express.json(), httpAuth.refreshHandler())
  publicRouter.post('/logout', express.json(), httpAuth.logoutHandler())
  publicRouter.get('/status', (_req, res) => {
    const users = userStore.listUsers() || []
    res.json({ username: users.length > 0 ? users[0].username : null })
  })

  // 인증 필요 라우트 (change-password)
  const protectedRouter = express.Router()
  protectedRouter.post('/change-password', express.json(), httpAuth.changePasswordHandler())

  return {
    cookieParser: parseCookiesMiddleware,
    publicRouter,              // mount at /api/auth — before authMiddleware
    authMiddleware: httpAuth.authMiddleware(), // mount at /api
    protectedRouter,           // mount at /api/auth — after authMiddleware
    wsAuth,
    tokenService,              // KG-17: A2A router / delegate interpreter 가 signA2aToken/verifyA2aToken 사용
  }
}

export { createAuthSetup }
