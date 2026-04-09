import {
  askLLM, executeTool, respond, approve, delegate, getState
} from './op.js'
import fp from '../lib/fun-fp.js'

const { Free, Either, Maybe } = fp

// --- Op 정의 ---

class Op {
  safeLookup(arr, index) {
    return Maybe.fromNullable(Array.isArray(arr) ? arr[index] : undefined)
  }
  isPositiveInt(v) { return Number.isInteger(v) && v >= 1 }
  isPositiveIntArray(v) { return Array.isArray(v) && v.every(n => this.isPositiveInt(n)) }

  validate(args) { return Either.Right(true) }
  validateRef(args, results) { return Either.Right(true) }
  execute(args, results) { return Free.of(null) }

  run(step, results) {
    return Either.fold(
      err => Free.of(Either.Left(err)),
      validStep => {
        const a = validStep.args || {}
        const refCheck = this.validateRef(a, results)
        if (Either.isLeft(refCheck)) return Free.of(refCheck)
        return this.execute(a, results).chain(value => Free.of(Either.Right(value)))
      },
      this.validate(step.args || {}).chain(() => Either.Right(step)),
    )
  }
}

class LookupMemoryOp extends Op {
  validate(a) {
    return (a.query == null || typeof a.query === 'string')
      ? Either.Right(true)
      : Either.Left('LOOKUP_MEMORY: query must be a string or omitted')
  }
  execute(a) {
    return getState('context.memories').chain(memories => {
      if (!Array.isArray(memories) || memories.length === 0) return Free.of([])
      const q = (a.query || '').toLowerCase()
      if (!q) return Free.of(memories)
      return Free.of(memories.filter(m => String(m).toLowerCase().includes(q)))
    })
  }
}

class AskLlmOp extends Op {
  resolveCtx(ctx, results) {
    if (!ctx || !Array.isArray(ctx)) return []
    return ctx
      .map(i => this.safeLookup(results, i - 1))
      .filter(m => m.isJust())
      .map(m => m.value)
  }
  validate(a) {
    if (typeof a.prompt !== 'string') return Either.Left('ASK_LLM: prompt (string) is required')
    if (a.ctx != null && !this.isPositiveIntArray(a.ctx)) {
      return Either.Left('ASK_LLM: ctx must be an array of positive integers')
    }
    return Either.Right(true)
  }
  execute(a, results) {
    const ctx = this.resolveCtx(a.ctx, results)
    return askLLM({
      messages: [{ role: 'user', content: a.prompt }],
      context: ctx.length > 0 ? ctx : undefined,
    })
  }
}

class ExecOp extends Op {
  resolveToolArgs(args, results) {
    if (!args || typeof args !== 'object') return args
    const resolveStr = (str) => {
      if (typeof str !== 'string') return str
      return str.replace(/\$(\d+)/g, (_, n) =>
        Maybe.fold(
          () => `$${n}`,
          val => typeof val === 'string' ? val : JSON.stringify(val),
          this.safeLookup(results, Number(n) - 1),
        )
      )
    }
    return Object.fromEntries(
      Object.entries(args).map(([k, v]) => [k, resolveStr(v)])
    )
  }
  validate(a) {
    return typeof a.tool === 'string'
      ? Either.Right(true)
      : Either.Left('EXEC: tool (string) is required')
  }
  execute(a, results) {
    const toolArgs = a.tool_args || (() => {
      const { tool, ...rest } = a
      return Object.keys(rest).length > 0 ? rest : {}
    })()
    return executeTool(a.tool, this.resolveToolArgs(toolArgs, results))
  }
}

class RespondOp extends Op {
  validate(a) {
    if (a.ref != null) {
      return this.isPositiveInt(a.ref)
        ? Either.Right(true)
        : Either.Left('RESPOND: ref must be a positive integer (1-based)')
    }
    return typeof a.message === 'string'
      ? Either.Right(true)
      : Either.Left('RESPOND: ref (positive integer) or message (string) is required')
  }
  validateRef(a, results) {
    if (a.ref != null && this.safeLookup(results, a.ref - 1).isNothing()) {
      return Either.Left(`RESPOND: no result at ref index ${a.ref}`)
    }
    return Either.Right(true)
  }
  execute(a, results) {
    return respond(a.ref != null
      ? Maybe.fold(() => null, v => v, this.safeLookup(results, a.ref - 1))
      : a.message)
  }
}

class ApproveOp extends Op {
  validate(a) {
    return typeof a.description === 'string'
      ? Either.Right(true)
      : Either.Left('APPROVE: description (string) is required')
  }
  execute(a) { return approve(a.description) }
}

class DelegateOp extends Op {
  validate(a) {
    return (typeof a.target === 'string' && typeof a.task === 'string')
      ? Either.Right(true)
      : Either.Left('DELEGATE: target (string) and task (string) are required')
  }
  execute(a) { return delegate(a.target, a.task) }
}

const ops = {
  LOOKUP_MEMORY: new LookupMemoryOp(),
  ASK_LLM: new AskLlmOp(),
  EXEC: new ExecOp(),
  RESPOND: new RespondOp(),
  APPROVE: new ApproveOp(),
  DELEGATE: new DelegateOp(),
}

export { ops }
