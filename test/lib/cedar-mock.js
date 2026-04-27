// Cedar evaluator mock — UserContext.create 가 evaluator 필수 인자가 된 후
// LLM 통합/세션 라이프사이클 테스트가 Cedar 부팅 없이 통과하도록 제공.
//
// governance-cedar v2.3 §X 부터 default 가 10-quota.cedar 의 의미론을 모사:
//   context.currentCount >= context.maxAgents → deny (quota 초과)
//   그 외 → allow
// context 가 없거나 quota 필드가 없는 호출은 allow (LLM 통합 등 비-quota 경로 호환).
//
// 호출 별 응답을 주입할 땐 createMockEvaluator(decisionFn) 시그니처 사용 — deny / errors mock 자유 설정.
//
// 실 Cedar 동작은 packages/infra/test/cedar-{evaluator,boot,audit}.test.js 가 검증.

const defaultDecision = (input) => {
  const ctx = input?.context
  if (ctx && typeof ctx.currentCount === 'number' && typeof ctx.maxAgents === 'number'
      && ctx.currentCount >= ctx.maxAgents) {
    return { decision: 'deny', matchedPolicies: ['mock-quota-deny'], errors: [] }
  }
  return { decision: 'allow', matchedPolicies: ['mock-allow-all'], errors: [] }
}

export const createMockEvaluator = (decisionFn = defaultDecision) => (input) => decisionFn(input)
