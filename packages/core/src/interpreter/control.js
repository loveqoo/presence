import { Interpreter } from './compose.js'

// --- ControlInterpreter ---
// Respond, Observe, Spawn — 순수 제어 Op. 외부 I/O 없음.

/**
 * Create an interpreter for the `Respond`, `Observe`, and `Spawn` ops.
 * Pure control ops — no async I/O; all branches return `ST.of(...)`.
 * @param {object} ST - StateT instance.
 * @returns {Interpreter}
 */

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
