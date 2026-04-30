// http-service.js 단위 테스트 — module-private 헬퍼들의 단위 검증.
// 통합 (auth-middleware.test.js) 으로는 다루지 않는 영역:
//   - createRateLimiter: 5+1 시도 차단, 다른 IP 격리
//   - httpStatus: AuthError code → HTTP status 매핑 (PASSWORD_CHANGE_REQUIRED/RATE_LIMITED/MISSING_FIELDS/default)
//   - HttpAuthService.gate: mustChangePassword + allowlist 게이트
//   - HttpAuthService.extractCredentials / extractRefreshToken: 입력 추출 정확성

import {
  createRateLimiter,
  httpStatus,
  HttpAuthService,
  MUST_CHANGE_PASSWORD_ALLOWLIST,
} from '@presence/infra/infra/auth/http-service.js'
import { AUTH_ERROR, AuthError, AUTH } from '@presence/infra/infra/auth/policy.js'
import fp from '@presence/core/lib/fun-fp.js'
import { assert, summary } from '../../../test/lib/assert.js'

const { Either } = fp
const isLeft = (e) => Either.fold(() => true, () => false, e)
const isRight = (e) => Either.fold(() => false, () => true, e)
const getLeft = (e) => Either.fold(v => v, () => null, e)

console.log('http-service unit tests')

// =============================================================================
// 1. createRateLimiter
// =============================================================================

// RL1 — 첫 N 회 (RATE_LIMIT_MAX_ATTEMPTS) 시도 허용 + N+1 차단
{
  const rl = createRateLimiter()
  const ip = '10.0.0.1'
  const max = AUTH.RATE_LIMIT_MAX_ATTEMPTS
  for (let i = 0; i < max; i++) {
    assert(rl.isAllowed(ip), `RL1: 허용 ${i + 1}/${max}`)
    rl.record(ip)
  }
  assert(!rl.isAllowed(ip), `RL1: ${max + 1} 번째 차단`)
}

// RL2 — 다른 IP 격리: 한 IP 차단되어도 다른 IP 는 영향 없음
{
  const rl = createRateLimiter()
  const max = AUTH.RATE_LIMIT_MAX_ATTEMPTS
  for (let i = 0; i < max; i++) rl.record('10.0.0.1')
  assert(!rl.isAllowed('10.0.0.1'), 'RL2: 첫 IP 차단')
  assert(rl.isAllowed('10.0.0.2'), 'RL2: 다른 IP 영향 없음')
}

// RL3 — isAllowed 자체는 카운트 증가 없음 (record 만 카운트). 동일 IP 반복 isAllowed → 항상 true
{
  const rl = createRateLimiter()
  assert(rl.isAllowed('10.0.0.3'), 'RL3: 첫 isAllowed → true')
  assert(rl.isAllowed('10.0.0.3'), 'RL3: 두 번째 isAllowed → true (record 미호출)')
}

// =============================================================================
// 2. httpStatus 매핑
// =============================================================================

// HS1 — PASSWORD_CHANGE_REQUIRED → 403
{
  const status = httpStatus(AuthError(AUTH_ERROR.PASSWORD_CHANGE_REQUIRED, 'change required'))
  assert(status === 403, `HS1: PASSWORD_CHANGE_REQUIRED → 403 (got ${status})`)
}

// HS2 — RATE_LIMITED → 429
{
  const status = httpStatus(AuthError(AUTH_ERROR.RATE_LIMITED, 'too many'))
  assert(status === 429, `HS2: RATE_LIMITED → 429 (got ${status})`)
}

// HS3 — MISSING_FIELDS → 400
{
  const status = httpStatus(AuthError(AUTH_ERROR.MISSING_FIELDS, 'missing'))
  assert(status === 400, `HS3: MISSING_FIELDS → 400 (got ${status})`)
}

// HS4 — 그 외 (NO_TOKEN, INVALID_TOKEN, TOKEN_EXPIRED, INVALID_CREDENTIALS 등) → 401
{
  for (const code of [
    AUTH_ERROR.NO_TOKEN,
    AUTH_ERROR.INVALID_TOKEN,
    AUTH_ERROR.TOKEN_EXPIRED,
    AUTH_ERROR.TOKEN_REVOKED,
    AUTH_ERROR.INVALID_CREDENTIALS,
    AUTH_ERROR.INVALID_PRINCIPAL,
  ]) {
    const status = httpStatus(AuthError(code, 'x'))
    assert(status === 401, `HS4: ${code} → 401 (got ${status})`)
  }
}

