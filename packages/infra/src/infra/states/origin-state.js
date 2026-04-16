import fp from '@presence/core/lib/fun-fp.js'
import { getByPath, setByPathPure } from '@presence/core/lib/path.js'
import { State, StateChange } from './state.js'

const { Reader } = fp

// =============================================================================
// OriginState: 서버 authoritative 상태. 실제 값 보관 + set 시 publish.
// =============================================================================

const deepClone = obj => JSON.parse(JSON.stringify(obj))

// --- StateCell: 데이터 보관 전담 (immutable reference cell) ---
class StateCell {
  constructor(initial = {}) {
    this.data = deepClone(initial)
  }
  get(path) { return path == null ? this.data : getByPath(this.data, path) }
  snapshot() { return this.data }
  apply(next) { this.data = next }
}

// --- OriginState: State의 authoritative 구현 ---
class OriginState extends State {
  constructor(initial = {}) {
    super()
    this.cell = new StateCell(initial)
  }

  get(path) { return this.cell.get(path) }
  snapshot() { return this.cell.snapshot() }

  set(path, value) {
    const prevValue = getByPath(this.cell.snapshot(), path)
    const nextRoot = setByPathPure(this.cell.snapshot(), path, value)
    this.cell.apply(nextRoot)
    this.bus.publish(StateChange(path, prevValue, value), this)
  }
}

// --- Reader factories ---
const stateCellR = Reader.asks(deps => new StateCell(deps?.initial))
const originStateR = Reader.asks(deps => new OriginState(deps?.initial))

// --- Legacy bridges (single-line delegates) ---
const createStateCell = (initial = {}) => stateCellR.run({ initial })
const createOriginState = (initial = {}) => originStateR.run({ initial })

export { OriginState, StateCell, stateCellR, originStateR, createStateCell, createOriginState }
