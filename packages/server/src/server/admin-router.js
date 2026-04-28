// KG-28 P5 — admin-only REST 라우터. presence 첫 admin REST.
// POST /api/admin/policy/reload — Cedar policy hot reload trigger.
// GET  /api/admin/policy/version — 현재 활성 정책 버전 조회.
//
// 인증: auth middleware 가 JWT 검증 후 req.user 주입. 미인증은 middleware 가 401 차단.
// 인가: admin role 미들웨어 — req.user.roles?.includes('admin') 우선, ADMIN_USERNAME legacy fallback.
// audit: server boot 의 단일 auditWriter 인스턴스 재사용 (단일 진실 소스). policyVersion 자동 첨부.

import { Router } from 'express'
import fp from '@presence/core/lib/fun-fp.js'
import { ADMIN_USERNAME } from '@presence/infra/infra/admin-bootstrap.js'

const { Reader } = fp

// admin role 미들웨어 — token payload 의 roles 기반.
// (round 3 H3 정정: access token 즉시 회수 메커니즘 부재 — password change 는 refresh chain 만
//  무효화, access token 은 TTL 만료까지 유효. 본 phase 는 짧은 TTL + audit trail 로 위험 수용.)
const requireAdmin = (req, res, next) => {
  const isAdminByRole = Array.isArray(req.user?.roles) && req.user.roles.includes('admin')
  const isAdminByName = req.user?.username === ADMIN_USERNAME    // legacy fallback (roles 부재 호환)
  if (!isAdminByRole && !isAdminByName) {
    return res.status(403).json({ error: 'admin only' })
  }
  next()
}

const createAdminRouterR = Reader.asks(({ userContextManager, presenceDir, logger, auditWriter }) => {
  if (!userContextManager) throw new Error('createAdminRouter: userContextManager 필수')
  if (typeof presenceDir !== 'string') throw new Error('createAdminRouter: presenceDir 필수')
  if (!auditWriter || typeof auditWriter.append !== 'function') {
    throw new Error('createAdminRouter: auditWriter (with append) 필수')
  }
  const log = logger ?? console

  const router = Router()
  router.use(requireAdmin)

  // POST /api/admin/policy/reload
  // round 9 H 흡수: audit I/O 실패가 reload outcome 을 오염하지 않도록 try 블록 분리.
  router.post('/policy/reload', async (req, res) => {
    const caller = req.user.username
    let outcome   // { kind: 'success', result } | { kind: 'fail', err, activeSnapshot }
    try {
      const result = await userContextManager.reloadEvaluator({ presenceDir, logger: log })
      outcome = { kind: 'success', result }
    } catch (err) {
      log.error(`[policy reload] failed (caller=${caller}): ${err.message}`)
      const activeSnapshot = userContextManager.getEvaluatorSnapshot()
      outcome = { kind: 'fail', err, activeSnapshot }
    }

    // 응답 — reload outcome 만 반영 (audit 실패와 무관)
    if (outcome.kind === 'success') {
      const r = outcome.result
      res.json({
        status: 'ok', version: r.version, reloadedAt: r.reloadedAt, reloadStartedAt: r.reloadStartedAt,
      })
    } else {
      const s = outcome.activeSnapshot
      res.status(500).json({
        status: 'fail', error: outcome.err.message,
        activeVersion: s.version, activeReloadedAt: s.reloadedAt,
      })
    }

    // audit — 별도 try, I/O 실패는 warn 만 (응답 영향 없음). policyVersion 은 auditWriter 자동 첨부.
    try {
      if (outcome.kind === 'success') {
        const r = outcome.result
        auditWriter.append({
          ts: new Date().toISOString(),
          caller, action: 'policy_reload', resource: 'cedar-evaluator',
          decision: 'success', matchedPolicies: [], errors: [],
          reloadedAt: r.reloadedAt, reloadStartedAt: r.reloadStartedAt,
        })
      } else {
        auditWriter.append({
          ts: new Date().toISOString(),
          caller, action: 'policy_reload', resource: 'cedar-evaluator',
          decision: 'fail', matchedPolicies: [], errors: [outcome.err.message],
          activePolicyVersion: outcome.activeSnapshot.version,
        })
      }
    } catch (auditErr) {
      log.warn(`[policy reload] audit append failed: ${auditErr.message}`)
    }
  })

  // GET /api/admin/policy/version — 운영자 모니터링.
  router.get('/policy/version', (req, res) => {
    const snapshot = userContextManager.getEvaluatorSnapshot()
    res.json({ version: snapshot.version, reloadedAt: snapshot.reloadedAt })
  })

  return router
})

const createAdminRouter = (deps) => createAdminRouterR.run(deps)

export { createAdminRouter, createAdminRouterR, requireAdmin }
