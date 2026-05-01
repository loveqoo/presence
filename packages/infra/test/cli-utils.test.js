// CLI 공통 유틸 단위 테스트 — requireFlag / httpJson / mapHttpFetchError / HttpFetchError /
// CliError / dispatchWithCliErrorHandling / AUTH_PATHS / ADMIN_PATHS.
// 통합 테스트로만 검증되던 헬퍼들을 단위 단계에서 분리 검증.

import {
  requireFlag,
  httpJson,
  mapHttpFetchError,
  HttpFetchError,
  CliError,
  dispatchWithCliErrorHandling,
  AUTH_PATHS,
  ADMIN_PATHS,
  resolveBaseUrl,
} from '@presence/infra/infra/auth/cli-utils.js'
import { assert, summary } from '../../../test/lib/assert.js'

const captureExit = async (fn) => {
  const origExit = process.exit
  const origError = console.error
  let exitCode = 0
  const stderr = []
  process.exit = (code) => { exitCode = code; throw new Error('__exited__') }
  console.error = (...args) => { stderr.push(args.map(String).join(' ')) }
  let returnValue
  let threw = null
  try {
    returnValue = await fn()
  } catch (err) {
    if (err.message !== '__exited__') threw = err
  } finally {
    process.exit = origExit
    console.error = origError
  }
  if (threw) throw threw
  return { exitCode, stderr: stderr.join('\n'), returnValue }
}

console.log('cli-utils unit tests')

// CU1 — requireFlag: 값 있으면 그대로 반환
{
  const value = requireFlag({ username: 'admin' }, 'username')
  assert(value === 'admin', 'CU1: requireFlag returns flag value')
}

// CU2 — requireFlag: 값 없으면 process.exit(1) + stderr 안내
{
  const r = await captureExit(() => requireFlag({}, 'name'))
  assert(r.exitCode === 1, `CU2: requireFlag missing → exit 1 (got ${r.exitCode})`)
  assert(/--name is required/.test(r.stderr), `CU2: stderr 안내 메시지 (got ${r.stderr})`)
}

// CU3 — HttpFetchError 생성자: kind/status/message 보존
{
  const err = new HttpFetchError({ kind: 'unreachable', message: 'ECONNREFUSED' })
  assert(err.name === 'HttpFetchError', 'CU3: name')
  assert(err.kind === 'unreachable', 'CU3: kind')
  assert(err.message === 'ECONNREFUSED', 'CU3: message')
  assert(err instanceof Error, 'CU3: instanceof Error')

  const parseErr = new HttpFetchError({ kind: 'parse', status: 200, message: 'Unexpected token' })
  assert(parseErr.kind === 'parse', 'CU3: parse kind')
  assert(parseErr.status === 200, 'CU3: parse status')
}

// CU4 — httpJson: 정상 응답 → { status, ok, body }
{
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({ message: 'ok' }),
  })
  try {
    const res = await httpJson('http://localhost/test')
    assert(res.status === 200, 'CU4: status 200')
    assert(res.ok === true, 'CU4: ok=true')
    assert(res.body.message === 'ok', 'CU4: body parsed')
  } finally {
    globalThis.fetch = origFetch
  }
}

// CU5 — httpJson: 네트워크 도달 실패 → HttpFetchError(kind='unreachable')
{
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED 127.0.0.1:3000') }
  try {
    let caught
    try { await httpJson('http://localhost/test') }
    catch (err) { caught = err }
    assert(caught instanceof HttpFetchError, 'CU5: HttpFetchError thrown')
    assert(caught.kind === 'unreachable', `CU5: kind=unreachable (got ${caught?.kind})`)
    assert(/ECONNREFUSED/.test(caught.message), 'CU5: original message preserved')
  } finally {
    globalThis.fetch = origFetch
  }
}

// CU6 — httpJson: JSON 파싱 실패 → HttpFetchError(kind='parse', status 보존)
{
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    status: 502,
    ok: false,
    json: async () => { throw new SyntaxError('Unexpected token <') },
  })
  try {
    let caught
    try { await httpJson('http://localhost/test') }
    catch (err) { caught = err }
    assert(caught instanceof HttpFetchError, 'CU6: HttpFetchError thrown')
    assert(caught.kind === 'parse', `CU6: kind=parse (got ${caught?.kind})`)
    assert(caught.status === 502, `CU6: status preserved (${caught?.status})`)
  } finally {
    globalThis.fetch = origFetch
  }
}

