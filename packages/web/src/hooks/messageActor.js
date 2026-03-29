/**
 * MessageActor — 메시지 표시 상태의 단일 직렬화 지점.
 *
 * useReducer로 구동. 모든 메시지 변경은 dispatch(event)로 직렬화된다.
 * usePresence는 IO만 담당하고, 메시지 병합 규칙은 이 actor가 소유한다.
 *
 * 이벤트:
 *   hydrate(history)        — init 수신 시 전체 history 반영
 *   history_push(history)   — WS context.conversationHistory push
 *   send_pending(input)     — 사용자 입력 → optimistic user 메시지 등록
 *   system(content)         — /status, /tools 등 system 메시지
 *   error(content)          — 네트워크 오류 등 local error
 *   clear()                 — /clear 명시적 대화 초기화
 *   session_reset()         — 세션 전환 시 로컬 상태 초기화
 *
 * pending reconcile:
 *   history_push에서 새로 append된 tail의 각 entry에 대해
 *   가장 오래된(FIFO) pending을 content 검증 후 제거.
 *   /clear는 clear 이벤트가 담당 — history_push에서 pending을 전부 비우지 않는다.
 *   compaction(history 축소)은 pending을 건드리지 않는다.
 */

const historyToMessages = (history) => {
  if (!Array.isArray(history)) return []
  const msgs = []
  for (const entry of history) {
    if (entry.input) msgs.push({ role: 'user', content: entry.input })
    if (entry.output) msgs.push({ role: entry.failed ? 'error' : 'agent', content: entry.output })
  }
  return msgs
}

const initialState = {
  historyMessages: [],
  pendingMessages: [],
  localMessages: [],
  historyLen: 0,
  nextId: 1,
}

const messageReducer = (state, event) => {
  switch (event.type) {

    case 'hydrate': {
      const history = event.history || []
      return {
        ...initialState,
        historyMessages: historyToMessages(history),
        historyLen: history.length,
        nextId: state.nextId,
      }
    }

    case 'history_push': {
      const history = event.history || []
      const prevLen = state.historyLen
      const historyMessages = historyToMessages(history)

      // 빈 history = 원격/로컬 clear → pending 전부 제거
      if (history.length === 0) {
        return { ...state, historyMessages, historyLen: 0, pendingMessages: [], localMessages: [] }
      }

      // compaction 또는 변화 없음 → pending 유지
      if (history.length <= prevLen) {
        return { ...state, historyMessages, historyLen: history.length }
      }

      // 정상 append → tail의 각 entry에 대해 가장 오래된 pending을 FIFO 제거
      const newTail = history.slice(prevLen)
      const pending = [...state.pendingMessages]
      for (const entry of newTail) {
        const idx = pending.findIndex(p => p.content === entry.input)
        if (idx !== -1) pending.splice(idx, 1)
      }

      return { ...state, historyMessages, historyLen: history.length, pendingMessages: pending }
    }

    case 'send_pending': {
      const msg = { role: 'user', content: event.input, clientId: state.nextId }
      return {
        ...state,
        pendingMessages: [...state.pendingMessages, msg],
        nextId: state.nextId + 1,
      }
    }

    case 'system':
      return {
        ...state,
        localMessages: [...state.localMessages, { role: 'system', content: event.content }],
      }

    case 'error':
      return {
        ...state,
        localMessages: [...state.localMessages, { role: 'error', content: event.content }],
      }

    case 'clear':
      return {
        ...state,
        historyMessages: [],
        pendingMessages: [],
        localMessages: [],
        historyLen: 0,
      }

    case 'session_reset':
      return { ...initialState, nextId: state.nextId }

    default:
      return state
  }
}

export { messageReducer, initialState, historyToMessages }
