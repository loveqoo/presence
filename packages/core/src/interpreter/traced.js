import fp from '../lib/fun-fp.js'

const { Task, Writer } = fp

// =============================================================================
// Traced Interpreter: Writer 기반 불변 trace 축적
//
// traceWriter는 내부 mutable accumulator이다.
// Writer는 append protocol과 log shape를 표준화하는 목적으로 사용한다.
// 외부에는 getTrace() / resetTrace() 함수 인터페이스만 노출.
//
// TraceEntry = { tag, detail, timestamp, duration?, error?, result? }
// =============================================================================

// Op에서 트리 표시용 detail 추출
const extractDetail = (f) => {
  switch (f.tag) {
    case 'UpdateState': return f.path
    case 'GetState':    return f.path
    case 'AskLLM':      return f.messages ? `${f.messages.length} msgs` : null
    case 'ExecuteTool':  return f.name
    case 'Respond': {
      if (typeof f.message !== 'string') return null
      const flat = f.message.replace(/\n/g, ' ').replace(/\s+/g, ' ')
      return flat.length > 30 ? flat.slice(0, 30) + '…' : flat
    }
    case 'Delegate':     return f.target
    case 'Approve':      return f.description
    default:             return null
  }
}

const createTracedInterpreter = ({ interpret: inner, ST }, { logger, onOp } = {}) => {
  // Writer mutable accumulator — 턴 시작 시 resetTrace()로 초기화
  let traceWriter = Writer.of(null)

  const getTrace = () => traceWriter.run()[1].map(e => ({ ...e }))
  const resetTrace = () => { traceWriter = Writer.of(null) }

  const interpret = (functor) => {
    const { tag } = functor
    const detail = extractDetail(functor)
    const entry = { tag, detail, timestamp: Date.now() }

    // Writer.tell로 시작 시점 entry 축적 (duration 없음, 나중에 완료 entry로 교체)
    if (logger) logger.debug(`[op:start] ${tag}`, { tag })
    if (onOp) onOp('start', entry)

    // Delegate: next를 래핑하여 DelegateResult 캡처
    const actual = tag === 'Delegate'
      ? { ...functor, next: (r) => {
          if (r?.status) entry.result = { status: r.status, output: r.output, mode: r.mode, error: r.error }
          return functor.next(r)
        }}
      : functor

    const innerST = inner(actual)

    // inner StateT의 Task를 래핑: 성공/에러 모두 트레이싱.
    // ST.get으로 현재 상태를 얻고, inner의 run(state) Task를 감싸서
    // 에러 시에도 entry에 duration/error를 기록한 뒤 re-reject 한다.
    return ST.get.chain(currentState =>
      ST.lift(new Task((reject, resolve) => {
        innerST.run(currentState).fork(
          err => {
            entry.duration = Date.now() - entry.timestamp
            entry.error = err instanceof Error ? err.message : String(err)
            traceWriter = traceWriter.chain(() => Writer.tell([{ ...entry }]))
            if (logger) logger.warn(`[op:error] ${tag} (${entry.duration}ms): ${entry.error}`, { tag, error: entry.error })
            if (onOp) onOp('error', entry)
            reject(err)
          },
          ([nextFree, newState]) => {
            entry.duration = Date.now() - entry.timestamp
            traceWriter = traceWriter.chain(() => Writer.tell([{ ...entry }]))
            if (logger) logger.debug(`[op:done] ${tag} (${entry.duration}ms)`, { tag, duration: entry.duration })
            if (onOp) onOp('done', entry)
            resolve([nextFree, newState])
          }
        )
      }))
    ).chain(([nextFree, newState]) =>
      ST.put(newState).map(() => nextFree)
    )
  }

  return { interpret, ST, getTrace, resetTrace }
}

export { createTracedInterpreter }
