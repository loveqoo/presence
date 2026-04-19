import { WebSocket } from 'ws'
import { WS_CLOSE, WS_RECONNECT, STATE_PATH } from '@presence/core/core/policies.js'
import { State } from './state.js'

// =============================================================================
// MirrorState: 서버 OriginState를 WS로 미러링하는 클라이언트 측 State.
// set()은 no-op — 상태 변경은 서버 REST API 경유.
// 서버 bridge(createSessionBridge)가 WATCHED_PATHS 변경을 push하면
// 로컬 cache 갱신 + HookBus publish.
// =============================================================================

const SNAPSHOT_PATHS = [
  STATE_PATH.TURN_STATE, STATE_PATH.LAST_TURN, STATE_PATH.TURN,
  STATE_PATH.CONTEXT_MEMORIES, STATE_PATH.CONTEXT_CONVERSATION_HISTORY,
  STATE_PATH.STREAMING, STATE_PATH.RETRY, STATE_PATH.APPROVE,
  STATE_PATH.DEBUG_LAST_TURN, STATE_PATH.DEBUG_LAST_PROMPT, STATE_PATH.DEBUG_LAST_RESPONSE,
  STATE_PATH.DEBUG_OP_TRACE, STATE_PATH.DEBUG_RECALLED_MEMORIES, STATE_PATH.DEBUG_ITERATION_HISTORY,
  STATE_PATH.BUDGET_WARNING, STATE_PATH.TOOL_RESULTS, STATE_PATH.TOOL_TRANSCRIPT,
  STATE_PATH.PENDING_INPUT,
  STATE_PATH.TODOS, STATE_PATH.EVENTS, STATE_PATH.DELEGATES,
]

const noop = Function.prototype

function getNestedValue(obj, path) {
  let cur = obj
  for (const key of path.split('.')) {
    if (cur == null) return undefined
    cur = cur[key]
  }
  return cur
}

class MirrorState extends State {
  constructor(opts = {}) {
    super()
    const { wsUrl, sessionId = 'user-default', headers, getHeaders, onAuthFailed, onUnrecoverable } = opts
    this.cache = { _reconnecting: false, lastStateVersion: null }
    this.wsUrl = wsUrl
    this.sessionId = sessionId
    this.getHeaders = getHeaders || (headers ? () => headers : () => undefined)
    this.onAuthFailed = onAuthFailed
    this.onUnrecoverable = onUnrecoverable
    this.ws = null
    this.reconnectTimer = null
    this.connectAttempt = 0
    this.stopped = false
    this.connect()
  }

  get(path) { return this.cache[path] }
  set() { /* no-op: 서버 REST 경유 */ }

  get lastStateVersion() { return this.cache.lastStateVersion }

  // Stale 감지 / HTTP reject 후 최신화 트리거. WS 재접속 없이 현재 연결에서 join 재전송 →
  // 서버가 init 으로 full snapshot 재송신 (`ws-handler.js` 의 init 경로).
  requestRefresh() {
    if (!this.ws || this.ws.readyState !== 1) return false
    this.ws.send(JSON.stringify({ type: 'join', session_id: this.sessionId }))
    return true
  }

  applyPatch(path, value) {
    const prev = this.cache[path]
    this.cache[path] = value
    this.bus.publish({ path, prevValue: prev, nextValue: value }, this)
  }

  applySnapshot(snapshot) {
    const prev = {}
    for (const path of SNAPSHOT_PATHS) {
      prev[path] = this.cache[path]
      this.cache[path] = getNestedValue(snapshot, path)
    }
    for (const path of SNAPSHOT_PATHS) {
      this.bus.publish({ path, prevValue: prev[path], nextValue: this.cache[path] }, this)
    }
  }

  setReconnecting(flag) {
    if (this.cache._reconnecting === flag) return
    const prev = this.cache._reconnecting
    this.cache._reconnecting = flag
    this.bus.publish({ path: '_reconnecting', prevValue: prev, nextValue: flag }, this)
  }

  connect() {
    if (this.stopped) return
    const hdrs = this.getHeaders()
    this.ws = new WebSocket(this.wsUrl, hdrs ? { headers: hdrs } : undefined)
    this.ws.on('open', () => {
      this.connectAttempt = 0
      this.setReconnecting(false)
      this.ws.send(JSON.stringify({ type: 'join', session_id: this.sessionId }))
    })
    this.ws.on('message', this.handleMessage.bind(this))
    this.ws.on('close', this.handleClose.bind(this))
    this.ws.on('error', noop)
  }

  handleMessage(data) {
    try {
      const msg = JSON.parse(data.toString())
      // session_id 가 있고 내 세션과 다르면 skip (cross-session 방어).
      // 없는 메시지는 backward-compat 로 통과.
      if (msg.session_id !== undefined && msg.session_id !== this.sessionId) return
      if (msg.type === 'init') {
        this.applySnapshot(msg.state)
        this.cache.lastStateVersion = msg.stateVersion ?? null   // init 은 무조건 덮어씀
      } else if (msg.type === 'state') {
        // stale 판정: 내 lastStateVersion 보다 앞 (lex 비교) 이면 skip.
        // TCP ordered 하에선 드물지만 재접속 직후 중복 메시지 방어.
        const lastV = this.cache.lastStateVersion
        const newV = msg.stateVersion ?? null
        if (lastV && newV && newV < lastV) return
        this.applyPatch(msg.path, msg.value)
        if (newV) this.cache.lastStateVersion = newV
      }
    } catch (_) {}
  }

  async handleClose(code) {
    if (this.stopped) return
    if (code === WS_CLOSE.PASSWORD_CHANGE_REQUIRED || code === WS_CLOSE.ORIGIN_NOT_ALLOWED) {
      this.stopped = true
      if (this.onUnrecoverable) this.onUnrecoverable(code)
      return
    }
    if (code === WS_CLOSE.AUTH_FAILED && this.onAuthFailed) {
      let refreshed = false
      try { refreshed = await this.onAuthFailed() } catch (_) {}
      if (refreshed) { this.connectAttempt = 0; this.connect(); return }
      this.stopped = true
      if (this.onUnrecoverable) this.onUnrecoverable(code)
      return
    }
    this.setReconnecting(true)
    const backoff = Math.min(WS_RECONNECT.BACKOFF_BASE_MS * Math.pow(2, this.connectAttempt++), WS_RECONNECT.BACKOFF_MAX_MS)
    this.reconnectTimer = setTimeout(this.connect.bind(this), backoff)
  }

  disconnect() {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }
}

function createMirrorState(opts) { return new MirrorState(opts) }

export { MirrorState, createMirrorState }
