import fp from '../lib/fun-fp.js'

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

const createDryRunInterpreter = ({ stubs = {}, onOp } = {}) => {
  const plan = []
  const merged = { ...DEFAULT_STUBS, ...stubs }

  const interpret = (functor) => {
    const { tag } = functor
    const summarize = summarizers[tag]
    const entry = appendPlan(plan, {
      tag,
      ...(summarize ? { summary: summarize(functor) } : {}),
    })

    if (onOp) onOp(entry)

    const stub = merged[tag]
    if (!stub) return ST.of(functor.next(undefined))

    try {
      return ST.of(functor.next(stub(functor)))
    } catch (err) {
      return ST.lift(Task.rejected(err))
    }
  }

  return { interpret, ST, plan }
}

export { createDryRunInterpreter, DEFAULT_STUBS }
