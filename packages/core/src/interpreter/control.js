import { Interpreter } from './compose.js'

// 순수 제어 Op. 외부 I/O 없음.
const createControlInterpreter = (ST) =>
  new Interpreter(['Respond', 'Observe', 'Spawn'], (f) => {
    switch (f.tag) {
      case 'Respond': return ST.of(f.next(f.message))
      case 'Observe': return ST.of(f.next({ source: f.source, data: f.data }))
      case 'Spawn':   return ST.of(f.next(undefined))
      default:        return ST.of(f.next(undefined))
    }
  })

export { createControlInterpreter }
