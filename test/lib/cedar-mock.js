// Cedar evaluator mock — UserContext.create 가 evaluator 필수 인자가 된 후
// LLM 통합/세션 라이프사이클 테스트가 Cedar 부팅 없이 통과하도록 제공.
//
// governance-cedar v2.4 §X — default decisionFn 이 10-quota.cedar + 11-admin-limit.cedar 의미론 모사:
//   !isAdmin && currentCount >= maxAgents → deny (quota-exceeded)
//   isAdmin  && currentCount >= hardLimit → deny (admin hard-limit)
//   그 외 → allow
// context 가 없거나 quota 필드가 없는 호출은 allow (LLM 통합 등 비-quota 경로 호환).
//
// 호출 별 응답을 주입할 땐 createMockEvaluator(decisionFn) 시그니처 사용.
//
// 실 Cedar 동작은 packages/infra/test/cedar-{evaluator,boot,audit}.test.js 가 검증.

const numberOr = (v, fallback) => typeof v === 'number' ? v : fallback

const defaultDecision = (input) => {
  const ctx = input?.context
  if (!ctx) return { decision: 'allow', matchedPolicies: ['mock-allow-all'], errors: [] }
  const isAdmin = ctx.isAdmin === true
  const count = numberOr(ctx.currentCount, null)
  if (count === null) return { decision: 'allow', matchedPolicies: ['mock-allow-all'], errors: [] }
  if (!isAdmin) {
    const max = numberOr(ctx.maxAgents, null)
    if (max !== null && count >= max) {
      return { decision: 'deny', matchedPolicies: ['mock-quota-deny'], errors: [] }
    }
  } else {
    const hard = numberOr(ctx.hardLimit, null)
    if (hard !== null && count >= hard) {
      return { decision: 'deny', matchedPolicies: ['mock-admin-hard-deny'], errors: [] }
    }
  }
  return { decision: 'allow', matchedPolicies: ['mock-allow-all'], errors: [] }
}

export const createMockEvaluator = (decisionFn = defaultDecision) => (input) => decisionFn(input)