// =============================================================================
// 3. HttpAuthService.gate / extractCredentials / extractRefreshToken
//    인스턴스를 mock 의존성으로 만들고 메서드 직접 호출.
// =============================================================================

const mockTokenService = { /* gate/extract* 는 token verify 호출 안 함 */ }
const mockUserStore = { /* gate/extract* 는 user store 호출 안 함 */ }
const httpAuth = new HttpAuthService(mockTokenService, mockUserStore)

// GT1 — mustChangePassword=false → 그대로 통과 (Right)
{
  const principal = { username: 'alice', roles: ['admin'], mustChangePassword: false }
  const req = { path: '/chat' }
  const result = httpAuth.gate(principal, req)
  assert(isRight(result), 'GT1: mustChangePassword=false → Right')
}

// GT2 — mustChangePassword=true + 비-allowlist 경로 → Left(PASSWORD_CHANGE_REQUIRED)
{
  const principal = { username: 'alice', roles: ['admin'], mustChangePassword: true }
  const req = { path: '/chat' }
  const result = httpAuth.gate(principal, req)
  assert(isLeft(result), 'GT2: mustChangePassword=true + non-allowlist → Left')
  assert(getLeft(result).code === AUTH_ERROR.PASSWORD_CHANGE_REQUIRED, 'GT2: code=PASSWORD_CHANGE_REQUIRED')
}

// GT3 — mustChangePassword=true + allowlist 경로 (전부) → Right
{
  for (const path of MUST_CHANGE_PASSWORD_ALLOWLIST) {
    const principal = { username: 'alice', roles: ['admin'], mustChangePassword: true }
    const result = httpAuth.gate(principal, { path })
    assert(isRight(result), `GT3: allowlist path '${path}' → Right`)
  }
}

// GT4 — allowlist prefix 일치 (sub-path 도 통과)
{
  const principal = { username: 'alice', roles: ['admin'], mustChangePassword: true }
  const result = httpAuth.gate(principal, { path: '/auth/change-password/confirm' })
  assert(isRight(result), 'GT4: allowlist sub-path → Right')
}

// EC1 — extractCredentials: 정상 body → { username, password }
{
  const creds = httpAuth.extractCredentials({ body: { username: 'alice', password: 'pw' } })
  assert(creds?.username === 'alice', 'EC1: username 추출')
  assert(creds?.password === 'pw', 'EC1: password 추출')
}

// EC2 — extractCredentials: 누락 필드 → null
{
  assert(httpAuth.extractCredentials({ body: { username: 'alice' } }) === null, 'EC2: password 누락 → null')
  assert(httpAuth.extractCredentials({ body: { password: 'pw' } }) === null, 'EC2: username 누락 → null')
  assert(httpAuth.extractCredentials({ body: {} }) === null, 'EC2: 빈 body → null')
  assert(httpAuth.extractCredentials({}) === null, 'EC2: body 자체 부재 → null')
}

// ER1 — extractRefreshToken: cookie 우선
{
  const token = httpAuth.extractRefreshToken({
    cookies: { refreshToken: 'cookie-token' },
    body: { refreshToken: 'body-token' },
  })
  assert(token === 'cookie-token', `ER1: cookie 우선 (got ${token})`)
}

// ER2 — extractRefreshToken: cookie 부재 시 body fallback
{
  const token = httpAuth.extractRefreshToken({
    cookies: {},
    body: { refreshToken: 'body-token' },
  })
  assert(token === 'body-token', `ER2: body fallback (got ${token})`)
}

// ER3 — extractRefreshToken: 양쪽 부재 시 null
{
  assert(httpAuth.extractRefreshToken({ cookies: {}, body: {} }) === null, 'ER3: 양쪽 부재 → null')
  assert(httpAuth.extractRefreshToken({}) === null, 'ER3: cookies/body 자체 부재 → null')
}

summary()
