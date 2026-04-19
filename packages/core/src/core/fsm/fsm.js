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

// --- stepProduct ---
//
// R1 aggregation 규칙 (Phase 3 확정):
//   1. keys.length === 0   → Right({ state: {}, events: [] })  (vacuous identity)
//   2. hasExplicit         → Left  (명시적 거부가 수락을 이긴다. primary = 첫 explicit)
//   3. accepted ≥ 1        → Right (state merge, events key-order, perFsm)
//   4. 전원 no-match       → Left (primary = 'unhandled')
//
// 근거: "명시적 거부는 항상 존중" 이 안전한 기본값. FSM 정의자가 "무관심" 하려면
// 해당 transition 을 빼서 no-match 로 두면 된다. reject 는 적극적 거부 의미.

function stepProduct(fsm, state, command) {
  const { keys, children } = fsm

  if (keys.length === 0) {
    return Either.Right({ state: {}, events: [] })
  }

  const results = keys.map(k => step(children[k], state[k], command))

  // 모든 Left 의 reasons 를 모아 둔다. explicit 존재 여부가 분기 기준.
  const reasonsAll = []
  for (const r of results) {
    if (r.isLeft()) {
      for (const reason of r.value.reasons) reasonsAll.push(reason)
    }
  }
  const firstExplicit = reasonsAll.find(r => r.kind === 'explicit')

  // explicit 이 하나라도 있으면 전체 거부 (수락이 있어도)
  if (firstExplicit) {
    return Either.Left({
      command,
      state,
      reasons: reasonsAll,
      primaryReason: firstExplicit.reason,
    })
  }

  // explicit 없음 + 수락 ≥ 1 → 전체 수락 (state slot isolation)
  const acceptedCount = results.reduce((n, r) => n + (r.isRight() ? 1 : 0), 0)
  if (acceptedCount >= 1) {
    const nextState = {}
    const events = []
    const perFsm = {}
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]
      const r = results[i]
      perFsm[k] = r
      if (r.isRight()) {
        nextState[k] = r.value.state
        for (const ev of r.value.events) events.push(ev)
      } else {
        nextState[k] = state[k]
      }
    }
    return Either.Right({ state: nextState, events, perFsm })
  }

  // 전원 no-match (explicit 도 없고 수락도 없음)
  return Either.Left({
    command,
    state,
    reasons: reasonsAll,
    primaryReason: 'unhandled',
  })
}

// --- step 단일 진입점 ---

function step(fsm, state, command) {
  if (fsm.kind === 'product') return stepProduct(fsm, state, command)
  return stepAtomic(fsm, state, command)
}

export { Transition, makeFSM, step, stepAtomic, stepProduct }