// CU7 — mapHttpFetchError: HttpFetchError unreachable → CliErrorClass with prefix + 안내
{
  class CliTestError extends Error {}
  const httpErr = new HttpFetchError({ kind: 'unreachable', message: 'ENOTFOUND' })
  const mapped = mapHttpFetchError(httpErr, CliTestError, 'admin login')
  assert(mapped instanceof CliTestError, 'CU7: CliTestError 인스턴스')
  assert(/admin login: 서버 도달 실패 — ENOTFOUND/.test(mapped.message), `CU7: prefix + 메시지 (${mapped.message})`)
  assert(/npm start/.test(mapped.message), 'CU7: 재시도 안내 포함')
}

// CU8 — mapHttpFetchError: HttpFetchError parse → CliErrorClass + status 노출
{
  class CliTestError extends Error {}
  const httpErr = new HttpFetchError({ kind: 'parse', status: 500, message: 'bad json' })
  const mapped = mapHttpFetchError(httpErr, CliTestError, 'policy')
  assert(mapped instanceof CliTestError, 'CU8: CliTestError 인스턴스')
  assert(/policy: 응답 파싱 실패 \(HTTP 500\)/.test(mapped.message), `CU8: prefix + status (${mapped.message})`)
}

// CU9 — mapHttpFetchError: HttpFetchError 가 아닌 에러는 그대로 pass-through
{
  class CliTestError extends Error {}
  const generic = new Error('generic')
  const mapped = mapHttpFetchError(generic, CliTestError, 'admin')
  assert(mapped === generic, 'CU9: non-HttpFetchError → 동일 객체 그대로 반환')
}

// CU10 — CliError 베이스: name 기본값 + 사용자 지정
{
  const base = new CliError('msg')
  assert(base.name === 'CliError', 'CU10: name 기본값')
  assert(base.message === 'msg', 'CU10: message 보존')
  assert(base instanceof Error, 'CU10: instanceof Error')

  const named = new CliError('m', 'CliFooError')
  assert(named.name === 'CliFooError', 'CU10: 사용자 지정 name')
}

// CU11 — CliError.display(): stderr + exit(1)
{
  const err = new CliError('boom')
  const r = await captureExit(() => err.display())
  assert(r.exitCode === 1, `CU11: display → exit 1 (got ${r.exitCode})`)
  assert(/boom/.test(r.stderr), `CU11: message stderr (got ${r.stderr})`)
}

// CU12 — dispatchWithCliErrorHandling: CliError 잡고 display 호출
{
  const r = await captureExit(() => dispatchWithCliErrorHandling(() => {
    throw new CliError('handled')
  }))
  assert(r.exitCode === 1, 'CU12: CliError → exit 1')
  assert(/handled/.test(r.stderr), 'CU12: message stderr')
}

// CU13 — dispatchWithCliErrorHandling: non-CliError 는 그대로 위로 throw
{
  let caught
  try {
    await dispatchWithCliErrorHandling(() => { throw new Error('not cli') })
  } catch (err) { caught = err }
  assert(caught instanceof Error && caught.message === 'not cli', 'CU13: non-CliError pass-through')
}

// CU14 — dispatchWithCliErrorHandling: 정상 반환값 그대로 전달
{
  const result = await dispatchWithCliErrorHandling(() => 'ok')
  assert(result === 'ok', 'CU14: 정상 반환값 보존')
}

// CU15 — AUTH_PATHS / ADMIN_PATHS: 정의 + 동결 (수정 시 throw)
{
  assert(AUTH_PATHS.LOGIN === '/api/auth/login', 'CU15: AUTH_PATHS.LOGIN')
  assert(AUTH_PATHS.LOGOUT === '/api/auth/logout', 'CU15: AUTH_PATHS.LOGOUT')
  assert(AUTH_PATHS.REFRESH === '/api/auth/refresh', 'CU15: AUTH_PATHS.REFRESH')
  assert(ADMIN_PATHS.POLICY_RELOAD === '/api/admin/policy/reload', 'CU15: ADMIN_PATHS.POLICY_RELOAD')
  assert(ADMIN_PATHS.POLICY_VERSION === '/api/admin/policy/version', 'CU15: ADMIN_PATHS.POLICY_VERSION')
  assert(Object.isFrozen(AUTH_PATHS), 'CU15: AUTH_PATHS frozen')
  assert(Object.isFrozen(ADMIN_PATHS), 'CU15: ADMIN_PATHS frozen')
}

// CU16 — resolveBaseUrl: env override + 기본값
{
  const orig = process.env.PRESENCE_SERVER_URL
  delete process.env.PRESENCE_SERVER_URL
  assert(resolveBaseUrl() === 'http://localhost:3000', 'CU16: 기본값')
  process.env.PRESENCE_SERVER_URL = 'https://prod.example.com'
  assert(resolveBaseUrl() === 'https://prod.example.com', 'CU16: env override')
  if (orig === undefined) delete process.env.PRESENCE_SERVER_URL
  else process.env.PRESENCE_SERVER_URL = orig
}

summary()
