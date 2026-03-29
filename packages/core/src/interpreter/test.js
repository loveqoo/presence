import fp from '../lib/fun-fp.js'
import { createStateInterpreter } from './state.js'
import { Interpreter } from './compose.js'

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

/**
 * Convert a mock handler function to an Interpreter instance for the given tag.
 * ExecuteTool errors are returned as string values so the turn continues.
 * @param {string} tag - Op tag string.
 * @param {Function} handler - `(functor) => result` mock handler.
 * @returns {Interpreter}
 */
// 핸들러 함수를 Interpreter 인스턴스로 변환.
// ExecuteTool 예외는 에러 결과값으로 변환 (턴 계속 진행).
const handlerToInterpreter = (tag, handler) =>
  new Interpreter([tag], (f) => {
    try {
      const result = handler(f)
      return ST.of(f.next(result))
    } catch (err) {
      if (tag === 'ExecuteTool') {
        return ST.of(f.next(`[ERROR] ${f.name}: ${err.message}`))
      }
      return ST.lift(Task.rejected(err))
    }
  })

/**
 * Create a mock interpreter suitable for unit tests.
 * All ops use configurable in-memory handlers; every op call is logged.
 * @param {Record<string, Function>} [handlers] - Override map of `tag => (functor) => result`.
 * @returns {{ interpret: Function, ST: object, log: object[] }}
 */
const createTestInterpreter = (handlers = {}) => {
  const log = []
  const merged = { ...defaultHandlers, ...handlers }

  // State 인터프리터 공유 + mock 핸들러를 Interpreter로 변환
  const stateI = createStateInterpreter(ST)
  const mockInterpreters = Object.entries(merged)
    .filter(([tag]) => !stateI.handles.has(tag))
    .map(([tag, handler]) => handlerToInterpreter(tag, handler))

  const composed = Interpreter.compose(ST, stateI, ...mockInterpreters)

  // 로깅은 합성된 interpret 위에 래핑 (모든 Op 대상)
  const interpret = (functor) => {
    appendLog(log, { tag: functor.tag, data: { ...functor, next: undefined, map: undefined } })
    return composed(functor)
  }

  return { interpret, ST, log }
}

export { createTestInterpreter, defaultHandlers }
