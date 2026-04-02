import fp from '../lib/fun-fp.js'
import { Interpreter } from './compose.js'

const { Task, Reader } = fp

// runProgram은 최종 합성 인터프리터의 실행 함수를 주입받는다.
// UI 억제는 runProgram 내부에서 처리 (이 인터프리터는 관여하지 않음).
const parallelInterpreterR = Reader.asks(({ ST, runProgram }) =>
  new Interpreter(['Parallel'], (f) => {
    const programs = f.programs || []
    if (programs.length === 0) return ST.of(f.next([]))
    return ST.get.chain(currentState =>
      ST.lift(Task.fromPromise(async () => {
        const settled = await Promise.allSettled(
          programs.map(p => runProgram(p, currentState))
        )
        return settled.map(r =>
          r.status === 'fulfilled'
            ? { status: 'fulfilled', value: r.value }
            : { status: 'rejected', reason: r.reason?.message || String(r.reason) }
        )
      })()).map(results => f.next(results))
    )
  }))

export { parallelInterpreterR }
