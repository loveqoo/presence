import fp from '@presence/core/lib/fun-fp.js'
import { STATE_PATH } from '@presence/core/core/policies.js'

const { Reader } = fp

// =============================================================================
// State → WebSocket Bridge (세션 인식)
// 세션의 state.hooks 변경을 연결된 모든 클라이언트에 push.
// session_id 포함으로 클라이언트가 멀티 세션 구분 가능.
// =============================================================================

const WATCHED_PATHS = [
  STATE_PATH.TURN_STATE, STATE_PATH.LAST_TURN, STATE_PATH.TURN,
  STATE_PATH.CONTEXT_MEMORIES, STATE_PATH.CONTEXT_CONVERSATION_HISTORY,
  STATE_PATH.STREAMING, '_retry', STATE_PATH.APPROVE,
  STATE_PATH.DEBUG_LAST_TURN, STATE_PATH.DEBUG_OP_TRACE, STATE_PATH.DEBUG_RECALLED_MEMORIES,
  STATE_PATH.BUDGET_WARNING, STATE_PATH.TOOL_RESULTS,
  STATE_PATH.TODOS, STATE_PATH.EVENTS, 'events.*', STATE_PATH.DELEGATES, 'delegates.*',
]

/**
 * Reader that creates a WebSocket bridge for broadcasting session state changes.
 * @type {Reader<{wss: WebSocketServer}, {broadcast: Function, watchSession: Function}>}
 */
const sessionBridgeR = Reader.asks(env => {
  const { wss } = env
  const broadcast = (data) => {
    const msg = JSON.stringify(data)
    for (const ws of wss.clients) {
      if (ws.readyState === 1) ws.send(msg)
    }
  }

  const watchSession = (sessionId, state) => {
    for (const path of WATCHED_PATHS) {
      const broadcastPath = path.replace('.*', '')
      state.hooks.on(path, () => {
        broadcast({ type: 'state', session_id: sessionId, path: broadcastPath, value: state.get(broadcastPath) })
      })
    }
  }

  return { broadcast, watchSession }
})

export { sessionBridgeR, WATCHED_PATHS }
