import fp from '../lib/fun-fp.js'
import { getByPath, setByPathPure } from '../infra/state.js'

const { Task, StateT } = fp
const ST = StateT('task')

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

// log 축적은 관찰 전용 부수효과.
const appendLog = (log, entry) => { log.push(entry); return entry }

const createTestInterpreter = (handlers = {}) => {
  const log = []
  const merged = { ...defaultHandlers, ...handlers }

  const interpret = (functor) => {
    const { tag } = functor
    appendLog(log, { tag, data: { ...functor, next: undefined, map: undefined } })

    if (tag === 'UpdateState') {
      return ST.modify(s => setByPathPure(s, functor.path, functor.value))
        .chain(() => ST.get)
        .map(s => functor.next(s))
    }
    if (tag === 'GetState') {
      return ST.gets(s => getByPath(s, functor.path))
        .map(value => functor.next(value))
    }

    const handler = merged[tag]
    if (!handler) {
      return ST.lift(Task.rejected(new Error(`Unknown op: ${tag}`)))
    }

    try {
      const result = handler(functor)
      return ST.of(functor.next(result))
    } catch (err) {
      // ExecuteTool 예외 → 에러 결과값으로 변환 (턴 계속 진행, LLM이 re-plan)
      if (tag === 'ExecuteTool') {
        return ST.of(functor.next(`[ERROR] ${functor.name}: ${err.message}`))
      }
      return ST.lift(Task.rejected(err))
    }
  }

  return { interpret, ST, log }
}

export { createTestInterpreter, defaultHandlers }
