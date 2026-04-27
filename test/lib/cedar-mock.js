// Cedar evaluator mock — UserContext.create 가 evaluator 필수 인자가 된 후
// LLM 통합/세션 라이프사이클 테스트가 Cedar 부팅 없이 통과하도록 제공.
//
// governance-cedar v2.9 §X — default decisionFn 이 정책 의미론 모사:
//   create_agent (10-quota / 11-admin-limit):
//     !isAdmin && currentCount >= maxAgents → deny (quota-exceeded)
//     isAdmin  && currentCount >= hardLimit → deny (admin hard-limit)
//   access_agent (20-archived):
//     archived && intent != "continue-session" → deny (archived)
//   archive_agent (30-protect-admin):
//     reservedOwner === true → deny (admin agent archive 금지)
//   set_persona (31-protect-persona):
//     reservedOwner && !isAdmin → deny (admin/* persona 는 admin 만)
//   그 외 → allow.
//
// context 에 quota/archived 필드 부재 시 allow (LLM 통합 등 비-quota 경로 호환).
//
// 호출 별 응답을 주입할 땐 createMockEvaluator(decisionFn) 시그니처 사용.
//
// 실 Cedar 동작은 packages/infra/test/cedar-{evaluator,boot,audit}.test.js 가 검증.

const allowAll = () => ({ decision: 'allow', matchedPolicies: ['mock-allow-all'], errors: [] })
const numberOr = (v, fallback) => typeof v === 'number' ? v : fallback

const decideCreateAgent = (ctx) => {
  const isAdmin = ctx.isAdmin === true
  const count = numberOr(ctx.currentCount, null)
  if (count === null) return allowAll()
  if (!isAdmin) {
    const max = numberOr(ctx.maxAgents, null)
    if (max !== null && count >= max) {
      return { decision: 'deny', matchedPolicies: ['mock-quota-deny'], errors: [] }
    }
    return allowAll()
  }
  const hard = numberOr(ctx.hardLimit, null)
  if (hard !== null && count >= hard) {
    return { decision: 'deny', matchedPolicies: ['mock-admin-hard-deny'], errors: [] }
  }
  return allowAll()
}

const decideAccessAgent = (ctx) => {
  if (ctx.archived === true && ctx.intent && ctx.intent !== 'continue-session') {
    return { decision: 'deny', matchedPolicies: ['mock-archived-deny'], errors: [] }
  }
  return allowAll()
}

const decideArchiveAgent = (ctx) => {
  if (ctx.reservedOwner === true) {
    return { decision: 'deny', matchedPolicies: ['mock-protect-admin-deny'], errors: [] }
  }
  return allowAll()
}

const decideSetPersona = (ctx) => {
  if (ctx.reservedOwner === true && ctx.isAdmin !== true) {
    return { decision: 'deny', matchedPolicies: ['mock-protect-persona-deny'], errors: [] }
  }
  return allowAll()
}

const defaultDecision = (input) => {
  const ctx = input?.context
  if (!ctx) return allowAll()
  if (input?.action === 'create_agent')  return decideCreateAgent(ctx)
  if (input?.action === 'access_agent')  return decideAccessAgent(ctx)
  if (input?.action === 'archive_agent') return decideArchiveAgent(ctx)
  if (input?.action === 'set_persona')   return decideSetPersona(ctx)
  return allowAll()
}

export const createMockEvaluator = (decisionFn = defaultDecision) => (input) => decisionFn(input)
