/**
 * Auth E2E — REST flows (AE1-12).
 *  AE1.  미인증 요청 → 401
 *  AE2.  로그인 성공 → accessToken + refreshToken 쿠키
 *  AE3.  로그인 실패 → 사용자 존재 미노출
 *  AE4.  인증된 요청 → 정상 동작
 *  AE5.  잘못된 토큰 → 401
 *  AE6.  만료된 토큰 → 401
 *  AE7.  Refresh → 새 accessToken + rotated refreshToken
 *  AE8.  폐기된 refresh jti → 탈취 감지
 *  AE9.  비밀번호 변경 후 refresh → 401
 *  AE10. Logout → 쿠키 만료 + jti 폐기
 *  AE11. /api/instance (public) → authRequired: true
 *  AE12. Rate limiting → 429
 */

import { rmSync } from 'node:fs'
import { createTokenService, sign } from '@presence/infra/infra/auth/token.js'
import { assert, summary } from '../../../test/lib/assert.js'
import { createMockLLM, request, setupAuthServer } from './auth-e2e-helpers.js'

async function run() {
  console.log('Auth E2E — REST flows (AE1-12)')

  const mockLLM = createMockLLM()
  const llmPort = await mockLLM.start()

  // AE1. 미인증 요청 → 401
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const res = await request(port, 'GET', '/api/sessions/testuser-default/state')
      assert(res.status === 401, 'AE1: unauthenticated GET state → 401')

      const res2 = await request(port, 'POST', '/api/sessions/testuser-default/chat', { input: 'hello' })
      assert(res2.status === 401, 'AE1: unauthenticated POST chat → 401')

      const res3 = await request(port, 'GET', '/api/sessions/testuser-default/tools')
      assert(res3.status === 401, 'AE1: unauthenticated GET tools → 401')
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // AE2. 로그인 성공
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const res = await request(port, 'POST', '/api/auth/login', { username: 'testuser', password: 'testpassword123' })
      assert(res.status === 200, 'AE2: login returns 200')
      assert(typeof res.body.accessToken === 'string', 'AE2: has accessToken')
      assert(res.body.username === 'testuser', 'AE2: username in response')
      assert(Array.isArray(res.body.roles), 'AE2: roles in response')

      const refreshCookie = res.setCookie.find(c => c.startsWith('refreshToken='))
      assert(refreshCookie, 'AE2: refreshToken cookie set')
      assert(refreshCookie.includes('HttpOnly'), 'AE2: cookie is HttpOnly')
      assert(refreshCookie.includes('SameSite=Strict'), 'AE2: cookie is SameSite=Strict')
      assert(refreshCookie.includes('Path=/'), 'AE2: cookie path is /')
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // AE3. 로그인 실패 — 사용자 존재 미노출
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const res1 = await request(port, 'POST', '/api/auth/login', { username: 'testuser', password: 'wrongpassword' })
      assert(res1.status === 401, 'AE3: wrong password → 401')
      assert(res1.body.error?.message === 'Invalid credentials', 'AE3: generic error (wrong password)')

      const res2 = await request(port, 'POST', '/api/auth/login', { username: 'nonexistent', password: 'password123' })
      assert(res2.status === 401, 'AE3: nonexistent user → 401')
      assert(res2.body.error?.message === 'Invalid credentials', 'AE3: same generic error (nonexistent user)')
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // AE4. 인증된 요청 → 정상 동작
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const loginRes = await request(port, 'POST', '/api/auth/login', { username: 'testuser', password: 'testpassword123' })
      const token = loginRes.body.accessToken

      const sid = 'testuser-default'
      const stateRes = await request(port, 'GET', `/api/sessions/${sid}/state`, null, { token })
      assert(stateRes.status === 200, 'AE4: authenticated GET state → 200')
      assert(stateRes.body.turnState?.tag === 'idle', 'AE4: state is idle')

      const chatRes = await request(port, 'POST', `/api/sessions/${sid}/chat`, { input: 'hello' }, { token })
      assert(chatRes.status === 200, 'AE4: authenticated POST chat → 200')

      const toolsRes = await request(port, 'GET', `/api/sessions/${sid}/tools`, null, { token })
      assert(toolsRes.status === 200, 'AE4: authenticated GET tools → 200')
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // AE5. 잘못된 토큰 → 401
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const res = await request(port, 'GET', '/api/sessions/testuser-default/state', null, { token: 'invalid.token.here' })
      assert(res.status === 401, 'AE5: invalid token → 401')
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // AE6. 만료된 토큰 → 401
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const tokenService = createTokenService({ basePath: tmpDir })
      const expiredToken = sign({
        sub: 'testuser', roles: ['admin'], iss: 'presence', aud: 'presence',
        iat: 1000, exp: 1001,
      }, tokenService.secret)

      const res = await request(port, 'GET', '/api/sessions/testuser-default/state', null, { token: expiredToken })
      assert(res.status === 401, 'AE6: expired token → 401')
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // AE7. Refresh → 새 accessToken + rotated refreshToken
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const loginRes = await request(port, 'POST', '/api/auth/login', { username: 'testuser', password: 'testpassword123' })
      const refreshCookie = loginRes.setCookie.find(c => c.startsWith('refreshToken='))
      const refreshTokenValue = refreshCookie.split('=')[1].split(';')[0]

      const refreshRes = await request(port, 'POST', '/api/auth/refresh', {}, { cookie: `refreshToken=${refreshTokenValue}` })
      assert(refreshRes.status === 200, 'AE7: refresh returns 200')
      assert(typeof refreshRes.body.accessToken === 'string', 'AE7: new accessToken')

      const stateRes = await request(port, 'GET', '/api/sessions/testuser-default/state', null, { token: refreshRes.body.accessToken })
      assert(stateRes.status === 200, 'AE7: new access token works')

      const newRefreshCookie = refreshRes.setCookie.find(c => c.startsWith('refreshToken='))
      assert(newRefreshCookie, 'AE7: new refreshToken cookie set')
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // AE8. 폐기된 refresh jti → 탈취 감지
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const loginRes = await request(port, 'POST', '/api/auth/login', { username: 'testuser', password: 'testpassword123' })
      const refreshCookie = loginRes.setCookie.find(c => c.startsWith('refreshToken='))
      const refreshTokenValue = refreshCookie.split('=')[1].split(';')[0]

      await request(port, 'POST', '/api/auth/refresh', {}, { cookie: `refreshToken=${refreshTokenValue}` })

      const replayRes = await request(port, 'POST', '/api/auth/refresh', {}, { cookie: `refreshToken=${refreshTokenValue}` })
      assert(replayRes.status === 401, 'AE8: replayed refresh token → 401')
      const errMsg = replayRes.body.error?.message || replayRes.body.error || ''
      assert(errMsg.includes('revoked') || errMsg.includes('theft'), 'AE8: theft detection message')
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // AE9. 비밀번호 변경 후 refresh → 401
  {
    const { server, shutdown, tmpDir, userStore } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const loginRes = await request(port, 'POST', '/api/auth/login', { username: 'testuser', password: 'testpassword123' })
      const refreshCookie = loginRes.setCookie.find(c => c.startsWith('refreshToken='))
      const refreshTokenValue = refreshCookie.split('=')[1].split(';')[0]

      await userStore.changePassword('testuser', 'newpassword456')

      const refreshRes = await request(port, 'POST', '/api/auth/refresh', {}, { cookie: `refreshToken=${refreshTokenValue}` })
      assert(refreshRes.status === 401, 'AE9: refresh after password change → 401')
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // AE10. Logout → 쿠키 만료 + jti 폐기
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const loginRes = await request(port, 'POST', '/api/auth/login', { username: 'testuser', password: 'testpassword123' })
      const token = loginRes.body.accessToken
      const refreshCookie = loginRes.setCookie.find(c => c.startsWith('refreshToken='))
      const refreshTokenValue = refreshCookie.split('=')[1].split(';')[0]

      const logoutRes = await request(port, 'POST', '/api/auth/logout', {}, { token, cookie: `refreshToken=${refreshTokenValue}` })
      assert(logoutRes.status === 200, 'AE10: logout returns 200')

      const expiredCookie = logoutRes.setCookie.find(c => c.startsWith('refreshToken='))
      assert(expiredCookie && expiredCookie.includes('Max-Age=0'), 'AE10: cookie expired')

      const refreshRes = await request(port, 'POST', '/api/auth/refresh', {}, { cookie: `refreshToken=${refreshTokenValue}` })
      assert(refreshRes.status === 401, 'AE10: refresh after logout → 401')
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // AE11. /api/instance (public) → authRequired: true
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const res = await request(port, 'GET', '/api/instance')
      assert(res.status === 200, 'AE11: /api/instance → 200 (public)')
      assert(res.body.authRequired === true, 'AE11: authRequired is true')
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // AE12. Rate limiting → 429
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      for (let i = 0; i < 5; i++) {
        await request(port, 'POST', '/api/auth/login', { username: 'testuser', password: 'wrong' })
      }
      const res = await request(port, 'POST', '/api/auth/login', { username: 'testuser', password: 'wrong' })
      assert(res.status === 429, 'AE12: rate limit → 429')
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  await mockLLM.close()
  summary()
}

run()
