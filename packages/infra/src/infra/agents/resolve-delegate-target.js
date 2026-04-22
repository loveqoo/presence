import fp from '@presence/core/lib/fun-fp.js'
import { validateAgentId, isReservedUsername } from '@presence/core/core/agent-id.js'

const { Either } = fp

// =============================================================================
// Delegate target resolver — docs/design/agent-identity-model.md §3.6
//
// Op.Delegate({ target, task }) 의 target 을 qualified agentId 로 해석.
//
// 규칙:
//   "summarizer"           (slash 없음)       → `{currentUserId}/summarizer`
//   "anthony/summarizer"   (slash 있음)       → 그대로 사용 (절대 agentId)
//   "admin/manager"        (reserved prefix)  → 그대로 (항상 절대)
//   "user1/agent/extra"    (slash 2 개+)      → validation 에러
//   "" 또는 non-string                         → validation 에러
//
// 계층 분리: Parser → Resolver (이 파일) → Authz. 중간 단계 우회 금지.
// =============================================================================

const resolveDelegateTarget = (target, { currentUserId } = {}) => {
  if (typeof target !== 'string' || target.length === 0) {
    return Either.Left('target must be non-empty string')
  }

  const slashCount = (target.match(/\//g) || []).length
  if (slashCount > 1) {
    return Either.Left(`target "${target}" — too many slashes (expected {username}/{agentName})`)
  }

  if (slashCount === 1) {
    // 절대 agentId — 검증만
    return validateAgentId(target)
  }

  // slash 없음 → current user qualify
  // Reserved username ("admin") 은 slash 가 반드시 있어야 함 — slash 없으면 currentUser 로 qualify.
  if (!currentUserId) {
    return Either.Left(`target "${target}" needs currentUserId to qualify`)
  }
  if (isReservedUsername(target)) {
    // "admin" 자체를 target 으로? — 현실적으로 agent name 이므로 currentUser qualify 만 의미 있음.
    // 하지만 혼란 방지 차원에서 reserved name 을 agent name 으로 쓰는 것은 reject.
    return Either.Left(`target "${target}" matches reserved username — use qualified form`)
  }
  return validateAgentId(`${currentUserId}/${target}`)
}

export { resolveDelegateTarget }
