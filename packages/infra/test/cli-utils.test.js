// CLI 공통 유틸 단위 테스트 — requireFlag / httpJson / mapHttpFetchError / HttpFetchError.
// Tier 2 cleanup — 통합 테스트로만 검증되던 헬퍼들을 단위 단계에서 분리 검증.

import {
  requireFlag,
  httpJson,
  mapHttpFetchError,
  HttpFetchError,
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

summary()
