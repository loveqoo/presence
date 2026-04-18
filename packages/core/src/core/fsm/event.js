// =============================================================================
// Event — FSM 이 emit 하는 관찰 단위
//
// 설계: docs/design/fsm.md §D8
// - topic 필수 (문자열, 비어있지 않음. dot-notation 권장)
// - payload / source optional
// - ts 는 envelope / Runtime 레이어 책임 (step 과 무관, D6)
// =============================================================================

function makeEvent(spec) {
  const { topic, payload, source } = spec
  if (typeof topic !== 'string' || topic.length === 0) {
    throw new Error('makeEvent: `topic` must be a non-empty string')
  }
  const ev = { topic }
  if (payload !== undefined) ev.payload = payload
  if (source !== undefined) ev.source = source
  return ev
}

export { makeEvent }
