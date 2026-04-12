/**
 * Plan Executor — plan steps를 Free 프로그램으로 파싱·실행
 *
 * planner.js에서 분리. Planner.executePlan에서 사용.
 */
import { respond } from './op.js'
import { ops } from './op-handler.js'
import { PROMPT as PROMPT_POLICY } from './policies.js'
import fp from '../lib/fun-fp.js'

const { Free, Either } = fp

// plan → Free 프로그램: steps를 순차 실행하여 Either<error, results>
const parsePlan = (plan, normalizeStep) => {
  if (plan.type === 'direct_response') {
    return respond(plan.message).chain(result => Free.of(Either.Right(result)))
  }
  const steps = plan.steps || []
  if (steps.length === 0) return Free.of(Either.Right([]))

  return steps.reduce(
    (program, step) => program.chain(acc => {
      if (Either.isLeft(acc)) return Free.of(acc)
      const normalized = normalizeStep(step)
      const op = ops[normalized.op]
      if (!op) return Free.of(Either.Left(`unknown op: ${normalized.op}`))
      return op.run(normalized, acc.value).chain(stepResult =>
        Either.fold(
          err => Free.of(Either.Left(err)),
          val => Free.of(Either.Right([...acc.value, val])),
          stepResult,
        )
      )
    }),
    Free.of(Either.Right([])),
  )
}

// EXEC step을 DELEGATE/APPROVE로 정규화
const normalizeStep = (step) => {
  if (step.op !== 'EXEC') return step
  const args = step.args || {}
  if (args.tool === 'delegate') {
    const target = args.target || args.tool_args?.target
    const task = args.task || args.tool_args?.task
    if (target) return { op: 'DELEGATE', args: { target, task } }
  }
  if (args.tool === 'approve') {
    const description = args.description || args.tool_args?.description
    if (description) return { op: 'APPROVE', args: { description } }
  }
  return step
}

// step 결과를 budget 제한하여 텍스트로 직렬화
const summarizeResults = (results) =>
  (Array.isArray(results) ? results : [results])
    .map((result, idx) => {
      const text = typeof result === 'string' ? result : JSON.stringify(result)
      return `[Step ${idx + 1}] ${text.length > PROMPT_POLICY.RESULT_MAX_LEN ? text.slice(0, PROMPT_POLICY.RESULT_MAX_LEN) + '...(truncated)' : text}`
    }).join('\n')

export { parsePlan, normalizeStep, summarizeResults }
