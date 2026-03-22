import fp from '../lib/fun-fp.js'

const { Task } = fp

// trace 축적은 관찰 전용 부수효과.
// 도메인 상태는 UpdateState/GetState + Hook 경로로만 변경한다.
// trace shape 변경은 이 헬퍼를 통해서만 수행.
const appendTrace = (trace, entry) => { trace.push(entry); return entry }

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

const createTracedInterpreter = (inner, { logger, onOp } = {}) => {
  const trace = []

  return {
    interpreter: (functor) => {
      const { tag } = functor
      const detail = extractDetail(functor)
      const entry = appendTrace(trace, { tag, detail, timestamp: Date.now() })

      if (logger) logger.debug(`[op:start] ${tag}`, { tag })
      if (onOp) onOp('start', entry)

      // Delegate: next를 래핑하여 DelegateResult 캡처
      const actual = tag === 'Delegate'
        ? { ...functor, next: (r) => {
            if (r?.status) entry.result = { status: r.status, output: r.output, mode: r.mode, error: r.error }
            return functor.next(r)
          }}
        : functor

      const task = inner(actual)

      return new Task((reject, resolve) => {
        task.fork(
          (err) => {
            entry.error = err.message || String(err)
            entry.duration = Date.now() - entry.timestamp
            if (logger) logger.warn(`[op:error] ${tag}: ${entry.error}`, { tag, error: entry.error })
            if (onOp) onOp('error', entry)
            reject(err)
          },
          (value) => {
            entry.duration = Date.now() - entry.timestamp
            if (logger) logger.debug(`[op:done] ${tag} (${entry.duration}ms)`, { tag, duration: entry.duration })
            if (onOp) onOp('done', entry)
            resolve(value)
          }
        )
      })
    },
    trace,
  }
}

export { createTracedInterpreter }
