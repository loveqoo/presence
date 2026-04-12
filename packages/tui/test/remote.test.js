import { createAuthClient } from '../src/auth-client.js'
import { REST_ERROR } from '@presence/core/core/policies.js'
import { assert, summary } from '../../../test/lib/assert.js'

// createAuthClient: 401 자동 재시도 + refresh 실패 시 AUTH_FAILED 에러 throw.
// KG-01 해소 검증 — refresh 실패는 onAuthFailed 콜백 경로로 흐른다.

const run = async () => {
  // --- 200 응답 → body 반환 ---
  {
    const httpFn = async () => ({ status: 200, body: { result: 'ok' } })
    const client = createAuthClient('http://x', null, async () => false, { httpFn })
    const result = await client.post('/api/x')
    assert(result.result === 'ok', 'createAuthClient: 200 → body 반환')
  }

  // --- 401 → refresh 성공 → 갱신된 토큰으로 재시도 ---
  {
    const calls = []
    const authState = { accessToken: 'old', refreshToken: 'r' }
    const httpFn = async (_, opts) => {
      calls.push({ ...opts })
      if (calls.length === 1) return { status: 401, body: { error: 'expired' } }
      return { status: 200, body: { ok: true } }
    }
    const tryRefresh = async () => { authState.accessToken = 'new'; return true }
    const client = createAuthClient('http://x', authState, tryRefresh, { httpFn })

    const result = await client.post('/api/ping', { a: 1 })

    assert(result.ok === true, 'createAuthClient: 401 → refresh 성공 → retry body 반환')
    assert(calls.length === 2, 'createAuthClient: 재시도 1회 포함 호출 2회')
    assert(calls[0].token === 'old' && calls[1].token === 'new',
      'createAuthClient: 재시도는 갱신된 token 사용')
  }

  // --- 401 → refresh 실패 → onAuthFailed + AUTH_FAILED throw (KG-01 핵심) ---
  {
    let authFailedCalled = false
    const httpFn = async () => ({ status: 401, body: { error: 'revoked' } })
    const authState = { accessToken: 'old', refreshToken: 'r' }
    const tryRefresh = async () => false
    const client = createAuthClient('http://x', authState, tryRefresh, {
      httpFn,
      onAuthFailed: () => { authFailedCalled = true },
    })

    let thrown = null
    try { await client.post('/api/chat', { input: 'hi' }) }
    catch (err) { thrown = err }

    assert(thrown !== null, 'createAuthClient: refresh 실패 → throw')
    assert(thrown?.kind === REST_ERROR.AUTH_FAILED,
      'createAuthClient: 에러 kind=AUTH_FAILED (KG-01 sentinel)')
    assert(authFailedCalled, 'createAuthClient: onAuthFailed 콜백 호출')
  }

  // --- authState 부재 → refresh 경로 건너뜀 ---
  {
    let refreshCalled = false
    const httpFn = async () => ({ status: 401, body: { error: 'no auth' } })
    const tryRefresh = async () => { refreshCalled = true; return true }
    const client = createAuthClient('http://x', null, tryRefresh, { httpFn })
    const result = await client.post('/api/x')
    assert(result.error === 'no auth',
      'createAuthClient: authState 부재 시 401 body 그대로 반환')
    assert(!refreshCalled, 'createAuthClient: authState 부재 시 refresh 호출 안 함')
  }

  // --- getJson: null → [] fallback ---
  {
    const httpFn = async () => ({ status: 200, body: null })
    const client = createAuthClient('http://x', null, async () => false, { httpFn })
    const result = await client.getJson('/api/list')
    assert(Array.isArray(result) && result.length === 0,
      'createAuthClient: getJson null → [] fallback')
  }

  // --- del: DELETE 메서드 사용 ---
  {
    const calls = []
    const httpFn = async (_, opts) => {
      calls.push(opts)
      return { status: 200, body: { deleted: true } }
    }
    const client = createAuthClient('http://x', null, async () => false, { httpFn })
    await client.del('/api/sessions/foo')
    assert(calls[0].method === 'DELETE', 'createAuthClient: del → method=DELETE')
    assert(calls[0].path === '/api/sessions/foo',
      'createAuthClient: del → path 전달')
  }

  summary()
}

run()
