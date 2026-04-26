// KG-23 — Op.CheckAccess 인터프리터 + standalone runner 회귀 검증.
// 서비스 레이어 (agent-governance.js submitUserAgent) 와 인터프리터 양쪽이
// 같은 op-runner 를 위임하므로 회귀 시 둘 다 깨진다.

import fp from '@presence/core/lib/fun-fp.js'
import { runFreeWithStateT } from '@presence/core/lib/runner.js'
import { Interpreter } from '@presence/core/interpreter/compose.js'
import { CheckAccess, checkAccessR } from '@presence/core/core/op.js'
import { checkAccessInterpreterR } from '@presence/infra/interpreter/check-access.js'
import { runCheckAccess } from '@presence/infra/infra/authz/cedar/op-runner.js'
import { assert, summary } from '../../../test/lib/assert.js'

const { Task, StateT } = fp
const ST = StateT(Task)

const samplePrincipal = { type: 'LocalUser', id: 'alice' }
const sampleResource  = { type: 'User',      id: 'alice' }

const runCheckAccessProgram = async (env, params) => {
  const program = checkAccessR.run(params)
  const interpreter = checkAccessInterpreterR.run({ ST, ...env })
  const composed = Interpreter.compose(ST, interpreter)
  const [decision] = await runFreeWithStateT(composed, ST)(program)({})
  return decision
}

const run = async () => {
  console.log('Op.CheckAccess interpreter tests')

  // CK1 — runCheckAccess 가 evaluator 를 풀어 호출, 결과 그대로 반환
  {
    let captured = null
    const evaluator = (params) => {
      captured = params
      return { decision: 'allow', matchedPolicies: ['policy0'], errors: [] }
    }
    const op = CheckAccess({ principal: samplePrincipal, action: 'create_agent', resource: sampleResource })
    const result = runCheckAccess(evaluator, op)
    assert(captured.principal.id === 'alice', 'CK1: evaluator 가 op.principal 받음')
    assert(captured.action === 'create_agent', 'CK1: evaluator 가 op.action 받음')
    assert(captured.resource.id === 'alice', 'CK1: evaluator 가 op.resource 받음')
    assert(result.decision === 'allow', 'CK1: 결과 decision 전파')
    assert(result.matchedPolicies[0] === 'policy0', 'CK1: matchedPolicies 전파')
  }

  // CK2 — runCheckAccess: evaluator 부재 → throw
  {
    const op = CheckAccess({ principal: samplePrincipal, action: 'create_agent', resource: sampleResource })
    let threw = false
    try { runCheckAccess(null, op) } catch (_) { threw = true }
    assert(threw, 'CK2: evaluator null → throw')
  }

  // CK3 — runCheckAccess: 잘못된 op tag → throw
  {
    const wrongOp = { tag: 'AskLLM', messages: [] }
    let threw = false
    try { runCheckAccess(() => ({}), wrongOp) } catch (_) { threw = true }
    assert(threw, 'CK3: tag !== CheckAccess → throw')
  }

  // CK4 — runCheckAccess: context 부재 → {} 보정
  {
    let captured = null
    const evaluator = (params) => { captured = params; return { decision: 'allow', matchedPolicies: [], errors: [] } }
    const op = CheckAccess({ principal: samplePrincipal, action: 'create_agent', resource: sampleResource })
    runCheckAccess(evaluator, op)
    assert(typeof captured.context === 'object' && captured.context !== null, 'CK4: context 기본값 객체')
  }

  // CK5 — 인터프리터 통합: Op.CheckAccess Free → evaluator 호출 → decision 반환
  {
    const evaluator = () => ({ decision: 'allow', matchedPolicies: ['policy0'], errors: [] })
    const decision = await runCheckAccessProgram(
      { evaluator },
      { principal: samplePrincipal, action: 'create_agent', resource: sampleResource },
    )
    assert(decision.decision === 'allow', 'CK5: 인터프리터 결과 decision=allow')
    assert(decision.matchedPolicies[0] === 'policy0', 'CK5: matchedPolicies 전파')
  }

  // CK6 — 인터프리터: evaluator 미주입 → deny + 'evaluator-unavailable'
  {
    const decision = await runCheckAccessProgram(
      { evaluator: null },
      { principal: samplePrincipal, action: 'create_agent', resource: sampleResource },
    )
    assert(decision.decision === 'deny', 'CK6: evaluator 부재 → deny')
    assert(decision.errors[0] === 'evaluator-unavailable', 'CK6: 에러 코드 evaluator-unavailable')
  }

  // CK7 — 인터프리터: deny decision 도 그대로 전파 (cedar 50-custom 정책 deny 시뮬)
  {
    const evaluator = () => ({ decision: 'deny', matchedPolicies: ['50-custom'], errors: [] })
    const decision = await runCheckAccessProgram(
      { evaluator },
      { principal: samplePrincipal, action: 'create_agent', resource: sampleResource },
    )
    assert(decision.decision === 'deny', 'CK7: cedar deny 그대로 전파')
    assert(decision.matchedPolicies[0] === '50-custom', 'CK7: matched policy id 전파')
  }

  // CK8 — 서비스 레이어와 인터프리터가 같은 evaluator 받으면 결과 동일
  {
    const evaluator = (params) => ({
      decision: params.action === 'create_agent' ? 'allow' : 'deny',
      matchedPolicies: ['shared'],
      errors: [],
    })
    const op = CheckAccess({ principal: samplePrincipal, action: 'create_agent', resource: sampleResource })
    const direct = runCheckAccess(evaluator, op)
    const viaInterpreter = await runCheckAccessProgram(
      { evaluator },
      { principal: samplePrincipal, action: 'create_agent', resource: sampleResource },
    )
    assert(direct.decision === viaInterpreter.decision, 'CK8: 서비스 vs 인터프리터 decision 동일')
    assert(direct.matchedPolicies[0] === viaInterpreter.matchedPolicies[0], 'CK8: matchedPolicies 동일')
  }

  summary()
}

run()
