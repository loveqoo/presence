// KG-28 P5 — admin REST 라우터 통합 테스트.
// AR1~AR7 — POST /policy/reload + GET /policy/version + role 매트릭스 + audit fail isolation.
// AR8 (FP-77) — 서버 측 401 vs 403 응답 분리 검증. CLI 측 메시지 분리는 INV-CEDAR-CLI-AUTH-SPLIT
// 정적 회귀로 cedar-quota-policy.test.js 에서 검증.

import { createTestServer, request } from '../../../test/lib/mock-server.js'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import { assert, summary } from '../../../test/lib/assert.js'

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

  } finally {
    await shutdown()
  }

  summary()
}

run().catch(err => {
  console.error('Admin router test failed:', err)
  process.exit(1)
})
