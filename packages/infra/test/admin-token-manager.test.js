// AdminTokenManager 단위 테스트 (FP-73 / spec auth.md I12).
// fromEnv snapshot / ENV 우선 / 파일 fallback / mode 위배 / corrupt /
// 만료 임박 refresh / 401 retry / ENV 모드 no-retry.
//
// 통합 (admin-router.test.js AR9~AR14c) 으로는 dispatchPolicy 통한 검증.
// 본 파일은 클래스 직접 단위 검증 (auth.md I12 spec coverage).

import { mkdtempSync, rmSync, chmodSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AdminTokenManager } from '@presence/infra/infra/auth/cli-policy.js'
import {
  saveAdminSession,
  loadAdminSession,
  adminSessionPath,
} from '@presence/infra/infra/auth/admin-session.js'
import { assert, summary } from '../../../test/lib/assert.js'

console.log('AdminTokenManager unit tests (FP-73 / spec auth.md I12)')

// fake JWT — exp claim 만 valid (signature 검증 없음, decodeAccessExp 동작 보장).
const makeFakeJWT = (expSecondsFromNow) => {
  const payload = { exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `header.${b64(payload)}.signature`
}

const setupTmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-token-mgr-'))
  const prevPresenceDir = process.env.PRESENCE_DIR
  const prevAdminToken = process.env.PRESENCE_ADMIN_TOKEN
  const prevServerUrl = process.env.PRESENCE_SERVER_URL
  process.env.PRESENCE_DIR = dir
  delete process.env.PRESENCE_ADMIN_TOKEN
  process.env.PRESENCE_SERVER_URL = 'http://localhost:9999'
  return {
    dir,
    restore: () => {
      rmSync(dir, { recursive: true, force: true })
      if (prevPresenceDir === undefined) delete process.env.PRESENCE_DIR
      else process.env.PRESENCE_DIR = prevPresenceDir
      if (prevAdminToken === undefined) delete process.env.PRESENCE_ADMIN_TOKEN
      else process.env.PRESENCE_ADMIN_TOKEN = prevAdminToken
      if (prevServerUrl === undefined) delete process.env.PRESENCE_SERVER_URL
      else process.env.PRESENCE_SERVER_URL = prevServerUrl
    },
  }
}

// fetch mock helper — 호출 큐 기반 (순서대로 응답).
const mockFetchQueue = (responses) => {
  const orig = globalThis.fetch
  let idx = 0
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    const next = responses[idx++]
    if (!next) throw new Error(`mock fetch: 큐 소진 (호출 ${idx})`)
    if (next.throwError) throw next.throwError
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      json: async () => next.body ?? {},
    }
  }
  return {
    calls,
    restore: () => { globalThis.fetch = orig },
  }
}

const futureExp = (secondsFromNow) => new Date(Date.now() + secondsFromNow * 1000).toISOString()

// AT1 — fromEnv: ENV snapshot. 인스턴스 생성 후 process.env 변경해도 토큰 불변.
{
  const t = setupTmp()
  try {
    process.env.PRESENCE_ADMIN_TOKEN = 'env-fixed'
    const mgr = AdminTokenManager.fromEnv()
    process.env.PRESENCE_ADMIN_TOKEN = 'changed-after-snapshot'
    const token = await mgr.resolveToken()
    assert(token === 'env-fixed', `AT1: snapshot ENV (got ${token})`)
  } finally {
    t.restore()
  }
}

// AT2 — resolveToken: ENV 모드는 파일 무시
{
  const t = setupTmp()
  try {
    saveAdminSession({
      username: 'admin',
      accessToken: 'file-token',
      refreshToken: 'file-refresh',
      accessExp: futureExp(900),
    })
    process.env.PRESENCE_ADMIN_TOKEN = 'env-priority'
    const mgr = AdminTokenManager.fromEnv()
    const token = await mgr.resolveToken()
    assert(token === 'env-priority', 'AT2: ENV 우선 (파일 무시)')
  } finally {
    t.restore()
  }
}

