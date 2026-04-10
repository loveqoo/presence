import { WebSocket } from 'ws'
import { WS_CLOSE } from '@presence/core/core/policies.js'
import { State } from './state.js'

// =============================================================================
// MirrorState: 서버 OriginState를 WS로 미러링하는 클라이언트 측 State.
// set()은 no-op — 상태 변경은 서버 REST API 경유.
// 서버 bridge(createSessionBridge)가 WATCHED_PATHS 변경을 push하면
// 로컬 cache 갱신 + HookBus publish.
// =============================================================================

// 서버 WATCHED_PATHS에 대응하는 플랫 경로 목록 (wildcard 제외)
const SNAPSHOT_PATHS = [
  'turnState', 'lastTurn', 'turn',
  'context.memories', 'context.conversationHistory',
  '_streaming', '_retry', '_approve',
  '_debug.lastTurn', '_debug.lastPrompt', '_debug.lastResponse',
  '_debug.opTrace', '_debug.recalledMemories', '_debug.iterationHistory',
  '_budgetWarning', '_toolResults',
  'todos', 'events', 'delegates',
]

const getNestedValue = (obj, path) =>
  path.split('.').reduce((o, k) => o?.[k], obj)

class MirrorState extends State {
  constructor(opts = {}) {
    super()
    const { wsUrl, sessionId = 'user-default', headers, getHeaders, onAuthFailed, onUnrecoverable } = opts
    this.cache = {}
    this.wsUrl = wsUrl
    this.sessionId = sessionId
    this.getHeaders = getHeaders || (() => headers)
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

  // 서버 state patch 수신: 특정 경로 값 업데이트 + publish
  applyPatch(path, value) {
    const prev = this.cache[path]
    this.cache[path] = value
    this.publishChange(path, prev, value)
  }

  // 서버 init 수신: 전체 스냅샷으로 cache 초기화 + 일괄 publish
  applySnapshot(snapshot) {
    const prev = {}
    for (const path of SNAPSHOT_PATHS) {
      prev[path] = this.cache[path]
      this.cache[path] = getNestedValue(snapshot, path)
    }
    for (const path of SNAPSHOT_PATHS) this.publishChange(path, prev[path], this.cache[path])
  }

  // StateChange (remote mirror): prevRoot/nextRoot 없이 path·prevValue·nextValue만.
  publishChange(path, prevValue, nextValue) {
    this.bus.publish({ path, prevValue, nextValue }, this)
  }

  connect() {
    if (this.stopped) return
    const headers = this.getHeaders()
    this.ws = new WebSocket(this.wsUrl, headers ? { headers } : undefined)

    this.ws.on('open', () => {
      this.connectAttempt = 0
      this.ws.send(JSON.stringify({ type: 'join', session_id: this.sessionId }))
    })

    this.ws.on('message', (data) => this.handleMessage(data))

    this.ws.on('close', (code) => this.handleClose(code))

    this.ws.on('error', () => {})  // close 이벤트에서 재연결 처리
  }

  async handleClose(code) {
    if (this.stopped) return
    // 복구 불가: 비밀번호 변경 필요 / Origin 거부
    if (code === WS_CLOSE.PASSWORD_CHANGE_REQUIRED || code === WS_CLOSE.ORIGIN_NOT_ALLOWED) {
      this.stopped = true
      if (this.onUnrecoverable) this.onUnrecoverable(code)
      return
    }
    // 인증 실패: 토큰 갱신 1회 시도 후 재연결
    if (code === WS_CLOSE.AUTH_FAILED && this.onAuthFailed) {
      const refreshed = await this.onAuthFailed().catch(() => false)
      if (refreshed) {
        this.connectAttempt = 0
        this.connect()
        return
      }
      this.stopped = true
      if (this.onUnrecoverable) this.onUnrecoverable(code)
      return
    }
    // 그 외: 지수 백오프 재연결
    const delay = Math.min(500 * Math.pow(2, this.connectAttempt++), 15_000)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  handleMessage(data) {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'init') this.applySnapshot(msg.state)
      else if (msg.type === 'state') this.applyPatch(msg.path, msg.value)
    } catch (_) {}
  }

  disconnect() {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }
}

const createMirrorState = (opts) => new MirrorState(opts)

export { MirrorState, createMirrorState }
