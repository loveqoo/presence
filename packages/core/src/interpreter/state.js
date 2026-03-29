import { getByPath, setByPathPure } from '../lib/path.js'
import { Interpreter } from './compose.js'

// --- StateInterpreter ---
// UpdateState, GetState 처리. prod/test 공용.
// dryrun은 실제 상태를 쓰지 않으므로 별도.

/**
 * Create an interpreter for the `UpdateState` and `GetState` ops.
 * Shared between prod and test interpreters; dry-run uses its own stub instead.
 * @param {object} ST - StateT instance.
 * @returns {Interpreter}
 */

const createStateInterpreter = (ST) =>
  new Interpreter(['UpdateState', 'GetState'], (f) => {
    if (f.tag === 'UpdateState') {
      return ST.modify(s => setByPathPure(s, f.path, f.value))
        .chain(() => ST.get)
        .map(s => f.next(s))
    }
    // GetState
    return ST.gets(s => getByPath(s, f.path))
      .map(value => f.next(value))
  })

export { createStateInterpreter }
