import { HttpAuthService } from '@presence/infra/infra/auth/http-service.js'
import { WsAuthService } from '@presence/infra/infra/auth/ws-service.js'
import { AUTH_ERROR } from '@presence/infra/infra/auth/policy.js'
import fp from '@presence/core/lib/fun-fp.js'
import { assert, summary } from '../lib/assert.js'

const { Either } = fp
const isRight = (e) => Either.fold(() => false, () => true, e)
const isLeft = (e) => Either.fold(() => true, () => false, e)
const getRight = (e) => Either.fold(() => null, v => v, e)
const getLeft = (e) => Either.fold(v => v, () => null, e)

// --- Mock 팩토리 ---

const createMockTokenService = () => ({
  signAccessToken: ({ sub, roles }) => `access-${sub}`,
  signRefreshToken: ({ sub, tokenVersion }) => ({ token: `refresh-${sub}`, jti: `jti-${sub}-${Date.now()}` }),
  verifyAccessToken: (token) => token.startsWith('access-')
    ? Either.Right({ sub: token.slice(7), roles: ['admin'], mustChangePassword: false })
    : Either.Left('invalid'),
  verifyRefreshToken: (token) => token.startsWith('refresh-')
    ? Either.Right({ sub: token.slice(8), jti: `jti-${token.slice(8)}`, tokenVersion: 0, type: 'refresh' })
    : Either.Left('invalid'),
})

// bcrypt.hash('correct', 12)
const ALICE_HASH = '$2a$12$ECv4Z.maMXLC.p78GUDsaeJxY44XqjtwahHMclzZelQjlR9X7XsWG'

const createMockUserStore = () => {
  const refreshSessions = new Map()
  const users = new Map([
    ['alice', { username: 'alice', passwordHash: ALICE_HASH, roles: ['admin'], tokenVersion: 0, mustChangePassword: false }],
  ])
  return {
    findUser: (name) => users.get(name) || null,
    hasUsers: () => users.size > 0,
    addRefreshSession: (name, jti) => {
      const list = refreshSessions.get(name) || []
      list.push(jti)
      refreshSessions.set(name, list)
    },
    hasRefreshSession: (name, jti) => (refreshSessions.get(name) || []).includes(jti),
    removeRefreshSession: (name, jti) => {
      const list = (refreshSessions.get(name) || []).filter(j => j !== jti)
      refreshSessions.set(name, list)
    },
    revokeAllRefreshSessions: (name) => refreshSessions.set(name, []),
    changePassword: async () => {},
    _refreshSessions: refreshSessions,
  }
}

const createMockRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    cookies: {},
    status(code) { res.statusCode = code; return res },
    json(data) { res.body = data; return res },
    cookie(name, value, opts) { res.cookies[name] = { value, opts } },
  }
  return res
}

const createMockReq = (overrides = {}) => ({
  headers: {},
  body: {},
  cookies: {},
  ip: '127.0.0.1',
  socket: { remoteAddress: '127.0.0.1' },
  path: '/chat',
  ...overrides,
})

