import fp from '../lib/fun-fp.js'

const { Task } = fp

const createTracedInterpreter = (inner, { logger, onOp } = {}) => {
  const trace = []

  return {
    interpreter: (functor) => {
      const { tag } = functor
      const entry = { tag, timestamp: Date.now() }
      trace.push(entry)

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
