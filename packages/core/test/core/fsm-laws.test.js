import { Transition, makeFSM, step } from '@presence/core/core/fsm/fsm.js'
import { product } from '@presence/core/core/fsm/product.js'
import {
  checkDeterminism,
  checkRejectionStability,
  checkOrderingMatters,
  checkEmptyProductIdentity,
  checkSingletonProjection,
  checkProductAssociativity,
  normalizeRight,
  normalizeLeft,
  eqNormalized,
} from '@presence/core/core/fsm/laws.js'
import { assert, summary } from '../../../../test/lib/assert.js'

console.log('FSM laws tests')

// 장난감 FSMs
const lightFSM = makeFSM('light', 'off', [
  Transition({ from: 'off', on: 'toggle', to: 'on', emit: [{ topic: 'light.on' }] }),
  Transition({ from: 'on', on: 'toggle', to: 'off', emit: [{ topic: 'light.off' }] }),
])

const fanFSM = makeFSM('fan', 'off', [
  Transition({ from: 'off', on: 'toggle', to: 'on', emit: [{ topic: 'fan.on' }] }),
  Transition({ from: 'on', on: 'toggle', to: 'off', emit: [{ topic: 'fan.off' }] }),
])

const counterFSM = makeFSM('ctr', 0, [
  Transition({ from: (s) => s >= 0, on: 'inc', to: (s) => s + 1 }),
  Transition({ from: (s) => s > 0, on: 'dec', to: (s) => s - 1 }),
  Transition({ from: 0, on: 'dec', reject: 'cannot-go-negative' }),
])

const roomFSM = product({ light: lightFSM, fan: fanFSM })

// --- Determinism ---

// D1. atomic pure
{
  assert(checkDeterminism(lightFSM, 'off', { type: 'toggle' }),
    'D1: lightFSM determinism (accept path)')
  assert(checkDeterminism(lightFSM, 'off', { type: 'unknown' }),
    'D1: lightFSM determinism (no-match)')
  assert(checkDeterminism(counterFSM, 0, { type: 'dec' }),
    'D1: counterFSM determinism (explicit reject)')
}

// D2. product pure
{
  assert(checkDeterminism(roomFSM, { light: 'off', fan: 'off' }, { type: 'toggle' }),
    'D2: roomFSM determinism (accept)')
  assert(checkDeterminism(roomFSM, { light: 'off', fan: 'off' }, { type: 'unknown' }),
    'D2: roomFSM determinism (Left)')
}

// --- Rejection stability ---

// R1. explicit reject → state 불변
{
  assert(checkRejectionStability(counterFSM, 0, { type: 'dec' }),
    'R1: explicit reject 시 state 불변')
}

// R2. no-match → state 불변
{
  assert(checkRejectionStability(lightFSM, 'off', { type: 'unknown' }),
    'R2: no-match 시 state 불변')
}

// R3. guard-failed → state 불변
{
  const guardedFSM = makeFSM('g', 'a', [
    Transition({ from: 'a', on: 'x', guard: () => false, to: 'b' }),
  ])
  assert(checkRejectionStability(guardedFSM, 'a', { type: 'x' }),
    'R3: guard-failed 시 state 불변')
}

// R4. accept → vacuous true
{
  assert(checkRejectionStability(lightFSM, 'off', { type: 'toggle' }),
    'R4: accept 도 vacuous true')
}

// --- INV-FSM-ORDER ---

// O1. 첫 match 승리 → 순서 뒤집으면 다른 결과
{
  const orig = makeFSM('o', 'a', [
    Transition({ from: 'a', on: 'x', to: 'b' }),
    Transition({ from: 'a', on: 'x', to: 'c' }),
  ])
  const reversed = makeFSM('o', 'a', [
    Transition({ from: 'a', on: 'x', to: 'c' }),
    Transition({ from: 'a', on: 'x', to: 'b' }),
  ])
  assert(checkOrderingMatters(orig, reversed, 'a', { type: 'x' }),
    'O1: transition 순서가 결과를 결정')
}

