/**
 * Auth E2E tests — startServer() + Auth 미들웨어 + Mock LLM
 *
 * 커버하는 시나리오:
 *  AE1.  인증 활성화 시 미인증 요청 → 401
 *  AE2.  로그인 성공 → accessToken + refreshToken 쿠키
 *  AE3.  로그인 실패 → 401, 사용자 존재 미노출
 *  AE4.  인증된 요청 → 정상 동작 (chat, state, tools)
 *  AE5.  잘못된 토큰 → 401
 *  AE6.  만료된 토큰 → 401
 *  AE7.  Refresh → 새 accessToken + rotated refreshToken
 *  AE8.  폐기된 refresh jti → 탈취 감지, 모든 세션 폐기
 *  AE9.  비밀번호 변경 후 refresh → 401 (tokenVersion 변경)
 *  AE10. Logout → 쿠키 만료 + jti 폐기
 *  AE11. /api/instance (public) → authRequired: true
 *  AE12. Rate limiting → 5회 초과 시 429
 *  AE13. WS 미인증 → 4001 close
 *  AE14. WS 인증 → init 메시지 수신
 */

import http from 'node:http'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebSocket } from 'ws'
import { startServer } from '@presence/server'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import { createTokenService, sign } from '@presence/infra/infra/auth/token.js'
import { ensureSecret } from '@presence/infra/infra/auth/token.js'
import { assert, summary } from '../../../test/lib/assert.js'

const delay = (ms) => new Promise(r => setTimeout(r, ms))

const createMockLLM = () => {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const content = JSON.stringify({ type: 'direct_response', message: '응답' })
      const parsed = JSON.parse(body)
      if (parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content } }] }))
      }
    })
  })
  return {
    start: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise(r => server.close(r)),
  }
}

const request = (port, method, path, body, { token, cookie } = {}) =>
  new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const headers = {
      'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(cookie ? { 'Cookie': cookie } : {}),
    }
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      let buf = ''
      const setCookie = res.headers['set-cookie'] || []
      res.on('data', d => { buf += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf), setCookie }) }
        catch { resolve({ status: res.statusCode, body: buf, setCookie }) }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })

const connectWS = (port, { token } = {}) =>
  new Promise((resolve, reject) => {
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {}
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
    const messages = []
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())))
    ws.on('open', () => resolve({ ws, messages }))
    ws.on('error', reject)
    ws.on('close', (code) => resolve({ ws: null, messages, closeCode: code }))
    setTimeout(() => resolve({ ws: null, messages, closeCode: 'timeout' }), 3000)
  })

// 테스트 환경: 인스턴스 설정 + 사용자 등록
const setupAuthServer = async (llmPort) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'auth-e2e-'))
  const instanceId = 'auth-test'
  mkdirSync(join(tmpDir, 'instances'), { recursive: true })

  // 인스턴스 설정
  const { writeFileSync } = await import('fs')
  writeFileSync(join(tmpDir, 'instances', `${instanceId}.json`), JSON.stringify({
    memory: { path: join(tmpDir, 'memory') },
  }))
  writeFileSync(join(tmpDir, 'server.json'), JSON.stringify({
    llm: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: 'test', apiKey: 'k', responseFormat: 'json_object', maxRetries: 0, timeoutMs: 5000 },
    embed: { provider: 'openai', baseUrl: null, apiKey: null, model: null, dimensions: 256 },
    locale: 'ko', maxIterations: 5,
    mcp: [],
    scheduler: { enabled: false, pollIntervalMs: 60000, todoReview: { enabled: false, cron: '0 9 * * *' } },
    delegatePolling: { intervalMs: 60000 },
    prompt: { maxContextTokens: 8000, reservedOutputTokens: 1000, maxContextChars: null, reservedOutputChars: null },
  }))

  // 사용자 등록
  ensureSecret({ basePath: tmpDir })
  const userStore = createUserStore({ basePath: tmpDir })
  await userStore.addUser('testuser', 'testpassword123')
  // addUser는 mustChangePassword: true → changePassword로 해제
  await userStore.changePassword('testuser', 'testpassword123')

  // PRESENCE_DIR을 설정해야 서버 내부의 createUserStore/createTokenService가 올바른 경로 사용
  const origDir = process.env.PRESENCE_DIR
  process.env.PRESENCE_DIR = tmpDir

  // 서버 시작
  const { loadUserMerged } = await import('@presence/infra/infra/config-loader.js')
  const config = loadUserMerged(instanceId, { basePath: tmpDir })
  const result = await startServer(config, { port: 0, persistenceCwd: tmpDir, instanceId })

  const origShutdown = result.shutdown
  const shutdownWithCleanup = async () => {
    await origShutdown()
    if (origDir) process.env.PRESENCE_DIR = origDir
    else delete process.env.PRESENCE_DIR
  }

  return { ...result, shutdown: shutdownWithCleanup, tmpDir, instanceId, userStore }
}

