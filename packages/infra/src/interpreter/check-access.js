import fp from '@presence/core/lib/fun-fp.js'
import { Interpreter } from '@presence/core/interpreter/compose.js'
import { runCheckAccess } from '../infra/authz/cedar/op-runner.js'

const { Reader } = fp

// =============================================================================
// CheckAccess Interpreter — KG-23
//
// `Op.CheckAccess({ principal, action, resource, context })` → Cedar evaluator
// 에 위임 후 `op.next(decision)` 으로 다음 Free step.
//
// 같은 op-runner 를 서비스 레이어 (`agent-governance.js`) 가 직접 호출 —
// 호출 경로 통일 (LLM 시나리오 진입 시 인터프리터를 통해 들어와도 동일 결과).
//
// evaluator 미주입 시 (예: cedar 부팅 안 된 경로): deny + 'evaluator-unavailable' 에러.
// =============================================================================

const checkAccessInterpreterR = Reader.asks(({ ST, evaluator }) =>
  new Interpreter(['CheckAccess'], (op) => {
    if (typeof evaluator !== 'function') {
      const denied = { decision: 'deny', matchedPolicies: [], errors: ['evaluator-unavailable'] }
      return ST.of(op.next(denied))
    }
    return ST.of(op.next(runCheckAccess(evaluator, op)))
  })
)

export { checkAccessInterpreterR }
