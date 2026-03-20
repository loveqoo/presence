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

const createDryRunInterpreter = ({ stubs = {}, onOp } = {}) => {
  const plan = []
  const merged = { ...DEFAULT_STUBS, ...stubs }

  const interpreter = (functor) => {
    const { tag } = functor
    const entry = { tag }

    // 각 op별 요약 정보 추출
    if (tag === 'AskLLM') entry.summary = `messages: ${functor.messages?.length || 0}개`
    if (tag === 'ExecuteTool') entry.summary = `tool: ${functor.name}`
    if (tag === 'Respond') entry.summary = `message: ${String(functor.message).slice(0, 50)}`
    if (tag === 'Approve') entry.summary = `description: ${functor.description}`
    if (tag === 'Delegate') entry.summary = `target: ${functor.target}`
    if (tag === 'UpdateState') entry.summary = `${functor.path} = ${JSON.stringify(functor.value)}`
    if (tag === 'GetState') entry.summary = `path: ${functor.path}`

    plan.push(entry)
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
