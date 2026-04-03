import fp from '../lib/fun-fp.js'

const { Task } = fp

// 인터프리터 프로토콜. 모든 단일 관심사 인터프리터의 기반.
class Interpreter {
  constructor(tags, interpret) {
    if (!Array.isArray(tags) || tags.length === 0) {
      throw new TypeError('Interpreter: tags must be a non-empty array')
    }
    if (typeof interpret !== 'function') {
      throw new TypeError('Interpreter: interpret must be a function')
    }
    this.handles = Object.freeze(new Set(tags))
    this.interpret = interpret
  }

  // 여러 인터프리터를 tag 기반으로 합성.
  // 중복 태그: 즉시 throw (설정 오류 fail-fast).
  // 미처리 태그: Task.rejected.
  static compose(ST, ...interpreters) {
    const dispatch = new Map()
    for (const interp of interpreters) {
      if (!(interp instanceof Interpreter)) {
        throw new TypeError('compose: argument must be an Interpreter instance')
      }
      for (const tag of interp.handles) {
        if (dispatch.has(tag)) {
          throw new Error(`compose: duplicate handler for '${tag}'`)
        }
        dispatch.set(tag, (f) => interp.interpret(f))
      }
    }

    return (functor) => {
      const handler = dispatch.get(functor.tag)
      if (handler) return handler(functor)
      return ST.lift(Task.rejected(new Error(`Unknown op: ${functor.tag}`)))
    }
  }
}

export { Interpreter }
