// =============================================================================
// FSM — Transition Algebra core
//
// - Transition: 상태 전이 규칙 (from/on/guard?/to?/emit?/reject?)
// - FSM: atomic | product (동일 자료구조, kind 필드로 구분)
// - step: 단일 진입점. fsm.kind 에 따라 stepAtomic / stepProduct dispatch
//
// 설계: docs/design/fsm.md
// =============================================================================

import fp from '../../lib/fun-fp.js'

const { Either } = fp

// --- Transition 생성자 ---

// 불변식:
//   reject 는 accept 경로 (to / emit) 와 상호 배타
//   reject + to / reject + emit 은 throw
//   to only / emit only / to+emit / 둘 다 없음 (identity) 은 허용
function Transition(spec) {
  const { from, on, guard, to, emit, reject } = spec
  if (from === undefined) throw new Error('Transition: `from` is required')
  if (on === undefined) throw new Error('Transition: `on` is required')
  if (reject !== undefined && to !== undefined) {
    throw new Error('Transition: `reject` and `to` are mutually exclusive')
  }
  if (reject !== undefined && emit !== undefined) {
    throw new Error('Transition: `reject` and `emit` are mutually exclusive')
  }
  return { from, on, guard, to, emit, reject }
}

// --- FSM 생성자 (atomic) ---

function makeFSM(id, initial, transitions) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('makeFSM: `id` must be a non-empty string')
  }
  if (!Array.isArray(transitions)) {
    throw new Error('makeFSM: `transitions` must be an array')
  }
  return { kind: 'atomic', id, initial, transitions }
}

// --- 패턴 매칭 헬퍼 (private) ---

function matchesFrom(pattern, state) {
  return typeof pattern === 'function' ? !!pattern(state) : pattern === state
}

function matchesOn(pattern, command) {
  if (typeof pattern === 'function') return !!pattern(command)
  return pattern === command.type
}

function evaluate(spec, state, command) {
  return typeof spec === 'function' ? spec(state, command) : spec
}

// --- stepAtomic ---

function stepAtomic(fsm, state, command) {
  const guardFailures = []

  for (let i = 0; i < fsm.transitions.length; i++) {
    const t = fsm.transitions[i]
    if (!matchesFrom(t.from, state)) continue
    if (!matchesOn(t.on, command)) continue

    if (t.guard && !t.guard(state, command)) {
      guardFailures.push({
        kind: 'guard-failed',
        fsm: fsm.id,
        transitionIndex: i,
        reason: 'guard failed',
      })
      continue
    }

    // 승리 transition
    if (t.reject !== undefined) {
      const reason = evaluate(t.reject, state, command)
      return Either.Left({
        command,
        state,
        reasons: [
          ...guardFailures,
          { kind: 'explicit', fsm: fsm.id, transitionIndex: i, reason },
        ],
        primaryReason: reason,
      })
    }

    // accept path (to / emit / identity)
    const nextState = t.to !== undefined ? evaluate(t.to, state, command) : state
    const events = t.emit !== undefined ? evaluate(t.emit, state, command) : []
    return Either.Right({ state: nextState, events })
  }

  // 스캔 끝까지 승리 없음
  if (guardFailures.length > 0) {
    return Either.Left({
      command,
      state,
      reasons: guardFailures,
      primaryReason: 'unhandled',
    })
  }
  return Either.Left({
    command,
    state,
    reasons: [{ kind: 'no-match', fsm: fsm.id, reason: 'no matching transition' }],
    primaryReason: 'unhandled',
  })
}

// --- stepProduct — product.js 구현 후 여기에 추가 (Step 3) ---

function stepProduct(_fsm, _state, _command) {
  throw new Error('stepProduct: not implemented yet (Step 3)')
}

// --- step 단일 진입점 ---

function step(fsm, state, command) {
  if (fsm.kind === 'product') return stepProduct(fsm, state, command)
  return stepAtomic(fsm, state, command)
}

export { Transition, makeFSM, step, stepAtomic, stepProduct }
