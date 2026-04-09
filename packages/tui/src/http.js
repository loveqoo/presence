// =============================================================================
// HTTP client: JSON 기반 요청 + 인증 API 래퍼.
// 서버와의 모든 HTTP 통신은 jsonRequest를 경유한다.
// =============================================================================

// res.data/end 콜백을 resolve로 집약. JSON 파싱 실패 시 원문 body 반환.
const consumeJsonResponse = (res, resolve) => {
  let buf = ''
  res.on('data', d => { buf += d })
  res.on('end', () => {
    try { resolve({ status: res.statusCode, body: JSON.parse(buf) }) }
    catch { resolve({ status: res.statusCode, body: buf }) }
  })
}

// 단일 JSON HTTP 요청. body/token/timeoutMs 옵션 지원.
const jsonRequest = async (baseUrl, opts) => {
  const { method, path, body = null, token = null, timeoutMs = 0 } = opts
  const { default: http } = await import('node:http')
  const url = new URL(path, baseUrl)
  const data = body != null ? JSON.stringify(body) : null

  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (data) headers['Content-Length'] = Buffer.byteLength(data)

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search,
      method, headers,
    }, (res) => consumeJsonResponse(res, resolve))
    req.on('error', reject)
    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')) })
    if (data) req.write(data)
    req.end()
  })
}

// --- 인증/서버 상태 API ---

const checkServer = async (baseUrl) => {
  try {
    const res = await jsonRequest(baseUrl, { method: 'GET', path: '/api/instance', timeoutMs: 1500 })
    const authRequired = !!(res.body && typeof res.body === 'object' && res.body.authRequired)
    return { reachable: true, authRequired }
  } catch (_) {
    return { reachable: false, authRequired: false }
  }
}

const loginToServer = (baseUrl, username, password) =>
  jsonRequest(baseUrl, { method: 'POST', path: '/api/auth/login', body: { username, password } })

const changePasswordOnServer = (baseUrl, accessToken, currentPassword, newPassword) =>
  jsonRequest(baseUrl, {
    method: 'POST', path: '/api/auth/change-password',
    body: { currentPassword, newPassword }, token: accessToken,
  })

const refreshAccessToken = (baseUrl, refreshToken) =>
  jsonRequest(baseUrl, { method: 'POST', path: '/api/auth/refresh', body: { refreshToken } })

export { jsonRequest, checkServer, loginToServer, changePasswordOnServer, refreshAccessToken }
