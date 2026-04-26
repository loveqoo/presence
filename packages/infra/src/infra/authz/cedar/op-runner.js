// KG-23 — Op.CheckAccess standalone runner.
// 서비스 레이어 (Free Monad 환경 밖) 가 Op data 를 만들고 같은 runner 로
// evaluator 를 호출. LLM 시나리오의 인터프리터도 같은 함수를 위임 — 호출 경로 통일.
//
// op data shape (core/op.js CheckAccess):
//   { tag: 'CheckAccess', principal, action, resource, context, next }
// evaluator (cedar/evaluator.js): ({ principal, action, resource, context }) =>
//   { decision, matchedPolicies, errors }

const runCheckAccess = (evaluator, op) => {
  if (typeof evaluator !== 'function') {
    throw new Error('runCheckAccess: evaluator (function) required')
  }
  if (!op || op.tag !== 'CheckAccess') {
    throw new Error(`runCheckAccess: expected Op.CheckAccess, got ${op?.tag ?? 'null'}`)
  }
  return evaluator({
    principal: op.principal,
    action:    op.action,
    resource:  op.resource,
    context:   op.context ?? {},
  })
}

export { runCheckAccess }
