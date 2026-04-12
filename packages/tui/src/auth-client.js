import { jsonRequest, refreshAccessToken } from './http.js'

// =============================================================================
// Auth HTTP client: 401 자동 refresh + AUTH_FAILED sentinel throw.
// =============================================================================

function createTokenRefresher(baseUrl, authState) {
  let refreshPromise = null
  return async function tryRefresh() {
    if (!authState) return false
    if (refreshPromise) return refreshPromise
    refreshPromise = (async () => {
      try {
        const res = await refreshAccessToken(baseUrl, authState.refreshToken)
        if (res.status === 200) {
          authState.accessToken = res.body.accessToken
          if (res.body.refreshToken) authState.refreshToken = res.body.refreshToken
          return true
        }
      } catch (_) {}
      return false
    })()
    const result = await refreshPromise
    refreshPromise = null
    return result
  }
}

function createAuthClient(baseUrl, authState, tryRefresh, opts = {}) {
  const { onAuthFailed, httpFn = jsonRequest } = opts
  async function request(method, path, body) {
    const res = await httpFn(baseUrl, { method, path, body, token: authState?.accessToken })
    if (res.status === 401 && authState) {
      const refreshed = await tryRefresh()
      if (refreshed) {
        const retry = await httpFn(baseUrl, { method, path, body, token: authState?.accessToken })
        return retry.body
      }
      if (onAuthFailed) onAuthFailed()
      const err = new Error('AUTH_FAILED')
      err.kind = 'AUTH_FAILED'
      throw err
    }
    return res.body
  }
  return {
    post(path, body) { return request('POST', path, body) },
    del(path) { return request('DELETE', path) },
    async getJson(path) { return (await request('GET', path)) ?? [] },
  }
}

export { createTokenRefresher, createAuthClient }
