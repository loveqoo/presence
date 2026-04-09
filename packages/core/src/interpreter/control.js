import fp from '../lib/fun-fp.js'
import { Interpreter } from './compose.js'

const { Reader } = fp

// 순수 제어 Op. 외부 I/O 없음.
const controlInterpreterR = Reader.asks(({ ST }) =>
  new Interpreter(['Respond', 'Observe', 'Spawn'], (f) => {
    switch (f.tag) {
      case 'Respond': return ST.of(f.next(f.message))
      case 'Observe': return ST.of(f.next({ source: f.source, data: f.data }))
      case 'Spawn':   return ST.of(f.next(undefined))
      default:        return ST.of(f.next(undefined))
    }
  }))

export { controlInterpreterR }
