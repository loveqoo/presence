// Cedar evaluator mock — UserContext.create 가 evaluator 필수 인자가 된 후
// LLM 통합/세션 라이프사이클 테스트가 Cedar 부팅 없이 통과하도록 제공.
// 모든 호출에 allow 반환 (의미론은 호출처 코드 분기에서 결정).
//
// 실 Cedar 동작은 packages/infra/test/cedar-{evaluator,boot,audit}.test.js 가 검증.

export const createMockEvaluator = () => () => ({
  decision: 'allow',
  matchedPolicies: ['mock-allow-all'],
  errors: [],
})
