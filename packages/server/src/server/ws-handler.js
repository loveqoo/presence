import fp from '@presence/core/lib/fun-fp.js'
import { AUTH_ERROR } from '@presence/infra/infra/auth/policy.js'
import { WS_CLOSE, WATCHED_PATHS } from './constants.js'
import { findOrCreateSession } from './session-api.js'

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

  // Phase 5: session 전체를 받아 turnGateRuntime.stateVersion 도 broadcast 에 첨부.
  // 클라이언트 MirrorState 가 최신성 판단 + stale 감지용으로 사용.
  watchSession(sessionId, session) {
    const state = session.state
    const getVersion = () => session.turnGateRuntime?.stateVersion ?? null
    for (const path of WATCHED_PATHS) {
      const broadcastPath = path.replace('.*', '')
      state.hooks.on(path, () => {
        this.broadcast({
          type: 'state',
          session_id: sessionId,
          path: broadcastPath,
          value: state.get(broadcastPath),
          stateVersion: getVersion(),
        })
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
  #getUserContextManager

  constructor({ host, authEnabled, wsAuth, userContext, getUserContextManager }) {
    this.#host = host
    this.#authEnabled = authEnabled
    this.#wsAuth = wsAuth
    this.#userContext = userContext
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

    // join 메시지 대기 — 클라이언트가 세션 ID를 지정해야 init 전송
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
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

  // join 메시지 처리: 유저별/글로벌 컨텍스트에서 세션 검색 + init 응답.
  async #handleJoin(ws, msg, wsUsername) {
    const sessionId = msg.session_id

    // 유저별 컨텍스트 해석 (REST의 resolveUserContext와 동일 로직)
    let effectiveCtx = this.#userContext
    const userContextManager = this.#getUserContextManager()
    if (this.#authEnabled && wsUsername && userContextManager) {
      const userCtx = await userContextManager.getOrCreate(wsUsername)
      effectiveCtx = userCtx?.userContext || this.#userContext
    }

    const entry = findOrCreateSession(sessionId, wsUsername, effectiveCtx)
    if (!entry) return

    if (this.#authEnabled && wsUsername && entry.owner !== null && entry.owner !== wsUsername) {
      ws.send(JSON.stringify({ type: 'error', code: 403, message: 'Access denied: session belongs to another user' }))
      return
    }
    ws.send(JSON.stringify({
      type: 'init',
      session_id: sessionId,
      state: entry.session.state.snapshot(),
      stateVersion: entry.session.turnGateRuntime?.stateVersion ?? null,
      // Effective workingDir — TUI 가 매 join 시 최신값 수신 (stale cache 회피).
      workingDir: entry.session.workingDir,
    }))
  }
}

export { SessionBridge, sessionBridgeR, WsHandler }
