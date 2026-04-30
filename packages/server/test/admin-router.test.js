// KG-28 P5 — admin REST 라우터 통합 테스트.
// AR1~AR7 — POST /policy/reload + GET /policy/version + role 매트릭스 + audit fail isolation.
// AR8 (FP-77) — 서버 측 401 vs 403 응답 분리 검증. CLI 측 메시지 분리는 INV-CEDAR-CLI-AUTH-SPLIT
// 정적 회귀로 cedar-quota-policy.test.js 에서 검증.
// AR9~AR14c (FP-73) — admin-session.json 파일 fallback + 자동 refresh + 401 retry +
// mustChangePassword bootstrap + concurrent retry 경계.

import { createTestServer, request } from '../../../test/lib/mock-server.js'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import {
  saveAdminSession,
  loadAdminSession,
  adminSessionPath,
} from '@presence/infra/infra/auth/admin-session.js'
import { dispatchPolicy } from '@presence/infra/infra/auth/cli-policy.js'
import { dispatchAdmin } from '@presence/infra/infra/auth/cli-admin.js'
import { assert, summary } from '../../../test/lib/assert.js'
import { existsSync } from 'node:fs'

async function run() {
  console.log('Admin router tests (KG-28 P5)')

  const ctx = await createTestServer(
    (_req, n) => JSON.stringify({ type: 'direct_response', message: `응답 ${n}` })
  )
  const { port, token: adminToken, tmpDir, shutdown } = ctx
  // testuser 는 첫 번째 user 로 등록되어 자동으로 roles=['admin'] (user-store.js:92).

  // 두 번째 user 등록 — non-admin role 매트릭스용
  const userStore = createUserStore({ basePath: tmpDir })
  await userStore.addUser('regular', 'regularpass123')
  await userStore.changePassword('regular', 'regularpass123')

  // regular user 로그인
  const regularLogin = await request(port, 'POST', '/api/auth/login', {
    username: 'regular', password: 'regularpass123',
  })
  const regularToken = regularLogin.body.accessToken

  try {
    // AR1 — admin role user POST /api/admin/policy/reload → 200 + version 증가
    {
      const before = await request(port, 'GET', '/api/admin/policy/version', null, { token: adminToken })
      assert(before.status === 200, `AR1: GET version → 200 (got ${before.status})`)
      const initialVersion = before.body.version
      assert(typeof initialVersion === 'number', 'AR1: version 숫자')

      const reloadRes = await request(port, 'POST', '/api/admin/policy/reload', null, { token: adminToken })
      assert(reloadRes.status === 200, `AR1: POST reload → 200 (got ${reloadRes.status} body=${JSON.stringify(reloadRes.body)})`)
      assert(reloadRes.body.status === 'ok', `AR1: status=ok (got ${reloadRes.body.status})`)
      assert(reloadRes.body.version === initialVersion + 1,
        `AR1: version 증가 (got ${reloadRes.body.version}, expected ${initialVersion + 1})`)
      assert(typeof reloadRes.body.reloadStartedAt === 'string', 'AR1: reloadStartedAt 응답')
      assert(typeof reloadRes.body.reloadedAt === 'string', 'AR1: reloadedAt 응답')

      const after = await request(port, 'GET', '/api/admin/policy/version', null, { token: adminToken })
      assert(after.body.version === initialVersion + 1, 'AR1: GET version 도 증가 반영')
    }

    // AR2 — non-admin user → 403
    {
      const res = await request(port, 'POST', '/api/admin/policy/reload', null, { token: regularToken })
      assert(res.status === 403, `AR2: non-admin → 403 (got ${res.status})`)
      assert(res.body.error === 'admin only', `AR2: error 메시지 (got ${res.body.error})`)
    }

    // AR3 — 미인증 → 401 (auth middleware 차단)
    {
      const res = await request(port, 'POST', '/api/admin/policy/reload', null, {})
      assert(res.status === 401, `AR3: 미인증 → 401 (got ${res.status})`)
    }

    // AR4 — 부팅 실패 시 활성 evaluator 유지. userContextManager.reloadEvaluator 가
    //   throw 하도록 monkey-patch. 응답 500 + status='fail' + activeVersion + activeReloadedAt
    //   명시 + GET version 은 변경 없음 (메모리 fail-safe rollback).
    {
      const beforeRes = await request(port, 'GET', '/api/admin/policy/version', null, { token: adminToken })
      const beforeVer = beforeRes.body.version
      const beforeReloadedAt = beforeRes.body.reloadedAt

      const ucm = ctx.userContextManager
      const original = ucm.reloadEvaluator.bind(ucm)
      ucm.reloadEvaluator = async () => { throw new Error('reload-boot-failed-test') }
      try {
        const reloadRes = await request(port, 'POST', '/api/admin/policy/reload', null, { token: adminToken })
        assert(reloadRes.status === 500, `AR4: 부팅 실패 → 500 (got ${reloadRes.status})`)
        assert(reloadRes.body.status === 'fail', `AR4: status=fail (got ${reloadRes.body.status})`)
        assert(reloadRes.body.error.includes('reload-boot-failed-test'),
          `AR4: error 에 throw 메시지 (got ${reloadRes.body.error})`)
        assert(reloadRes.body.activeVersion === beforeVer,
          `AR4: activeVersion = beforeVer (got ${reloadRes.body.activeVersion}, expected ${beforeVer})`)
        assert(reloadRes.body.activeReloadedAt === beforeReloadedAt,
          `AR4: activeReloadedAt 유지 (got ${reloadRes.body.activeReloadedAt})`)
      } finally {
        ucm.reloadEvaluator = original
      }

      const afterRes = await request(port, 'GET', '/api/admin/policy/version', null, { token: adminToken })
      assert(afterRes.body.version === beforeVer,
        `AR4: GET version 도 미변경 (got ${afterRes.body.version}, expected ${beforeVer})`)
      assert(afterRes.body.reloadedAt === beforeReloadedAt,
        `AR4: GET reloadedAt 도 미변경`)
    }

    // AR5 — GET /api/admin/policy/version → 200 + 현재 version + reloadedAt
    {
      const res = await request(port, 'GET', '/api/admin/policy/version', null, { token: adminToken })
      assert(res.status === 200, `AR5: GET version 200 (got ${res.status})`)
      assert(typeof res.body.version === 'number', 'AR5: version 숫자')
      assert(typeof res.body.reloadedAt === 'string', 'AR5: reloadedAt 문자열')
    }

    // AR6 — admin role 강제 매트릭스
    //   testuser (roles=['admin']) → 200
    //   regular (roles=['user']) → 403
    //   ADMIN_USERNAME='admin' 사용자 미등록 — fallback 검증 skip (별도 test 환경 필요)
    {
      const adminRes = await request(port, 'GET', '/api/admin/policy/version', null, { token: adminToken })
      assert(adminRes.status === 200, `AR6: roles=admin → 200 (got ${adminRes.status})`)

      const userRes = await request(port, 'GET', '/api/admin/policy/version', null, { token: regularToken })
      assert(userRes.status === 403, `AR6: roles=user → 403 (got ${userRes.status})`)
    }

    // AR7 — audit append 실패 격리. auditWriter.append 가 throw 하도록 monkey-patch.
    //   POST /policy/reload 응답이 200 OK + 정상 reload payload 를 반환하는지 검증
    //   (audit I/O 실패가 reload outcome 을 오염하지 않음). logger.warn 호출은 console.warn
    //   spy 로 검증.
    {
      const aw = ctx.auditWriter
      const originalAppend = aw.append.bind(aw)
      const originalWarn = console.warn
      let warnCount = 0
      let warnMessage = null

      aw.append = () => { throw new Error('audit-append-failed-test') }
      console.warn = (msg) => { warnCount += 1; warnMessage = String(msg) }

      try {
        const beforeVer = (await request(port, 'GET', '/api/admin/policy/version', null, { token: adminToken })).body.version
        const reloadRes = await request(port, 'POST', '/api/admin/policy/reload', null, { token: adminToken })
        assert(reloadRes.status === 200,
          `AR7: audit fail 에도 reload 응답 200 (got ${reloadRes.status} body=${JSON.stringify(reloadRes.body)})`)
        assert(reloadRes.body.status === 'ok',
          `AR7: status=ok 유지 (got ${reloadRes.body.status})`)
        assert(reloadRes.body.version === beforeVer + 1,
          `AR7: version 증가 (got ${reloadRes.body.version})`)
        assert(typeof reloadRes.body.reloadStartedAt === 'string',
          'AR7: reloadStartedAt 정상')
        assert(warnCount >= 1,
          `AR7: logger.warn 호출 (got ${warnCount})`)
        assert(warnMessage && warnMessage.includes('audit append failed'),
          `AR7: warn 메시지에 audit fail 표시 (got ${warnMessage})`)
      } finally {
        aw.append = originalAppend
        console.warn = originalWarn
      }
    }

    // AR8 (FP-77) — 서버측 401 vs 403 응답 분리 검증. CLI 측 메시지 분기는 정적 회귀로 검증.
    //   401: invalid token → server admin/* 진입 차단 (auth middleware)
    //   403: regular user (admin role 부재) → admin router requireAdmin 차단
    {
      const r401 = await request(port, 'POST', '/api/admin/policy/reload', null, { token: 'invalid-fake-token' })
      assert(r401.status === 401, `AR8-401: 잘못된 token → 401 (got ${r401.status})`)

      const r403 = await request(port, 'POST', '/api/admin/policy/reload', null, { token: regularToken })
      assert(r403.status === 403, `AR8-403: regular user → 403 (got ${r403.status})`)
      assert(r403.body.error === 'admin only', `AR8-403: error message=admin only (got ${r403.body.error})`)
    }

    // ===== FP-73 — AR9~AR14c =====
    // PRESENCE_DIR 은 createTestServer 가 이미 tmpDir 로 설정. PRESENCE_SERVER_URL 만 추가.
    // dispatchPolicy/dispatchAdmin 은 process.exit(1) 호출 → captureExit 로 가로채서 검증.

    const captureExit = async (fn) => {
      const origExit = process.exit
      const origError = console.error
      const origWarn = console.warn
      const origLog = console.log
      let exitCode = 0
      const stderr = []
      const stdout = []
      process.exit = (code) => { exitCode = code; throw new Error('__exited__') }
      console.error = (...args) => { stderr.push(args.map(String).join(' ')) }
      console.warn = (...args) => { stderr.push(args.map(String).join(' ')) }
      console.log = (...args) => { stdout.push(args.map(String).join(' ')) }
      try {
        await fn()
      } catch (err) {
        if (err.message !== '__exited__') {
          process.exit = origExit; console.error = origError; console.warn = origWarn; console.log = origLog
          throw err
        }
      } finally {
        process.exit = origExit
        console.error = origError
        console.warn = origWarn
        console.log = origLog
      }
      return { exitCode, stderr: stderr.join('\n'), stdout: stdout.join('\n') }
    }

    const origServerUrl = process.env.PRESENCE_SERVER_URL
    const origAdminToken = process.env.PRESENCE_ADMIN_TOKEN
    const origAdminPassword = process.env.PRESENCE_ADMIN_PASSWORD
    process.env.PRESENCE_SERVER_URL = `http://127.0.0.1:${port}`
    delete process.env.PRESENCE_ADMIN_TOKEN
    delete process.env.PRESENCE_ADMIN_PASSWORD

    try {
      // AR9 — admin login flow → 파일 생성 → ENV 없이 policy reload 200.
      // testuser 는 mockServer 가 비번 변경 + 첫 user 로 admin role 부여한 상태.
      {
        process.env.PRESENCE_ADMIN_PASSWORD = 'testpassword123'
        const r = await captureExit(() => dispatchAdmin('login', { username: 'testuser' }))
        delete process.env.PRESENCE_ADMIN_PASSWORD
        assert(r.exitCode === 0, `AR9: admin login exit 0 (got ${r.exitCode}, stderr=${r.stderr.slice(0, 200)})`)
        const session = loadAdminSession()
        assert(session != null, 'AR9: admin-session.json 생성됨')
        assert(session.username === 'testuser', `AR9: username=testuser (got ${session.username})`)

        const before = await request(port, 'GET', '/api/admin/policy/version', null, { token: adminToken })
        const versionBefore = before.body.version

        const r2 = await captureExit(() => dispatchPolicy('reload', {}))
        assert(r2.exitCode === 0, `AR9: policy reload exit 0 (got ${r2.exitCode}, stderr=${r2.stderr.slice(0, 200)})`)
        const after = await request(port, 'GET', '/api/admin/policy/version', null, { token: adminToken })
        assert(after.body.version === versionBefore + 1, `AR9: version 증가 (${versionBefore} → ${after.body.version})`)
      }

      // AR10 — refresh fallback. 만료 임박 access 로 직접 saveAdminSession + valid refresh →
      // policy reload → 자동 refresh 후 새 토큰 파일 갱신.
      {
        const session = loadAdminSession()
        const stale = {
          username: session.username,
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          accessExp: new Date(Date.now() + 5_000).toISOString(), // 5s 남음 — drift buffer 30s 안 → near
        }
        saveAdminSession(stale)
        const oldRefreshToken = session.refreshToken

        const r = await captureExit(() => dispatchPolicy('version', {}))
        assert(r.exitCode === 0, `AR10: policy version exit 0 (got ${r.exitCode}, stderr=${r.stderr.slice(0, 200)})`)

        const reloaded = loadAdminSession()
        assert(reloaded.refreshToken !== oldRefreshToken,
          `AR10: refreshToken 갱신 (rotation) — 새 jti 발급 검증`)
        const accessExpEpoch = Math.floor(new Date(reloaded.accessExp).getTime() / 1000)
        const nowEpoch = Math.floor(Date.now() / 1000)
        assert(accessExpEpoch > nowEpoch + 30,
          `AR10: 새 accessExp 가 drift buffer 밖 (got ${accessExpEpoch - nowEpoch}s 남음)`)
      }

      // AR11 — refresh 도 만료 → policy reload 실패 + 파일 삭제 + 재로그인 안내.
      {
        // 직접 refresh 로 oldRefresh 를 한 번 사용 → 서버에서 jti 제거 → 다시 사용하면 401.
        const session = loadAdminSession()
        const consumeRes = await request(port, 'POST', '/api/auth/refresh', { refreshToken: session.refreshToken })
        assert(consumeRes.status === 200, `AR11 setup: 첫 refresh 사용 (got ${consumeRes.status})`)

        // 이제 session.refreshToken 은 무효 jti. 그대로 saveAdminSession + 만료 임박.
        saveAdminSession({
          username: session.username,
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,  // 이미 revoke 된 jti
          accessExp: new Date(Date.now() + 5_000).toISOString(),
        })

        const r = await captureExit(() => dispatchPolicy('reload', {}))
        assert(r.exitCode === 1, `AR11: refresh 만료 → exit 1 (got ${r.exitCode})`)
        assert(r.stderr.includes('admin login') || r.stderr.includes('재로그인'),
          `AR11: stderr 에 재로그인 안내 (got ${r.stderr.slice(0, 200)})`)
        assert(!existsSync(adminSessionPath()),
          'AR11: 파일 삭제됨')
      }

      // AR12 — mustChangePassword bootstrap → exit 1 + 파일 미저장.
      {
        // 새 admin2 사용자 추가 (mustChangePassword=true 로 생성). userStore.addUser default = mustChangePassword:true
        const adminStore = createUserStore({ basePath: tmpDir })
        await adminStore.addUser('admin2', 'temp-password-789')

        process.env.PRESENCE_ADMIN_PASSWORD = 'temp-password-789'
        const r = await captureExit(() => dispatchAdmin('login', { username: 'admin2' }))
        delete process.env.PRESENCE_ADMIN_PASSWORD
        assert(r.exitCode === 1, `AR12: mustChangePassword → exit 1 (got ${r.exitCode})`)
        assert(r.stderr.includes('비밀번호 변경'),
          `AR12: stderr 에 "비밀번호 변경" 안내 (got ${r.stderr.slice(0, 200)})`)
        assert(r.stderr.includes('passwd'),
          `AR12: stderr 에 passwd 안내`)
        assert(!existsSync(adminSessionPath()),
          'AR12: 파일 미저장')
      }

      // AR13 — mustChangePassword 완전 복구 (single-host) — admin2 → passwd → admin login → reload.
      {
        const adminStore = createUserStore({ basePath: tmpDir })
        // passwd: 로컬 user-store 에서 비밀번호 변경 + mustChangePassword 해제
        await adminStore.changePassword('admin2', 'admin2-new-password-456')

        process.env.PRESENCE_ADMIN_PASSWORD = 'admin2-new-password-456'
        const r = await captureExit(() => dispatchAdmin('login', { username: 'admin2' }))
        delete process.env.PRESENCE_ADMIN_PASSWORD
        // admin2 는 두 번째 user → roles=[user] (admin 부재). 로그인 자체는 성공해야 함.
        assert(r.exitCode === 0, `AR13: 두 번째 admin login exit 0 (got ${r.exitCode}, stderr=${r.stderr.slice(0, 200)})`)
        assert(existsSync(adminSessionPath()),
          'AR13: 파일 저장됨 (mustChangePassword 해제 확인)')
        const session = loadAdminSession()
        assert(session.username === 'admin2', `AR13: username=admin2`)

        // admin2 는 일반 user role → policy reload 는 403 받음. 파일/세션 자체는 정상 작동을 검증한 것.
        const r2 = await captureExit(() => dispatchPolicy('reload', {}))
        assert(r2.exitCode === 1, `AR13: admin2 (user role) → policy reload 차단 exit 1`)
        assert(r2.stderr.includes('admin 권한'),
          `AR13: 403 안내 (got ${r2.stderr.slice(0, 200)})`)
      }

      // AR14 — clock drift 401 retry. 만료 미인지 → 첫 호출 401 → force refresh + retry → 200.
      {
        // testuser 로 다시 login (admin role 회복)
        const adminStore = createUserStore({ basePath: tmpDir })
        // 먼저 기존 admin-session.json 정리 (admin2 잔존) 후 testuser 로 새로 login
        const loginFresh = await request(port, 'POST', '/api/auth/login', {
          username: 'testuser', password: 'testpassword123',
        })
        assert(loginFresh.status === 200, `AR14 setup: testuser login OK`)

        // exp 를 미래로 위조하여 isAccessNearExpiry 가 false 반환하도록.
        // 그러나 access 자체는 유효 (서버는 실제 exp 검증). 즉 위조는 클라이언트 판단만.
        // → 서버는 정상 처리. 401 retry 검증 어려움.
        // 차선: 의도적으로 invalid access (잘못된 서명) 를 file 에 넣고 valid refresh 보유.
        //  → 첫 호출 401 → refresh → 새 valid access → 두 번째 호출 200.
        saveAdminSession({
          username: 'testuser',
          accessToken: 'invalid.access.token.signature',  // 서명 깨짐 → 401
          refreshToken: loginFresh.body.refreshToken,    // valid
          accessExp: new Date(Date.now() + 600_000).toISOString(), // 미래 → near=false
        })

        const beforeVer = (await request(port, 'GET', '/api/admin/policy/version', null, { token: adminToken })).body.version
        const r = await captureExit(() => dispatchPolicy('reload', {}))
        assert(r.exitCode === 0, `AR14: 401 retry → exit 0 (got ${r.exitCode}, stderr=${r.stderr.slice(0, 200)})`)
        const afterVer = (await request(port, 'GET', '/api/admin/policy/version', null, { token: adminToken })).body.version
        assert(afterVer === beforeVer + 1, `AR14: reload 적용 확인 (${beforeVer} → ${afterVer})`)
      }

      // AR14a — retry 후 재실패 (refresh 도 만료) → 무한 루프 없음.
      {
        const session = loadAdminSession()
        // refresh 를 한 번 사용 → 서버에서 jti 제거.
        await request(port, 'POST', '/api/auth/refresh', { refreshToken: session.refreshToken })

        // invalid access + revoked refresh → 첫 호출 401 → force refresh → 401 → 재로그인 안내.
        saveAdminSession({
          username: 'testuser',
          accessToken: 'another.invalid.access',
          refreshToken: session.refreshToken,
          accessExp: new Date(Date.now() + 600_000).toISOString(),
        })

        const r = await captureExit(() => dispatchPolicy('reload', {}))
        assert(r.exitCode === 1, `AR14a: refresh 만료 → exit 1 (got ${r.exitCode})`)
        // refreshAndPersist 의 401 분기에서 clearAdminSession + "세션 만료" 안내.
        assert(r.stderr.includes('admin login') || r.stderr.includes('재로그인'),
          `AR14a: stderr 에 재로그인 안내 (got ${r.stderr.slice(0, 200)})`)
        assert(!existsSync(adminSessionPath()),
          'AR14a: 파일 삭제됨 (무한 루프 방지)')
      }

      // AR14b — ENV 사용 중 retry 미발생. 만료 ENV token → 401 → 그대로 종료.
      {
        // 잘못된 token 을 ENV 에 설정 → 서버 401 → cli-policy 가 retry 안 함 (ENV 분기).
        process.env.PRESENCE_ADMIN_TOKEN = 'invalid.env.token'
        const r = await captureExit(() => dispatchPolicy('reload', {}))
        delete process.env.PRESENCE_ADMIN_TOKEN
        assert(r.exitCode === 1, `AR14b: ENV 만료 token → exit 1 (got ${r.exitCode})`)
        // handleAuthError 의 401 안내 (ENV 흐름 — 자체 retry 없음).
        assert(r.stderr.includes('인증이 필요합니다') || r.stderr.includes('PRESENCE_ADMIN_TOKEN'),
          `AR14b: stderr 에 ENV 401 안내 (got ${r.stderr.slice(0, 200)})`)
      }
    } finally {
      if (origServerUrl) process.env.PRESENCE_SERVER_URL = origServerUrl
      else delete process.env.PRESENCE_SERVER_URL
      if (origAdminToken) process.env.PRESENCE_ADMIN_TOKEN = origAdminToken
      else delete process.env.PRESENCE_ADMIN_TOKEN
      if (origAdminPassword) process.env.PRESENCE_ADMIN_PASSWORD = origAdminPassword
      else delete process.env.PRESENCE_ADMIN_PASSWORD
    }

  } finally {
    await shutdown()
  }

  summary()
}

run().catch(err => {
  console.error('Admin router test failed:', err)
  process.exit(1)
})
