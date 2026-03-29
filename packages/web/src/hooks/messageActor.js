/**
 * MessageActor — Actor 패턴 기반 메시지 상태 머신.
 *
 * 프로젝트 전반의 Actor({ init, handle }) 패턴과 동일.
 * send(msg)로 이벤트를 받고, 내부 큐에서 직렬 처리하며,
 * handle(state, msg) => [result, nextState]로 상태를 전이한다.
 * UI는 subscribe()로 상태 변경을 구독한다.
 *
 * 메시지 타입:
 *   { type: 'hydrate', history }       — init 수신 시 전체 history 반영
 *   { type: 'historyPush', history }   — WS context.conversationHistory push
 *   { type: 'sendPending', input }     — 사용자 입력 → optimistic user 메시지
 *   { type: 'system', content }        — /status, /tools 등 system 메시지
 *   { type: 'error', content }         — 네트워크 오류 등 local error
 *   { type: 'clear' }                  — /clear 명시적 대화 초기화
 *   { type: 'sessionReset' }           — 세션 전환 시 로컬 상태 초기화
 *
 * pending reconcile:
 *   historyPush에서 새로 append된 tail의 각 entry에 대해
 *   가장 오래된(FIFO) pending을 content 검증 후 제거.
 *   빈 history = 원격/로컬 clear → pending 전부 제거.
 *   compaction(비어있지 않고 축소)은 pending을 건드리지 않는다.
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

const INITIAL_STATE = {
  historyMessages: [],
  pendingMessages: [],
  localMessages: [],
  historyLen: 0,
  nextId: 1,
}

const handle = (state, msg) => {
  switch (msg.type) {

    case 'hydrate': {
      const history = msg.history || []
      const next = {
        ...INITIAL_STATE,
        historyMessages: historyToMessages(history),
        historyLen: history.length,
        nextId: state.nextId,
      }
      return [null, next]
    }

    case 'historyPush': {
      const history = msg.history || []
      const prevLen = state.historyLen
      const historyMessages = historyToMessages(history)

      // 빈 history = 원격/로컬 clear → pending + local 전부 제거
      if (history.length === 0) {
        return [null, { ...state, historyMessages, historyLen: 0, pendingMessages: [], localMessages: [] }]
      }

      // compaction 또는 변화 없음 → pending 유지
      if (history.length <= prevLen) {
        return [null, { ...state, historyMessages, historyLen: history.length }]
      }

      // 정상 append → tail의 각 entry에 대해 가장 오래된 pending을 FIFO 제거
      const newTail = history.slice(prevLen)
      const pending = [...state.pendingMessages]
      for (const entry of newTail) {
        const idx = pending.findIndex(p => p.content === entry.input)
        if (idx !== -1) pending.splice(idx, 1)
      }

      return [null, { ...state, historyMessages, historyLen: history.length, pendingMessages: pending }]
    }

    case 'sendPending': {
      const pending = { role: 'user', content: msg.input, clientId: state.nextId }
      return [null, {
        ...state,
        pendingMessages: [...state.pendingMessages, pending],
        nextId: state.nextId + 1,
      }]
    }

    case 'system':
      return [null, {
        ...state,
        localMessages: [...state.localMessages, { role: 'system', content: msg.content }],
      }]

    case 'error':
      return [null, {
        ...state,
        localMessages: [...state.localMessages, { role: 'error', content: msg.content }],
      }]

    case 'clear':
      return [null, {
        ...state,
        historyMessages: [],
        pendingMessages: [],
        localMessages: [],
        historyLen: 0,
      }]

    case 'sessionReset':
      return [null, { ...INITIAL_STATE, nextId: state.nextId }]

    default:
      return [null, state]
  }
}

export { handle, INITIAL_STATE, historyToMessages }
