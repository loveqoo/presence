// =============================================================================
// Laws — FSM 법칙 검증 유틸 (테스트 전용)
//
// 설계: docs/design/fsm.md §5
//
// normalize* 는 law 비교에서 무시해야 하는 메타 (perFsm, fsm id, transitionIndex,
// command, outer state) 를 제거한다. Law 검증자는 normalize 를 통과한 형태로 비교.
// =============================================================================

import { step } from './fsm.js'
import { product } from './product.js'

const identity = (x) => x

// --- normalize ---

const normalizeRight = (right, stateUnwrap = identity) => ({
  state: stateUnwrap(right.state),
  events: right.events,
})

const normalizeLeft = (left) => ({
  primaryReason: left.primaryReason,
  reasons: left.reasons.map((r) => ({ kind: r.kind, reason: r.reason })),
})

const eqNormalized = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Either 두 개를 normalize 해서 비교. unwrap 은 Right state 에만 적용.
const eqStepResult = (rA, rB, unwrapA = identity, unwrapB = identity) => {
  if (rA.isRight() !== rB.isRight()) return false
  if (rA.isRight()) {
    return eqNormalized(
      normalizeRight(rA.value, unwrapA),
      normalizeRight(rB.value, unwrapB)
    )
  }
  return eqNormalized(normalizeLeft(rA.value), normalizeLeft(rB.value))
}

// --- Laws ---

// Determinism: step 은 pure
const checkDeterminism = (fsm, state, command) => {
  const r1 = step(fsm, state, command)
  const r2 = step(fsm, state, command)
  return eqStepResult(r1, r2)
}

// Rejection stability: Left → 입력 state 불변 (부분 전이 없음)
const checkRejectionStability = (fsm, state, command) => {
  const r = step(fsm, state, command)
  if (r.isRight()) return true
  return JSON.stringify(r.value.state) === JSON.stringify(state)
}

// INV-FSM-ORDER: transitions 순서가 의미에 영향
// fsm 과 reversed fsm 의 결과가 다르면 순서가 의미있게 작용하는 것 (긍정 증명).
const checkOrderingMatters = (fsm, reversedFsm, state, command) => {
  const rOrig = step(fsm, state, command)
  const rRev = step(reversedFsm, state, command)
  return !eqStepResult(rOrig, rRev)
}

// Empty product identity (D12)
const checkEmptyProductIdentity = (command) => {
  const p = product({})
  const r = step(p, {}, command)
  return (
    r.isRight() &&
    JSON.stringify(r.value.state) === '{}' &&
    r.value.events.length === 0
  )
}

// Singleton projection: atomic ≡ product({ inner: atomic })
// 비교 시 product 쪽은 state.inner 로 unwrap.
const checkSingletonProjection = (fsm, state, command) => {
  const p = product({ inner: fsm })
  const pState = { inner: state }
  const rA = step(fsm, state, command)
  const rP = step(p, pState, command)
  return eqStepResult(rA, rP, identity, (s) => s.inner)
}

// Product associativity (F-renaming)
// nested = product({ a: A, bc: product({ b: B, c: C }) })
// flat   = product({ a: A, b: B, c: C })
// nested state 의 { a, bc: { b, c } } 를 { a, b, c } 로 rename 해서 비교.
const checkProductAssociativity = (fsmA, fsmB, fsmC, stateABC, command) => {
  const inner = product({ b: fsmB, c: fsmC })
  const nested = product({ a: fsmA, bc: inner })
  const flat = product({ a: fsmA, b: fsmB, c: fsmC })
  const nestedState = { a: stateABC.a, bc: { b: stateABC.b, c: stateABC.c } }
  const flatState = { a: stateABC.a, b: stateABC.b, c: stateABC.c }
  const rN = step(nested, nestedState, command)
  const rF = step(flat, flatState, command)
  const unwrapNested = (s) => ({ a: s.a, b: s.bc.b, c: s.bc.c })
  return eqStepResult(rN, rF, unwrapNested, identity)
}

export {
  identity,
  normalizeRight,
  normalizeLeft,
  eqNormalized,
  eqStepResult,
  checkDeterminism,
  checkRejectionStability,
  checkOrderingMatters,
  checkEmptyProductIdentity,
  checkSingletonProjection,
  checkProductAssociativity,
}