// AT3 — resolveToken: 파일 모드 정상 (만료 미임박)
{
  const t = setupTmp()
  try {
    saveAdminSession({
      username: 'admin',
      accessToken: 'file-token',
      refreshToken: 'file-refresh',
      accessExp: futureExp(900),
    })
    const mgr = AdminTokenManager.fromEnv()
    const token = await mgr.resolveToken()
    assert(token === 'file-token', 'AT3: 파일 토큰 그대로 반환 (만료 미임박)')
  } finally {
    t.restore()
  }
}

// AT4 — resolveToken: 파일 부재 → CliPolicyError + 안내
{
  const t = setupTmp()
  try {
    const mgr = AdminTokenManager.fromEnv()
    let caught
    try { await mgr.resolveToken() } catch (err) { caught = err }
    assert(caught != null, 'AT4: 파일 부재 → throw')
    assert(/admin login/.test(caught.message), `AT4: admin login 안내 (got ${caught?.message})`)
    assert(caught.name === 'CliPolicyError', `AT4: CliPolicyError name (got ${caught?.name})`)
  } finally {
    t.restore()
  }
}

// AT5 — resolveToken: mode 0o644 위배 → CliPolicyError + chmod 안내
{
  const t = setupTmp()
  try {
    saveAdminSession({
      username: 'admin',
      accessToken: 'tok',
      refreshToken: 'ref',
      accessExp: futureExp(900),
    })
    chmodSync(adminSessionPath(), 0o644)
    const mgr = AdminTokenManager.fromEnv()
    let caught
    try { await mgr.resolveToken() } catch (err) { caught = err }
    assert(caught != null, 'AT5: mode 위배 → throw')
    assert(/권한 위배|chmod 600/.test(caught.message), `AT5: chmod 안내 (got ${caught?.message})`)
  } finally {
    t.restore()
  }
}

// AT6 — resolveToken: corrupt JSON → CliPolicyError + admin login 안내
{
  const t = setupTmp()
  try {
    const path = adminSessionPath()
    writeFileSync(path, 'not-json{', { mode: 0o600 })
    chmodSync(path, 0o600)
    const mgr = AdminTokenManager.fromEnv()
    let caught
    try { await mgr.resolveToken() } catch (err) { caught = err }
    assert(caught != null, 'AT6: corrupt → throw')
    assert(/손상|admin login/.test(caught.message), `AT6: 재로그인 안내 (got ${caught?.message})`)
  } finally {
    t.restore()
  }
}

// AT7 — resolveToken: 만료 임박 → refresh 호출 + 파일 갱신
{
  const t = setupTmp()
  const mock = mockFetchQueue([
    { status: 200, body: { accessToken: makeFakeJWT(900), refreshToken: 'new-refresh' } },
  ])
  try {
    saveAdminSession({
      username: 'admin',
      accessToken: 'old-token',
      refreshToken: 'old-refresh',
      accessExp: futureExp(10), // 30s buffer 안 — 임박
    })
    const mgr = AdminTokenManager.fromEnv()
    const token = await mgr.resolveToken()
    assert(token !== 'old-token', 'AT7: 새 토큰 (refresh 호출됨)')
    assert(mock.calls.length === 1, `AT7: fetch 1회 (got ${mock.calls.length})`)
    assert(/\/api\/auth\/refresh$/.test(mock.calls[0].url), `AT7: refresh endpoint`)
    const session = loadAdminSession()
    assert(session.refreshToken === 'new-refresh', 'AT7: 파일 refreshToken 갱신')
  } finally {
    mock.restore()
    t.restore()
  }
}

