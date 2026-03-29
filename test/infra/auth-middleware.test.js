import {
  loginHandlerR, refreshHandlerR, logoutHandlerR,
  authMiddlewareR, authenticateWsR,
  issueTokensR, validateRefreshChainR, rotateRefreshTokenR,
} from '@presence/infra/infra/auth-middleware.js'
import fp from '@presence/core/lib/fun-fp.js'
import { assert, summary } from '../lib/assert.js'

const { Either, Task } = fp
const isRight = (e) => Either.fold(() => false, () => true, e)
const isLeft = (e) => Either.fold(() => true, () => false, e)
const getRight = (e) => Either.fold(() => null, v => v, e)
const getLeft = (e) => Either.fold(v => v, () => null, e)

// --- Mock 팩토리 ---

const createMockTokenService = () => ({
  signAccessToken: ({ sub, roles }) => `access-${sub}`,
  signRefreshToken: ({ sub, tokenVersion }) => ({ token: `refresh-${sub}`, jti: `jti-${sub}-${Date.now()}` }),
  verifyAccessToken: (token) => token.startsWith('access-')
    ? Either.Right({ sub: token.slice(7), roles: ['admin'] })
    : Either.Left('invalid'),
  verifyRefreshToken: (token) => token.startsWith('refresh-')
    ? Either.Right({ sub: token.slice(8), jti: `jti-${token.slice(8)}`, tokenVersion: 0 })
    : Either.Left('invalid'),
})

