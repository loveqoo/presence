import fp from '@presence/core/lib/fun-fp.js'
import { authenticateWsR } from '@presence/infra/infra/auth/auth-ws.js'

const { Either } = fp

// =============================================================================
// WebSocket connection handler: Origin 검증 + WS 인증 + 세션 init/join.
// =============================================================================

// Origin 검증 — 쿠키 기반 WS 인증 시 CSRF 방지.
// Authorization 헤더 없으면 브라우저 연결로 간주 → Origin 필수 허용 목록.
const checkOrigin = (req, host) => {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const hostname = new URL(origin).hostname
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === host
  } catch {
    return false
  }
}

// WS 인증 수행. 실패 시 ws 종료 + false 반환.
const authenticateWs = (ws, req, authDeps) => {
  const { tokenService, userStore } = authDeps
  let authenticated = false
  Either.fold(
    () => { ws.close(4001, 'Unauthorized') },
    payload => { ws.user = payload; authenticated = true },
    authenticateWsR(req).run({ tokenService, userStore }),
  )
  if (!authenticated) return false
  if (ws.user?.mustChangePassword) {
    ws.close(4002, 'Password change required')
    return false
  }
  return true
}

// join 메시지 처리: 세션 소유권 검증 + init 응답.
const handleJoinMessage = (ws, msg, ctx) => {
  const { userContext, authEnabled, wsUsername } = ctx
  const entry = userContext.sessions.get(msg.session_id)
  if (!entry) return
  if (authEnabled && wsUsername && entry.owner !== null && entry.owner !== wsUsername) {
    ws.send(JSON.stringify({ type: 'error', code: 403, message: 'Access denied: session belongs to another user' }))
    return
  }
  ws.send(JSON.stringify({ type: 'init', session_id: msg.session_id, state: entry.session.state.snapshot() }))
}

const attachWsHandler = (wss, deps) => {
  const { host, authEnabled, tokenService, userStore, userContext, defaultSession, getUserContextManager } = deps

  wss.on('connection', (ws, req) => {
    // Origin 체크 (쿠키 기반 인증 시만)
    if (authEnabled && !req.headers.authorization && !checkOrigin(req, host)) {
      ws.close(4003, 'Origin not allowed')
      return
    }

    // WS 인증
    if (authEnabled && !authenticateWs(ws, req, { tokenService, userStore })) return

    // 유저별 활동 추적
    const wsUsername = ws.user?.username ?? null
    const userContextManager = getUserContextManager()
    if (wsUsername && userContextManager) {
      userContextManager.touch(wsUsername)
      userContextManager.addWs(wsUsername, ws)
    }

    // 기본 세션 init 전송 (user-default 하위 호환)
    ws.send(JSON.stringify({ type: 'init', session_id: 'user-default', state: defaultSession.state.snapshot() }))

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'join') handleJoinMessage(ws, msg, { userContext, authEnabled, wsUsername })
      } catch (_) {}
    })

    ws.on('close', () => {
      if (wsUsername && userContextManager) userContextManager.removeWs(wsUsername, ws)
    })
  })
}

export { attachWsHandler }
