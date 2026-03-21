import fp from '../lib/fun-fp.js'

const { Task } = fp

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
// 도메인 상태는 UpdateState/GetState + Hook 경로로만 변경한다.
const appendPlan = (plan, entry) => { plan.push(entry); return entry }

const createDryRunInterpreter = ({ stubs = {}, onOp } = {}) => {
  const plan = []
  const merged = { ...DEFAULT_STUBS, ...stubs }

  const interpreter = (functor) => {
    const { tag } = functor
    const summarize = summarizers[tag]
    const entry = appendPlan(plan, {
      tag,
      ...(summarize ? { summary: summarize(functor) } : {}),
    })

    if (onOp) onOp(entry)

    const stub = merged[tag]
    if (!stub) return Task.of(functor.next(undefined))

    try {
      return Task.of(functor.next(stub(functor)))
    } catch (err) {
      return Task.rejected(err)
    }
  }

  return { interpreter, plan }
}

export { createDryRunInterpreter, DEFAULT_STUBS }
