// =============================================================================
// Command — FSM 진입 명령
//
// 설계: docs/design/fsm.md §D8
// - type 필수 (문자열, 비어있지 않음)
// - origin / principal / payload / id optional
// - ts 는 envelope / Runtime 레이어 책임 (step 과 무관, D6)
// =============================================================================

function makeCommand(spec) {
  const { type, origin, principal, payload, id } = spec
  if (typeof type !== 'string' || type.length === 0) {
    throw new Error('makeCommand: `type` must be a non-empty string')
  }
  const cmd = { type }
  if (origin !== undefined) cmd.origin = origin
  if (principal !== undefined) cmd.principal = principal
  if (payload !== undefined) cmd.payload = payload
  if (id !== undefined) cmd.id = id
  return cmd
}

export { makeCommand }