const createMockUserStore = () => {
  const refreshSessions = new Map()
  const users = new Map([
    ['alice', { username: 'alice', passwordHash: '$2b$12$...', roles: ['admin'], tokenVersion: 0 }],
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
    _refreshSessions: refreshSessions,
  }
}

const createMockAuthProvider = () => ({
  authenticate: (username, password) =>
    Task.fromPromise(() =>
      username === 'alice' && password === 'correct'
        ? Promise.resolve(Either.Right({ username: 'alice', roles: ['admin'], tokenVersion: 0 }))
        : Promise.resolve(Either.Left('Invalid credentials'))
    )(),
})

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
  console.log('Auth Middleware (Reader) tests')

  const tokenService = createMockTokenService()
  const userStore = createMockUserStore()
  const authProvider = createMockAuthProvider()
  const authEnv = { authProvider, tokenService, userStore, publicPaths: ['/auth/login', '/auth/refresh'] }

  // =================================================================
  // 1. issueTokensR
  // =================================================================

  {
    const tokens = issueTokensR({ username: 'alice', roles: ['admin'], tokenVersion: 0 }).run(authEnv)
    assert(tokens.accessToken === 'access-alice', 'issueTokensR: accessToken')
    assert(tokens.refreshToken.startsWith('refresh-'), 'issueTokensR: refreshToken')
    assert(tokens.user.username === 'alice', 'issueTokensR: user preserved')
  }

  // =================================================================
  // 2. validateRefreshChainR
  // =================================================================

  {
    // 먼저 refresh session 등록
    userStore.addRefreshSession('alice', 'jti-alice')
    const result = validateRefreshChainR('refresh-alice').run(authEnv)
    assert(isRight(result), 'validateRefreshChainR: valid token → Right')
    assert(getRight(result).user.username === 'alice', 'validateRefreshChainR: user in Right')
  }

  {
    const result = validateRefreshChainR(null).run(authEnv)
    assert(isLeft(result), 'validateRefreshChainR: null → Left')
  }

  {
    const result = validateRefreshChainR('invalid-token').run(authEnv)
    assert(isLeft(result), 'validateRefreshChainR: invalid token → Left')
  }

  // =================================================================
  // 3. rotateRefreshTokenR — Reader 합성
  // =================================================================

  {
    userStore.addRefreshSession('alice', 'jti-rotate-test')
    const tokens = rotateRefreshTokenR({ user: { username: 'alice', roles: ['admin'], tokenVersion: 0 }, jti: 'jti-rotate-test' }).run(authEnv)
    assert(tokens.accessToken === 'access-alice', 'rotateRefreshTokenR: new accessToken')
    assert(!userStore.hasRefreshSession('alice', 'jti-rotate-test'), 'rotateRefreshTokenR: old jti removed')
  }

  // =================================================================
  // 4. authMiddlewareR
  // =================================================================

  {
    const middleware = authMiddlewareR.run(authEnv)
    // public path → next() 호출
    let nextCalled = false
    const req = createMockReq({ path: '/auth/login' })
    middleware(req, createMockRes(), () => { nextCalled = true })
    assert(nextCalled, 'authMiddlewareR: public path → next()')
  }

  {
    const middleware = authMiddlewareR.run(authEnv)
    // 인증 없음 → 401
    const res = createMockRes()
    middleware(createMockReq(), res, () => {})
    assert(res.statusCode === 401, 'authMiddlewareR: no auth → 401')
  }

  {
    const middleware = authMiddlewareR.run(authEnv)
    // 유효한 Bearer → next() + req.user
    const req = createMockReq({ headers: { authorization: 'Bearer access-alice' } })
    let nextCalled = false
    middleware(req, createMockRes(), () => { nextCalled = true })
    assert(nextCalled, 'authMiddlewareR: valid Bearer → next()')
    assert(req.user?.sub === 'alice', 'authMiddlewareR: req.user set')
  }

  // =================================================================
  // 5. loginHandlerR
  // =================================================================

  {
    const handler = loginHandlerR.run(authEnv)
    const res = createMockRes()
    const req = createMockReq({ body: { username: 'alice', password: 'correct' } })
    await new Promise(resolve => {
      const origJson = res.json.bind(res)
      res.json = (data) => { origJson(data); resolve() }
      handler(req, res)
    })
    assert(res.statusCode === 200, 'loginHandlerR: success → 200')
    assert(res.body?.accessToken === 'access-alice', 'loginHandlerR: accessToken in response')
    assert(res.cookies.refreshToken, 'loginHandlerR: refresh cookie set')
  }

  {
    const handler = loginHandlerR.run(authEnv)
    const res = createMockRes()
    const req = createMockReq({ body: { username: 'alice', password: 'wrong' } })
    await new Promise(resolve => {
      const origJson = res.json.bind(res)
      res.json = (data) => { origJson(data); resolve() }
      handler(req, res)
    })
    assert(res.statusCode === 401, 'loginHandlerR: wrong password → 401')
  }

  {
    const handler = loginHandlerR.run(authEnv)
    const res = createMockRes()
    const req = createMockReq({ body: {} })
    handler(req, res)
    assert(res.statusCode === 400, 'loginHandlerR: missing credentials → 400')
  }

  // =================================================================
  // 6. refreshHandlerR
  // =================================================================

  {
    userStore.addRefreshSession('alice', 'jti-alice')
    const handler = refreshHandlerR.run(authEnv)
    const res = createMockRes()
    const req = createMockReq({ cookies: { refreshToken: 'refresh-alice' } })
    handler(req, res)
    assert(res.statusCode === 200, 'refreshHandlerR: valid refresh → 200')
    assert(res.body?.accessToken, 'refreshHandlerR: new accessToken')
  }

  {
    const handler = refreshHandlerR.run(authEnv)
    const res = createMockRes()
    const req = createMockReq({ cookies: {} })
    handler(req, res)
    assert(res.statusCode === 401, 'refreshHandlerR: no token → 401')
  }

  // =================================================================
  // 7. logoutHandlerR
  // =================================================================

  {
    const handler = logoutHandlerR.run(authEnv)
    const res = createMockRes()
    handler(createMockReq({ cookies: { refreshToken: 'refresh-alice' } }), res)
    assert(res.body?.ok === true, 'logoutHandlerR: ok response')
    assert(res.cookies.refreshToken?.opts?.maxAge === 0, 'logoutHandlerR: cookie cleared')
  }

  // =================================================================
  // 8. authenticateWsR
  // =================================================================

  {
    const result = authenticateWsR(createMockReq({ headers: { authorization: 'Bearer access-alice' } })).run(authEnv)
    assert(isRight(result), 'authenticateWsR: valid header → Right')
    assert(getRight(result).sub === 'alice', 'authenticateWsR: sub in payload')
  }

  {
    const result = authenticateWsR(createMockReq()).run(authEnv)
    assert(isLeft(result), 'authenticateWsR: no auth → Left')
  }

  summary()
}

run().catch(err => { console.error(err); process.exit(1) })