// AT8 — fetchAdminWithRetry: 401 시 force-refresh + retry (file 모드)
{
  const t = setupTmp()
  const mock = mockFetchQueue([
    { status: 401, body: { error: 'expired' } },                         // 첫 admin call → 401
    { status: 200, body: { accessToken: makeFakeJWT(900), refreshToken: 'r2' } }, // refresh
    { status: 200, body: { version: 42, reloadedAt: 'now' } },           // retry 성공
  ])
  try {
    saveAdminSession({
      username: 'admin',
      accessToken: 'stale-but-not-expired',
      refreshToken: 'r1',
      accessExp: futureExp(900), // 만료 미임박 — 첫 호출에 retry 없이 시도
    })
    const mgr = AdminTokenManager.fromEnv()
    const res = await mgr.fetchAdminWithRetry('/api/admin/policy/version', { method: 'GET' })
    assert(res.status === 200, `AT8: retry 후 200 (got ${res.status})`)
    assert(res.body.version === 42, 'AT8: body.version=42')
    assert(mock.calls.length === 3, `AT8: fetch 3회 (admin/refresh/retry — got ${mock.calls.length})`)
  } finally {
    mock.restore()
    t.restore()
  }
}

// AT9 — fetchAdminWithRetry: 401 retry 후 재 401 → CliPolicyError
{
  const t = setupTmp()
  const mock = mockFetchQueue([
    { status: 401, body: {} },                                            // 첫 admin call → 401
    { status: 200, body: { accessToken: makeFakeJWT(900), refreshToken: 'r2' } }, // refresh 성공
    { status: 401, body: {} },                                            // retry 도 401
  ])
  try {
    saveAdminSession({
      username: 'admin',
      accessToken: 'tok',
      refreshToken: 'r1',
      accessExp: futureExp(900),
    })
    const mgr = AdminTokenManager.fromEnv()
    let caught
    try { await mgr.fetchAdminWithRetry('/api/admin/policy/version', { method: 'GET' }) }
    catch (err) { caught = err }
    assert(caught != null, 'AT9: 재 401 → throw')
    assert(/refresh 후에도 401/.test(caught.message), `AT9: 안내 메시지 (got ${caught?.message})`)
  } finally {
    mock.restore()
    t.restore()
  }
}

// AT10 — fetchAdminWithRetry: ENV 모드는 401 retry 안 함 (운영자 명시 의도 존중)
{
  const t = setupTmp()
  const mock = mockFetchQueue([
    { status: 401, body: { error: 'expired' } }, // 한 번만 호출되어야 — retry 없음
  ])
  try {
    process.env.PRESENCE_ADMIN_TOKEN = 'env-token'
    const mgr = AdminTokenManager.fromEnv()
    const res = await mgr.fetchAdminWithRetry('/api/admin/policy/version', { method: 'GET' })
    assert(res.status === 401, 'AT10: 401 그대로 반환 (retry 없음)')
    assert(mock.calls.length === 1, `AT10: fetch 1회 (got ${mock.calls.length})`)
  } finally {
    mock.restore()
    t.restore()
  }
}

// AT11 — refresh 응답 401 → 파일 삭제 + 재로그인 안내
{
  const t = setupTmp()
  const mock = mockFetchQueue([
    { status: 401, body: {} }, // refresh 자체 실패 (refresh token 무효)
  ])
  try {
    saveAdminSession({
      username: 'admin',
      accessToken: 'tok',
      refreshToken: 'invalid-refresh',
      accessExp: futureExp(10), // 만료 임박 → resolveToken 이 refresh 시도
    })
    const mgr = AdminTokenManager.fromEnv()
    let caught
    try { await mgr.resolveToken() } catch (err) { caught = err }
    assert(caught != null, 'AT11: refresh 401 → throw')
    assert(/세션 만료|재로그인/.test(caught.message), `AT11: 재로그인 안내 (got ${caught?.message})`)
    assert(loadAdminSession() === null, 'AT11: 파일 삭제됨')
  } finally {
    mock.restore()
    t.restore()
  }
}

summary()
