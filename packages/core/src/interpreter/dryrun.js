import fp from '../lib/fun-fp.js'
import { Interpreter } from './compose.js'

const { Task, StateT } = fp
const ST = StateT('task')

const DEFAULT_STUBS = {
  AskLLM:       () => '(dry-run: LLM response)',
  ExecuteTool:  (op) => `(dry-run: ${op.name} result)`,
  Respond:      (op) => op.message,
  Approve:      () => true,
  Delegate:     (op) => `(dry-run: delegated to ${op.target})`,
  Observe:      (op) => ({ source: op.source }),
  UpdateState:  () => undefined,
  GetState:     () => undefined,
  Parallel:     (op) => (op.programs || []).map(() => '(dry-run)'),
  Spawn:        () => undefined,
}

// op별 요약 정보 추출 (dispatch object)
const summarizers = {
  AskLLM:      (f) => `messages: ${f.messages?.length || 0}`,
  ExecuteTool: (f) => `tool: ${f.name}`,
  Respond:     (f) => `message: ${String(f.message).slice(0, 50)}`,
  Approve:     (f) => `description: ${f.description}`,
  Delegate:    (f) => `target: ${f.target}`,
  UpdateState: (f) => `${f.path} = ${JSON.stringify(f.value)}`,
  GetState:    (f) => `path: ${f.path}`,
}

// plan 축적은 관찰 전용 부수효과.
const appendPlan = (plan, entry) => { plan.push(entry); return entry }

/**
 * Convert a stub function to an Interpreter instance for the given tag.
 * @param {string} tag - Op tag string.
 * @param {Function} stub - `(functor) => result` stub function.
 * @returns {Interpreter}
 */
// stub 핸들러를 Interpreter 인스턴스로 변환
const stubToInterpreter = (tag, stub) =>
  new Interpreter([tag], (f) => {
    try {
      return ST.of(f.next(stub(f)))
    } catch (err) {
      return ST.lift(Task.rejected(err))
    }
  })

/**
 * Create a dry-run interpreter that stubs all ops without executing real effects.
 * Accumulates an execution plan log and optionally calls `onOp` for each op.
 * @param {{ stubs?: Record<string, Function>, onOp?: (entry: object) => void }} [opts]
 * @returns {{ interpret: Function, ST: object, plan: object[] }}
 */
const createDryRunInterpreter = ({ stubs = {}, onOp } = {}) => {
  const plan = []
  const merged = { ...DEFAULT_STUBS, ...stubs }

  const stubInterpreters = Object.entries(merged)
    .map(([tag, stub]) => stubToInterpreter(tag, stub))

  const composed = Interpreter.compose(ST, ...stubInterpreters)

  // 요약 로깅은 합성된 interpret 위에 래핑
  const interpret = (functor) => {
    const { tag } = functor
    const summarize = summarizers[tag]
    const entry = appendPlan(plan, {
      tag,
      ...(summarize ? { summary: summarize(functor) } : {}),
    })
    if (onOp) onOp(entry)
    return composed(functor)
  }

  return { interpret, ST, plan }
}

export { createDryRunInterpreter, DEFAULT_STUBS }
