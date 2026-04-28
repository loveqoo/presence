// Cedar evaluator mock — UserContext.create 가 evaluator 필수 인자가 된 후
// LLM 통합/세션 라이프사이클 테스트가 Cedar 부팅 없이 통과하도록 제공.
//
// governance-cedar v2.11 §X5 (KG-27) — default decisionFn 이 정책 의미론 모사:
//   create_agent (10-quota / 11-admin-limit):
//     !isAdmin && currentCount >= maxAgents → deny matchedPolicies=['10-quota']
//     isAdmin  && currentCount >= hardLimit → deny matchedPolicies=['11-admin-limit']
//   access_agent (20-archived):
//     archived && intent != "continue-session" → deny matchedPolicies=['20-archived']
//   archive_agent (30-protect-admin):
//     reservedOwner === true → deny matchedPolicies=['30-protect-admin']
//   set_persona (31-protect-persona):
//     reservedOwner && !isAdmin → deny matchedPolicies=['31-protect-persona']
//   그 외 → allow.
//
// matchedPolicies 는 실 정책 파일 basename 과 일치. classifyDeny 의 prefix 분류기
// 입력 검증을 위해. 실 cedar-wasm 의미론 (matchedPolicies 형식 안정성) 은 mock 으로
// 검증하지 않음 — packages/infra/test/cedar-{boot,evaluator}.test.js 의 실 자산
// 부팅 + isAuthorized 호출이 담당 (codex M6).
//
// context 에 quota/archived 필드 부재 시 allow (LLM 통합 등 비-quota 경로 호환).
//
// 호출 별 응답을 주입할 땐 createMockEvaluator(decisionFn) 시그니처 사용.

const allowAll = () => ({ decision: 'allow', matchedPolicies: ['00-base'], errors: [] })
const denyMatch = (policyId) => ({ decision: 'deny', matchedPolicies: [policyId], errors: [] })
const numberOr = (v, fallback) => typeof v === 'number' ? v : fallback

const decideCreateAgent = (ctx) => {
  const isAdmin = ctx.isAdmin === true
  const count = numberOr(ctx.currentCount, null)
  if (count === null) return allowAll()
  if (!isAdmin) {
    const max = numberOr(ctx.maxAgents, null)
    if (max !== null && count >= max) return denyMatch('10-quota')
    return allowAll()
  }
  const hard = numberOr(ctx.hardLimit, null)
  if (hard !== null && count >= hard) return denyMatch('11-admin-limit')
  return allowAll()
}

const decideAccessAgent = (ctx) => {
  if (ctx.archived === true && ctx.intent && ctx.intent !== 'continue-session') {
    return denyMatch('20-archived')
  }
  return allowAll()
}

const decideArchiveAgent = (ctx) => {
  if (ctx.reservedOwner === true) return denyMatch('30-protect-admin')
  return allowAll()
}

const decideSetPersona = (ctx) => {
  if (ctx.reservedOwner === true && ctx.isAdmin !== true) return denyMatch('31-protect-persona')
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
