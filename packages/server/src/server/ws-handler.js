import fp from '@presence/core/lib/fun-fp.js'
import { AUTH_ERROR } from '@presence/infra/infra/auth/policy.js'
import { WS_CLOSE, WATCHED_PATHS } from './constants.js'

const { Either, Reader } = fp

// =============================================================================
// WebSocket 계층: SessionBridge (state broadcast) + WsHandler (connection 관리).
// =============================================================================

// --- SessionBridge: 세션 state 변경을 연결된 WS 클라이언트에 push ---

class SessionBridge {
  #wss

  constructor(wss) {
    this.#wss = wss
  }

  broadcast(data) {
    const msg = JSON.stringify(data)
    for (const ws of this.#wss.clients) {
      if (ws.readyState === 1) ws.send(msg)
    }
  }

  watchSession(sessionId, state) {
    for (const path of WATCHED_PATHS) {
      const broadcastPath = path.replace('.*', '')
      state.hooks.on(path, () => {
        this.broadcast({ type: 'state', session_id: sessionId, path: broadcastPath, value: state.get(broadcastPath) })
      })
    }
  }
}

const sessionBridgeR = Reader.asks(({ wss }) => new SessionBridge(wss))

// --- WsHandler: connection 인증 + 세션 init/join ---

const wsCloseCode = (authError) =>
  authError.code === AUTH_ERROR.PASSWORD_CHANGE_REQUIRED
    ? WS_CLOSE.PASSWORD_CHANGE_REQUIRED
    : WS_CLOSE.AUTH_FAILED

class WsHandler {
  #host
  #authEnabled
  #wsAuth
  #userContext
  #defaultSession
  #getUserContextManager

  constructor({ host, authEnabled, wsAuth, userContext, defaultSession, getUserContextManager }) {
    this.#host = host
    this.#authEnabled = authEnabled
    this.#wsAuth = wsAuth
    this.#userContext = userContext
    this.#defaultSession = defaultSession
    this.#getUserContextManager = getUserContextManager
  }

  attach(wss) {
    wss.on('connection', (ws, req) => this.#handleConnection(ws, req))
  }

  #handleConnection(ws, req) {
    // Origin 체크 (쿠키 기반 인증 시만)
    if (this.#authEnabled && !req.headers.authorization && !this.#checkOrigin(req)) {
      ws.close(WS_CLOSE.ORIGIN_NOT_ALLOWED, 'Origin not allowed')
      return
    }

    // WS 인증
    if (this.#authEnabled && !this.#authenticate(ws, req)) return

    // 유저별 활동 추적
    const wsUsername = ws.user?.username ?? null
    const userContextManager = this.#getUserContextManager()
    if (wsUsername && userContextManager) {
      userContextManager.touch(wsUsername)
      userContextManager.addWs(wsUsername, ws)
    }

    // 기본 세션 init 전송 (user-default 하위 호환)
    ws.send(JSON.stringify({ type: 'init', session_id: 'user-default', state: this.#defaultSession.state.snapshot() }))

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        // join 메시지 처리: 세션 소유권 검증 + init 응답
        if (msg.type === 'join') this.#handleJoin(ws, msg, wsUsername)
      } catch (_) {}
    })

    ws.on('close', () => {
      if (wsUsername && userContextManager) userContextManager.removeWs(wsUsername, ws)
    })
  }

  // Origin 검증 — 쿠키 기반 WS 인증 시 CSRF 방지.
  #checkOrigin(req) {
    const origin = req.headers.origin
    if (!origin) return true
    try {
      const hostname = new URL(origin).hostname
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === this.#host
    } catch {
      return false
    }
  }

  // WS 인증 수행. 실패 시 ws 종료 + false 반환.
  #authenticate(ws, req) {
    let authenticated = false
    Either.fold(
      error => { ws.close(wsCloseCode(error), error.message) },
      principal => { ws.user = principal; authenticated = true },
      this.#wsAuth.authenticateUpgrade(req),
    )
    return authenticated
  }

  // join 메시지 처리: 세션 소유권 검증 + init 응답.
  #handleJoin(ws, msg, wsUsername) {
    const entry = this.#userContext.sessions.get(msg.session_id)
    if (!entry) return
    if (this.#authEnabled && wsUsername && entry.owner !== null && entry.owner !== wsUsername) {
      ws.send(JSON.stringify({ type: 'error', code: 403, message: 'Access denied: session belongs to another user' }))
      return
    }
    ws.send(JSON.stringify({ type: 'init', session_id: msg.session_id, state: entry.session.state.snapshot() }))
  }
}

export { SessionBridge, sessionBridgeR, WsHandler }
