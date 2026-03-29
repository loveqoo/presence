import { WebSocket } from 'ws'

// =============================================================================
// RemoteState
// 서버의 ReactiveState를 WS로 미러링하는 클라이언트 측 상태 어댑터.
// get() + hooks.on/off 인터페이스를 구현하여 useAgentState가 그대로 동작.
//
// 서버 브릿지(createSessionBridge)가 WATCHED_PATHS 변경을 push하면
// 로컬 cache를 업데이트하고 등록된 handlers를 실행.
// =============================================================================

// 서버 WATCHED_PATHS에 대응하는 플랫 경로 목록 (wildcard 제외)
const SNAPSHOT_PATHS = [
  'turnState', 'lastTurn', 'turn',
  'context.memories', 'context.conversationHistory',
  '_streaming', '_retry', '_approve',
  '_debug.lastTurn', '_debug.opTrace', '_debug.recalledMemories', '_debug.iterationHistory',
  '_budgetWarning', '_toolResults',
  'todos', 'events', 'delegates',
]

const getNestedValue = (obj, path) =>
  path.split('.').reduce((o, k) => o?.[k], obj)

const createRemoteState = ({ wsUrl, sessionId = 'user-default', headers } = {}) => {
  const cache = {}
  const listeners = new Map()  // path → Set<handler>

  const get = (path) => cache[path]

  const on = (path, handler) => {
    if (!listeners.has(path)) listeners.set(path, new Set())
    listeners.get(path).add(handler)
  }

  const off = (path, handler) => {
    listeners.get(path)?.delete(handler)
  }

  // set은 no-op: clearDebugState 등 로컬 state 조작 코드가 에러 없이 통과하도록.
  // 실제 상태 변경은 서버 REST API를 통해 이루어짐.
  const set = () => {}

  const hooks = { on, off }

  const fire = (path, value) => {
    listeners.get(path)?.forEach(h => h(value, { get }))
    // path가 'events'이면 'events.*' wildcard 핸들러도 실행
    listeners.get(`${path}.*`)?.forEach(h => h(value, { get }))
  }

  // 서버 state patch 수신: 특정 경로 값 업데이트
  const applyPatch = (path, value) => {
    cache[path] = value
    fire(path, value)
  }

  // 서버 init 수신: 전체 스냅샷으로 cache 초기화
  const applySnapshot = (snapshot) => {
    for (const path of SNAPSHOT_PATHS) {
      cache[path] = getNestedValue(snapshot, path)
    }
    // cache 전체 초기화 후 핸들러 일괄 실행
    for (const path of SNAPSHOT_PATHS) {
      fire(path, cache[path])
    }
  }

  // --- WebSocket 연결 (자동 재연결) ---
  let ws
  let reconnectTimer
  let connectAttempt = 0
  let stopped = false

  const connect = () => {
    if (stopped) return
    ws = new WebSocket(wsUrl, headers ? { headers } : undefined)

    ws.on('open', () => {
      connectAttempt = 0
      ws.send(JSON.stringify({ type: 'join', session_id: sessionId }))
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'init') applySnapshot(msg.state)
        else if (msg.type === 'state') applyPatch(msg.path, msg.value)
      } catch (_) {}
    })

    ws.on('close', () => {
      if (stopped) return
      const delay = Math.min(500 * Math.pow(2, connectAttempt++), 15_000)
      reconnectTimer = setTimeout(connect, delay)
    })

    ws.on('error', () => {})  // close 이벤트에서 재연결 처리
  }

  connect()

  const disconnect = () => {
    stopped = true
    clearTimeout(reconnectTimer)
    ws?.close()
  }

  return { get, set, hooks, disconnect }
}

export { createRemoteState }
