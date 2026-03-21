import fp from '../lib/fun-fp.js'

const { Task } = fp

// trace 축적은 관찰 전용 부수효과.
// 도메인 상태는 UpdateState/GetState + Hook 경로로만 변경한다.
// trace shape 변경은 이 헬퍼를 통해서만 수행.
const appendTrace = (trace, entry) => { trace.push(entry); return entry }

const createTracedInterpreter = (inner, { logger, onOp } = {}) => {
  const trace = []

  return {
    interpreter: (functor) => {
      const { tag } = functor
      const entry = appendTrace(trace, { tag, timestamp: Date.now() })

      if (logger) logger.debug(`[op:start] ${tag}`, { tag })
      if (onOp) onOp('start', entry)

      const task = inner(functor)

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