async function run() {
  console.log('Auth Service (class hierarchy) tests')

  const tokenService = createMockTokenService()
  const userStore = createMockUserStore()

  const httpAuth = new HttpAuthService(tokenService, userStore, {
    publicPaths: ['/auth/login', '/auth/refresh'],
  })
  const wsAuth = new WsAuthService(tokenService, userStore)

  // =================================================================
  // 1. AuthService.issueTokens
  // =================================================================

  {
    const tokens = httpAuth.issueTokens({ username: 'alice', roles: ['admin'], tokenVersion: 0 })
    assert(tokens.accessToken === 'access-alice', 'issueTokens: accessToken')
    assert(tokens.refreshToken.startsWith('refresh-'), 'issueTokens: refreshToken')
    assert(tokens.user.username === 'alice', 'issueTokens: user preserved')
  }

  // =================================================================
  // 2. AuthService.validateRefreshChain
  // =================================================================

  {
    userStore.addRefreshSession('alice', 'jti-alice')
    const result = httpAuth.validateRefreshChain('refresh-alice')
    assert(isRight(result), 'validateRefreshChain: valid token → Right')
    assert(getRight(result).user.username === 'alice', 'validateRefreshChain: user in Right')
  }

  {
    const result = httpAuth.validateRefreshChain(null)
    assert(isLeft(result), 'validateRefreshChain: null → Left')
  }

  {
    const result = httpAuth.validateRefreshChain('invalid-token')
    assert(isLeft(result), 'validateRefreshChain: invalid token → Left')
  }

  // =================================================================
  // 3. AuthService.rotateRefresh
  // =================================================================

  {
    userStore.addRefreshSession('alice', 'jti-rotate-test')
    const tokens = httpAuth.rotateRefresh({ user: { username: 'alice', roles: ['admin'], tokenVersion: 0 }, jti: 'jti-rotate-test' })
    assert(tokens.accessToken === 'access-alice', 'rotateRefresh: new accessToken')
    assert(!userStore.hasRefreshSession('alice', 'jti-rotate-test'), 'rotateRefresh: old jti removed')
  }

  // =================================================================
  // 4. HttpAuthService.authMiddleware
  // =================================================================

  {
    const middleware = httpAuth.authMiddleware()
    // public path → next
    let nextCalled = false
    const req = createMockReq({ path: '/auth/login' })
    middleware(req, createMockRes(), () => { nextCalled = true })
    assert(nextCalled, 'authMiddleware: public path → next()')
  }

  {
    const middleware = httpAuth.authMiddleware()
    // 인증 없음 → 401
    const res = createMockRes()
    middleware(createMockReq(), res, () => {})
    assert(res.statusCode === 401, 'authMiddleware: no auth → 401')
  }

  {
    const middleware = httpAuth.authMiddleware()
    // 유효한 Bearer → next + req.user (Principal shape)
    const req = createMockReq({ headers: { authorization: 'Bearer access-alice' } })
    let nextCalled = false
    middleware(req, createMockRes(), () => { nextCalled = true })
    assert(nextCalled, 'authMiddleware: valid Bearer → next()')
    assert(req.user?.username === 'alice', 'authMiddleware: req.user.username set')
    assert(Array.isArray(req.user?.roles), 'authMiddleware: req.user.roles is array')
  }

  // =================================================================
  // 5. HttpAuthService.loginHandler
  // =================================================================

  {
    const handler = httpAuth.loginHandler()
    const res = createMockRes()
    const req = createMockReq({ body: { username: 'alice', password: 'correct' } })
    await new Promise(resolve => {
      const origJson = res.json.bind(res)
      res.json = (data) => { origJson(data); resolve() }
      handler(req, res)
    })
    assert(res.statusCode === 200, 'loginHandler: success → 200')
    assert(res.body?.accessToken === 'access-alice', 'loginHandler: accessToken in response')
    assert(res.cookies.refreshToken, 'loginHandler: refresh cookie set')
  }

  {
    const handler = httpAuth.loginHandler()
    const res = createMockRes()
    const req = createMockReq({ body: { username: 'alice', password: 'wrong' } })
    await new Promise(resolve => {
      const origJson = res.json.bind(res)
      res.json = (data) => { origJson(data); resolve() }
      handler(req, res)
    })
    assert(res.statusCode === 401, 'loginHandler: wrong password → 401')
  }

  {
    const handler = httpAuth.loginHandler()
    const res = createMockRes()
    const req = createMockReq({ body: {} })
    handler(req, res)
    assert(res.statusCode === 400, 'loginHandler: missing credentials → 400')
  }

  // =================================================================
  // 6. HttpAuthService.refreshHandler
  // =================================================================

  {
    userStore.addRefreshSession('alice', 'jti-alice')
    const handler = httpAuth.refreshHandler()
    const res = createMockRes()
    const req = createMockReq({ cookies: { refreshToken: 'refresh-alice' } })
    handler(req, res)
    assert(res.statusCode === 200, 'refreshHandler: valid refresh → 200')
    assert(res.body?.accessToken, 'refreshHandler: new accessToken')
  }

  {
    const handler = httpAuth.refreshHandler()
    const res = createMockRes()
    const req = createMockReq({ cookies: {} })
    handler(req, res)
    assert(res.statusCode === 401, 'refreshHandler: no token → 401')
  }

  // =================================================================
  // 7. HttpAuthService.logoutHandler
  // =================================================================

  {
    const handler = httpAuth.logoutHandler()
    const res = createMockRes()
    handler(createMockReq({ cookies: { refreshToken: 'refresh-alice' } }), res)
    assert(res.body?.ok === true, 'logoutHandler: ok response')
    assert(res.cookies.refreshToken, 'logoutHandler: cookie set (cleared)')
    assert(res.cookies.refreshToken.opts?.maxAge === 0, 'logoutHandler: cookie maxAge is 0')
  }

  // =================================================================
  // 7b. HttpAuthService.changePasswordHandler
  // =================================================================

  // CP1: 짧은 비밀번호 → 400 (Task 반환 일관성 검증)
  {
    const handler = httpAuth.changePasswordHandler()
    const res = createMockRes()
    const req = createMockReq({
      body: { currentPassword: 'correct', newPassword: 'short' },
      path: '/auth/change-password',
    })
    req.user = { username: 'alice' }
    await new Promise(resolve => {
      const origJson = res.json.bind(res)
      res.json = (data) => { origJson(data); resolve() }
      handler(req, res)
    })
    assert(res.statusCode === 400, 'changePassword: short password → 400')
  }

  // CP2: 잘못된 현재 비밀번호 → 401
  {
    const handler = httpAuth.changePasswordHandler()
    const res = createMockRes()
    const req = createMockReq({
      body: { currentPassword: 'wrong', newPassword: 'newpassword123' },
      path: '/auth/change-password',
    })
    req.user = { username: 'alice' }
    await new Promise(resolve => {
      const origJson = res.json.bind(res)
      res.json = (data) => { origJson(data); resolve() }
      handler(req, res)
    })
    assert(res.statusCode === 401, 'changePassword: wrong current password → 401')
  }

  // CP3: 성공 → 200 + 새 토큰
  {
    const handler = httpAuth.changePasswordHandler()
    const res = createMockRes()
    const req = createMockReq({
      body: { currentPassword: 'correct', newPassword: 'newpassword123' },
      path: '/auth/change-password',
    })
    req.user = { username: 'alice' }
    await new Promise(resolve => {
      const origJson = res.json.bind(res)
      res.json = (data) => { origJson(data); resolve() }
      handler(req, res)
    })
    assert(res.statusCode === 200, 'changePassword: success → 200')
    assert(res.body?.accessToken, 'changePassword: accessToken in response')
    assert(res.body?.mustChangePassword === false, 'changePassword: mustChangePassword false')
  }

  // =================================================================
  // 8. WsAuthService.authenticateUpgrade
  // =================================================================

  // WS1: header access token → 성공
  {
    const result = wsAuth.authenticateUpgrade(createMockReq({ headers: { authorization: 'Bearer access-alice' } }))
    assert(isRight(result), 'WS header: valid → Right')
    const principal = getRight(result)
    assert(principal.username === 'alice', 'WS header: username')
    assert(Array.isArray(principal.roles), 'WS header: roles is array')
    assert(principal.mustChangePassword === false, 'WS header: mustChangePassword')
  }

  // WS2: query access token → 성공
  {
    const result = wsAuth.authenticateUpgrade(createMockReq({ url: '/ws?token=access-alice' }))
    assert(isRight(result), 'WS query: valid → Right')
    const principal = getRight(result)
    assert(principal.username === 'alice', 'WS query: username')
  }

  // WS3: cookie refresh fallback → 성공, Principal shape 동일
  {
    userStore.addRefreshSession('alice', 'jti-alice')
    const result = wsAuth.authenticateUpgrade(createMockReq({ headers: { cookie: 'refreshToken=refresh-alice' } }))
    assert(isRight(result), 'WS cookie: valid → Right')
    const principal = getRight(result)
    assert(principal.username === 'alice', 'WS cookie: username (same shape as header)')
    assert(Array.isArray(principal.roles), 'WS cookie: roles')
    assert(typeof principal.mustChangePassword === 'boolean', 'WS cookie: mustChangePassword present')
  }

  // WS7: 모든 경로 부재 → Left(NO_TOKEN)
  {
    const result = wsAuth.authenticateUpgrade(createMockReq())
    assert(isLeft(result), 'WS no auth: Left')
    assert(getLeft(result).code === AUTH_ERROR.NO_TOKEN, 'WS no auth: NO_TOKEN code')
  }

  // WS5: revoked session → cookie 경로 실패, fallback 중단
  {
    // jti가 없는 상태에서 cookie만 있음
    userStore.revokeAllRefreshSessions('alice')
    const result = wsAuth.authenticateUpgrade(createMockReq({ headers: { cookie: 'refreshToken=refresh-alice' } }))
    assert(isLeft(result), 'WS revoked: Left')
    assert(getLeft(result).code === AUTH_ERROR.TOKEN_REVOKED, 'WS revoked: TOKEN_REVOKED code')
  }

  // WS8: Principal shape 일관성 — 모든 성공 경로가 동일한 키를 가짐
  {
    userStore.addRefreshSession('alice', 'jti-alice')
    const headerP = getRight(wsAuth.authenticateUpgrade(createMockReq({ headers: { authorization: 'Bearer access-alice' } })))
    const queryP = getRight(wsAuth.authenticateUpgrade(createMockReq({ url: '/ws?token=access-alice' })))
    const cookieP = getRight(wsAuth.authenticateUpgrade(createMockReq({ headers: { cookie: 'refreshToken=refresh-alice' } })))
    const keys = ['username', 'roles', 'mustChangePassword']
    for (const key of keys) {
      assert(key in headerP, `WS shape: header has ${key}`)
      assert(key in queryP, `WS shape: query has ${key}`)
      assert(key in cookieP, `WS shape: cookie has ${key}`)
    }
  }

  summary()
}

run().catch(err => { console.error(err); process.exit(1) })