async function run() {
  console.log('Auth E2E tests')

  const mockLLM = createMockLLM()
  const llmPort = await mockLLM.start()

  // =========================================================================
  // AE1. 미인증 요청 → 401
  // =========================================================================
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

  // =========================================================================
  // AE2. 로그인 성공
  // =========================================================================
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const res = await request(port, 'POST', '/api/auth/login', { username: 'testuser', password: 'testpassword123' })
      assert(res.status === 200, 'AE2: login returns 200')
      assert(typeof res.body.accessToken === 'string', 'AE2: has accessToken')
      assert(res.body.username === 'testuser', 'AE2: username in response')
      assert(Array.isArray(res.body.roles), 'AE2: roles in response')

      // refreshToken 쿠키 확인
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

  // =========================================================================
  // AE3. 로그인 실패 — 사용자 존재 미노출
  // =========================================================================
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

  // =========================================================================
  // AE4. 인증된 요청 → 정상 동작
  // =========================================================================
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

  // =========================================================================
  // AE5. 잘못된 토큰 → 401
  // =========================================================================
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

  // =========================================================================
  // AE6. 만료된 토큰 → 401
  // =========================================================================
  {
    const { server, shutdown, tmpDir, instanceId } = await setupAuthServer(llmPort)
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

  // =========================================================================
  // AE7. Refresh → 새 accessToken + rotated refreshToken
  // =========================================================================
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

      // 새 access token으로 요청
      const stateRes = await request(port, 'GET', '/api/sessions/testuser-default/state', null, { token: refreshRes.body.accessToken })
      assert(stateRes.status === 200, 'AE7: new access token works')

      // rotated refresh cookie
      const newRefreshCookie = refreshRes.setCookie.find(c => c.startsWith('refreshToken='))
      assert(newRefreshCookie, 'AE7: new refreshToken cookie set')
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // AE8. 폐기된 refresh jti → 탈취 감지
  // =========================================================================
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const loginRes = await request(port, 'POST', '/api/auth/login', { username: 'testuser', password: 'testpassword123' })
      const refreshCookie = loginRes.setCookie.find(c => c.startsWith('refreshToken='))
      const refreshTokenValue = refreshCookie.split('=')[1].split(';')[0]

      // 정상 refresh (jti rotation 발생)
      await request(port, 'POST', '/api/auth/refresh', {}, { cookie: `refreshToken=${refreshTokenValue}` })

      // 이전 refresh token으로 다시 시도 → 탈취 감지
      const replayRes = await request(port, 'POST', '/api/auth/refresh', {}, { cookie: `refreshToken=${refreshTokenValue}` })
      assert(replayRes.status === 401, 'AE8: replayed refresh token → 401')
      const errMsg = replayRes.body.error?.message || replayRes.body.error || ''
      assert(errMsg.includes('revoked') || errMsg.includes('theft'), 'AE8: theft detection message')
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // AE9. 비밀번호 변경 후 refresh → 401
  // =========================================================================
  {
    const { server, shutdown, tmpDir, userStore } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const loginRes = await request(port, 'POST', '/api/auth/login', { username: 'testuser', password: 'testpassword123' })
      const refreshCookie = loginRes.setCookie.find(c => c.startsWith('refreshToken='))
      const refreshTokenValue = refreshCookie.split('=')[1].split(';')[0]

      // 비밀번호 변경 (tokenVersion bump)
      await userStore.changePassword('testuser', 'newpassword456')

      // 기존 refresh token → tokenVersion 불일치
      const refreshRes = await request(port, 'POST', '/api/auth/refresh', {}, { cookie: `refreshToken=${refreshTokenValue}` })
      assert(refreshRes.status === 401, 'AE9: refresh after password change → 401')
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // AE10. Logout → 쿠키 만료 + jti 폐기
  // =========================================================================
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

      // 쿠키 만료 확인
      const expiredCookie = logoutRes.setCookie.find(c => c.startsWith('refreshToken='))
      assert(expiredCookie && expiredCookie.includes('Max-Age=0'), 'AE10: cookie expired')

      // 로그아웃 후 refresh 불가
      const refreshRes = await request(port, 'POST', '/api/auth/refresh', {}, { cookie: `refreshToken=${refreshTokenValue}` })
      assert(refreshRes.status === 401, 'AE10: refresh after logout → 401')
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // AE11. /api/instance (public) → authRequired: true
  // =========================================================================
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

  // =========================================================================
  // AE12. Rate limiting → 429
  // =========================================================================
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      // 5회 실패 로그인
      for (let i = 0; i < 5; i++) {
        await request(port, 'POST', '/api/auth/login', { username: 'testuser', password: 'wrong' })
      }
      // 6번째 → 429
      const res = await request(port, 'POST', '/api/auth/login', { username: 'testuser', password: 'wrong' })
      assert(res.status === 429, 'AE12: rate limit → 429')
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // AE13. WS 미인증 → close
  // =========================================================================
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const closeCode = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`)
        ws.on('close', (code) => resolve(code))
        ws.on('error', () => resolve('error'))
        setTimeout(() => { ws.close(); resolve('timeout') }, 3000)
      })
      assert(closeCode === 4001 || closeCode === 'error', `AE13: unauthenticated WS → closed (code: ${closeCode})`)
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // AE14. WS 인증 → init 메시지 수신
  // =========================================================================
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const loginRes = await request(port, 'POST', '/api/auth/login', { username: 'testuser', password: 'testpassword123' })
      const token = loginRes.body.accessToken

      const { ws, messages } = await connectWS(port, { token })
      // join 메시지 전송 후 init 수신
      ws.send(JSON.stringify({ type: 'join', session_id: 'testuser-default' }))
      await delay(500)

      assert(ws !== null, 'AE14: authenticated WS connected')
      assert(messages.length > 0, 'AE14: received messages')
      assert(messages[0].type === 'init', 'AE14: first message is init')

      ws.close()
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // AE15. WS Origin 검사 — 잘못된 Origin → 4003 close
  // =========================================================================
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      // 잘못된 Origin으로 WS 연결 (Authorization 없이, 쿠키 기반 경로)
      const closeCode = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
          headers: { 'Origin': 'http://evil.example.com' },
        })
        ws.on('close', (code) => resolve(code))
        ws.on('error', () => resolve('error'))
        setTimeout(() => { ws.close(); resolve('timeout') }, 3000)
      })
      assert(closeCode === 4003 || closeCode === 4001, `AE15: bad origin WS → closed (code: ${closeCode})`)

      // 올바른 Origin + auth header → 성공
      const loginRes = await request(port, 'POST', '/api/auth/login', { username: 'testuser', password: 'testpassword123' })
      const token = loginRes.body.accessToken
      const { ws: goodWs } = await connectWS(port, { token })
      assert(goodWs !== null, 'AE15: valid origin + auth → connected')
      goodWs.close()
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // AE16. Admin bootstrap — 첫 부팅 시 admin 계정 + initial-password 파일 생성
  //       비밀번호 변경 시 파일 자동 삭제 (docs/design/agent-identity-model.md §7.3)
  // =========================================================================
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const { existsSync, readFileSync } = await import('fs')
      const pwdFile = join(tmpDir, 'admin-initial-password.txt')
      assert(existsSync(pwdFile), 'AE16: admin-initial-password.txt 생성됨')
      const initialPassword = readFileSync(pwdFile, 'utf-8').trim()
      assert(initialPassword.length >= 12, `AE16: 초기 비밀번호 길이 (got ${initialPassword.length})`)

      // admin 로그인
      const loginRes = await request(port, 'POST', '/api/auth/login', {
        username: 'admin', password: initialPassword,
      })
      assert(loginRes.status === 200, `AE16: admin 로그인 성공 (got ${loginRes.status})`)
      assert(loginRes.body.mustChangePassword === true, 'AE16: mustChangePassword=true')

      // 비밀번호 변경
      const changeRes = await request(port, 'POST', '/api/auth/change-password', {
        currentPassword: initialPassword, newPassword: 'new-admin-password-456',
      }, { token: loginRes.body.accessToken })
      assert(changeRes.status === 200, `AE16: 비밀번호 변경 성공 (got ${changeRes.status})`)

      // 파일 자동 삭제 확인 (비동기 side-effect 이므로 살짝 대기)
      await delay(50)
      assert(!existsSync(pwdFile), 'AE16: initial-password 파일 자동 삭제됨')
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // AE17. Admin bootstrap idempotent — 서버 재시작 시 admin 재생성 안됨
  // =========================================================================
  {
    const { server: s1, shutdown: sd1, tmpDir, userStore } = await setupAuthServer(llmPort)
    await sd1()  // 첫 부팅 후 종료

    // admin 이 이미 있음
    const adminBefore = userStore.findUser('admin')
    assert(adminBefore !== null, 'AE17: 첫 부팅 후 admin 존재')
    const hashBefore = adminBefore.passwordHash

    // 같은 tmpDir 로 재부팅
    process.env.PRESENCE_DIR = tmpDir
    const { loadUserMerged } = await import('@presence/infra/infra/config-loader.js')
    const config = loadUserMerged('auth-test', { basePath: tmpDir })
    const { startServer } = await import('@presence/server')
    const result = await startServer(config, { port: 0, persistenceCwd: tmpDir, instanceId: 'auth-test' })
    try {
      const adminAfter = userStore.findUser('admin')
      assert(adminAfter !== null, 'AE17: 재부팅 후에도 admin 존재')
      assert(adminAfter.passwordHash === hashBefore, 'AE17: passwordHash 변경 없음 (재생성 안됨)')
    } finally {
      await result.shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  await mockLLM.close()
  summary()
}

run()
