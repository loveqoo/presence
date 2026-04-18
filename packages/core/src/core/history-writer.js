import { HISTORY, HISTORY_ENTRY_TYPE } from './policies.js'

// =============================================================================
// HistoryWriter — conversationHistory entry 계산 pure helpers.
// state/monad 무관. Free 경로 (planner) 와 imperative 경로 (executor/turn-controller)
// 모두 이 helper 를 경유해 id/ts/truncate/trim 규칙을 단일화.
// =============================================================================

function truncate(text, max) {
  return text.length > max ? text.slice(0, max) + '...(truncated)' : text
}

// 세션 내 단조 증가 시퀀스 생성기. TurnLifecycle 이 인스턴스당 하나 소유.
function createSeq() {
  let n = 0
  return () => ++n
}

// entry 생성. type === 'turn' 이면 input/output truncate, 'system' 이면 content/tag.
// seq 는 createSeq() 반환 함수. now 는 주입 가능 (테스트).
function makeEntry(params) {
  const { type = HISTORY_ENTRY_TYPE.TURN, input, output, content, tag, extra = {}, seq, now = Date.now() } = params
  const base = { id: `h-${now}-${seq()}`, ts: now }
  if (type === HISTORY_ENTRY_TYPE.SYSTEM) {
    return { ...base, type: HISTORY_ENTRY_TYPE.SYSTEM, content, tag }
  }
  return {
    ...base,
    input: truncate(String(input ?? ''), HISTORY.MAX_INPUT_CHARS),
    output: truncate(String(output ?? ''), HISTORY.MAX_OUTPUT_CHARS),
    ...extra,
  }
}

// 새 entry 를 append 하고 MAX 초과 시 앞에서부터 trim. 불변.
function appendAndTrim(history, entry, max = HISTORY.MAX_CONVERSATION) {
  const next = [...(history || []), entry]
  return next.length > max ? next.slice(-max) : next
}

// turn entry 판별. type 없으면 turn (하위 호환).
function isTurnEntry(entry) {
  return (entry?.type || HISTORY_ENTRY_TYPE.TURN) === HISTORY_ENTRY_TYPE.TURN
}

// 뒤에서부터 첫 번째 turn entry 를 cancelled 로 마킹. SYSTEM 은 건너뜀.
// 이미 cancelled 거나 turn 이 없으면 원본 그대로 반환.
function markLastTurnCancelled(history) {
  if (!Array.isArray(history) || history.length === 0) return history
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]
    if (!isTurnEntry(entry)) continue
    if (entry.cancelled) return history
    return [
      ...history.slice(0, i),
      { ...entry, cancelled: true },
      ...history.slice(i + 1),
    ]
  }
  return history
}

// turn entry 만 필터. prompt/compaction 에서 SYSTEM 배제 (INV-SYS-1).
function turnEntriesOnly(history) {
  return Array.isArray(history) ? history.filter(isTurnEntry) : []
}

export { truncate, createSeq, makeEntry, appendAndTrim, markLastTurnCancelled, turnEntriesOnly, isTurnEntry }