// O2. accept vs explicit — 순서 뒤집으면 Right → Left
{
  const acceptFirst = makeFSM('o2', 'a', [
    Transition({ from: 'a', on: 'x', to: 'b' }),
    Transition({ from: 'a', on: 'x', reject: 'nope' }),
  ])
  const rejectFirst = makeFSM('o2', 'a', [
    Transition({ from: 'a', on: 'x', reject: 'nope' }),
    Transition({ from: 'a', on: 'x', to: 'b' }),
  ])
  assert(checkOrderingMatters(acceptFirst, rejectFirst, 'a', { type: 'x' }),
    'O2: accept-first vs reject-first 가 다른 결과')
}

// --- Empty product identity ---

// E1. 임의 command 에 대해 identity
{
  assert(checkEmptyProductIdentity({ type: 'anything' }),
    'E1: empty product accepts any command vacuously')
  assert(checkEmptyProductIdentity({ type: 'other' }), 'E1: 다른 command 도')
}

// --- Singleton projection (R3) ---

// S1. accept path
{
  assert(checkSingletonProjection(lightFSM, 'off', { type: 'toggle' }),
    'S1: atomic accept ≡ product({inner}) accept')
}

// S2. no-match path
{
  assert(checkSingletonProjection(lightFSM, 'off', { type: 'unknown' }),
    'S2: atomic no-match ≡ product({inner}) no-match')
}

// S3. explicit reject path
{
  assert(checkSingletonProjection(counterFSM, 0, { type: 'dec' }),
    'S3: atomic explicit reject ≡ product({inner}) explicit reject')
}

// --- Product associativity (R3 F-renaming) ---

// A1. light/fan/counter 3개 FSM — nested vs flat 동치
{
  const stateABC = { a: 'off', b: 'off', c: 0 }
  assert(
    checkProductAssociativity(lightFSM, fanFSM, counterFSM, stateABC, { type: 'toggle' }),
    'A1: nested product ≡ flat product (accept path)'
  )
  assert(
    checkProductAssociativity(lightFSM, fanFSM, counterFSM, stateABC, { type: 'unknown' }),
    'A1: nested ≡ flat (no-match)'
  )
}

// A2. explicit reject in one child — 여전히 동치
{
  const stateABC = { a: 'off', b: 'off', c: 0 }
  // counterFSM 'dec' on 0 → reject, light/fan 'dec' → no-match
  // nested 와 flat 둘 다 동일한 reject aggregation
  assert(
    checkProductAssociativity(lightFSM, fanFSM, counterFSM, stateABC, { type: 'dec' }),
    'A2: nested ≡ flat (explicit reject)'
  )
}

// --- normalize utilities ---

// N1. normalizeRight 이 perFsm / transitionIndex 제거
{
  const r = step(roomFSM, { light: 'off', fan: 'off' }, { type: 'toggle' })
  const n = normalizeRight(r.value)
  assert(!('perFsm' in n), 'N1: normalizeRight 가 perFsm 제거')
  assert(!('transitionIndex' in n), 'N1: normalizeRight 가 transitionIndex 제거')
  assert('state' in n && 'events' in n, 'N1: state / events 유지')
}

// N2. normalizeLeft 이 command / fsm / transitionIndex 제거
{
  const r = step(counterFSM, 0, { type: 'dec' })
  const n = normalizeLeft(r.value)
  assert(!('command' in n) && !('state' in n), 'N2: command/state 제거')
  assert(n.reasons[0].kind === 'explicit', 'N2: reason kind 유지')
  assert(!('fsm' in n.reasons[0]) && !('transitionIndex' in n.reasons[0]),
    'N2: reasons 에서 fsm/transitionIndex 제거')
}

// N3. eqNormalized
{
  const a = { state: 1, events: [] }
  const b = { state: 1, events: [] }
  const c = { state: 2, events: [] }
  assert(eqNormalized(a, b), 'N3: 같은 shape 동치')
  assert(!eqNormalized(a, c), 'N3: 다른 state 비동치')
}

summary()
