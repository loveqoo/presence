// Cedar wasm wrapper. evaluate 는 동기 함수.
// 호출처에서 직접 import + 호출 (Op ADT wrapping 없음 — KG-23).
//
// cedar-wasm 4.10.0: isAuthorized 는 stateless top-level 함수.
// 매 호출마다 policies + entities + schema 텍스트 전달.
// 응답: { type: 'success', response: { decision, diagnostics: { reason, errors } }, warnings }
//   또는 { type: 'failure', errors, warnings } (parse/eval 자체 실패).

import fp from '@presence/core/lib/fun-fp.js'

const { Reader } = fp

const extractMessage = (errLike) => {
  if (errLike == null) return String(errLike)
  if (typeof errLike === 'string') return errLike
  if (errLike.error && typeof errLike.error.message === 'string') return errLike.error.message
  if (typeof errLike.message === 'string') return errLike.message
  return JSON.stringify(errLike)
}

const createEvaluatorR = Reader.asks(({ cedar, schemaText, policiesMap, auditWriter }) => {
  if (!cedar || typeof cedar.isAuthorized !== 'function') {
    throw new Error('createEvaluator: cedar.isAuthorized 부재')
  }
  if (!auditWriter || typeof auditWriter.append !== 'function') {
    throw new Error('createEvaluator: auditWriter.append 부재')
  }
  if (!policiesMap || typeof policiesMap !== 'object') {
    throw new Error('createEvaluator: policiesMap 부재 또는 잘못된 타입')
  }
  return ({ principal, action, resource, context = {} }) => {
    const audit = (entry) => auditWriter.append({
      ts: new Date().toISOString(),
      caller: principal.id,
      action,
      resource: resource.id,
      ...entry,
    })
    try {
      const answer = cedar.isAuthorized({
        principal: { type: principal.type, id: principal.id },
        action:    { type: 'Action',       id: action },
        resource:  { type: resource.type,  id: resource.id },
        context,
        schema:   schemaText,
        policies: { staticPolicies: policiesMap },
        entities: [],
      })
      if (answer.type === 'success') {
        const result = {
          decision:        answer.response.decision,
          matchedPolicies: answer.response.diagnostics.reason,
          errors:          answer.response.diagnostics.errors.map(extractMessage),
        }
        audit(result)
        return result
      }
      const failResult = {
        decision:        'deny',
        matchedPolicies: [],
        errors:          (answer.errors ?? []).map(extractMessage),
      }
      audit(failResult)
      return failResult
    } catch (err) {
      const failResult = { decision: 'deny', matchedPolicies: [], errors: [extractMessage(err)] }
      audit(failResult)
      return failResult
    }
  }
})

const createEvaluator = (deps) => createEvaluatorR.run(deps)

export { createEvaluator, createEvaluatorR }
