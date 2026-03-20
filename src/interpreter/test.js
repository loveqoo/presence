import fp from '../lib/fun-fp.js'

const { Task } = fp

const defaultHandlers = {
  AskLLM:       (op) => `mock-llm-response`,
  ExecuteTool:  (op) => ({ tool: op.name, result: `mock-${op.name}-result` }),
  Respond:      (op) => op.message,
  Approve:      (op) => true,
  Delegate:     (op) => ({ delegated: op.target, result: 'mock-delegate-result' }),
  Observe:      (op) => ({ observed: op.source }),
  Parallel:     (op) => op.programs.map(() => 'mock-parallel-result'),
  Spawn:        (op) => undefined,
}

const createTestInterpreter = (handlers = {}, state = null) => {
  const log = []
  const merged = { ...defaultHandlers, ...handlers }

  const interpreter = (functor) => {
    const { tag } = functor
    log.push({ tag, data: { ...functor, next: undefined, map: undefined } })

    // UpdateState and GetState use the provided state object
    if (tag === 'UpdateState' && state) {
      state.set(functor.path, functor.value)
      return Task.of(functor.next(state.snapshot()))
    }
    if (tag === 'GetState' && state) {
      return Task.of(functor.next(state.get(functor.path)))
    }

    const handler = merged[tag]
    if (!handler) {
      return Task.rejected(new Error(`Unknown op: ${tag}`))
    }

    try {
      const result = handler(functor)
      return Task.of(functor.next(result))
    } catch (err) {
      return Task.rejected(err)
    }
  }

  return { interpreter, log }
}

export { createTestInterpreter, defaultHandlers }
