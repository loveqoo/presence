import { Transition, makeFSM, step } from '@presence/core/core/fsm/fsm.js'
import { product, parallel } from '@presence/core/core/fsm/product.js'
import { assert, assertDeepEqual, summary } from '../../../../test/lib/assert.js'

console.log('FSM product tests')

// --- data constructor ---

// PC1. product 정상 생성
{
  const a = makeFSM('a', 1, [])
  const b = makeFSM('b', 'x', [])
  const p = product({ a, b })
  assert(p.kind === 'product', 'PC1: kind=product')
  assertDeepEqual(p.keys, ['a', 'b'], 'PC1: keys array 저장')
  assertDeepEqual(p.initial, { a: 1, b: 'x' }, 'PC1: initial from children')
  assert(p.children.a === a && p.children.b === b, 'PC1: children reference')
  assert(p.id.includes('a') && p.id.includes('b'), 'PC1: id encodes keys')
}

// PC2. non-object throws
{
  let thrown = null
  try { product(null) } catch (e) { thrown = e }
  assert(thrown !== null, 'PC2: null throws')
}

// PC3. empty product 허용 (law 의 identity)
{
  const p = product({})
  assertDeepEqual(p.keys, [], 'PC3: empty keys')
  assertDeepEqual(p.initial, {}, 'PC3: empty initial')
}

// --- parallel alias ---

// PA1. parallel = product({ left, right })
{
  const a = makeFSM('a', 1, [])
  const b = makeFSM('b', 2, [])
  const p = parallel(a, b)
  assertDeepEqual(p.keys, ['left', 'right'], 'PA1: keys=[left,right]')
  assert(p.children.left === a && p.children.right === b, 'PA1: children 매핑')
}

// --- R1 Case 1: empty product identity ---

// E1. 빈 product → Right({state:{}, events:[]}) 모든 command 에 대해
{
  const p = product({})
  const r1 = step(p, {}, { type: 'anything' })
  assert(r1.isRight(), 'E1: empty product accepts any command')
  assertDeepEqual(r1.value.state, {}, 'E1: state = {}')
  assertDeepEqual(r1.value.events, [], 'E1: events = []')

  const r2 = step(p, {}, { type: 'other' })
  assert(r2.isRight(), 'E1: 다른 command 도 accept')
}

// --- R1 Case 2: accept aggregation ---

// A1. 둘 다 accept → state merge, events key-order
{
  const aFsm = makeFSM('a', 'off', [
    Transition({ from: 'off', on: 'go', to: 'on', emit: [{ topic: 'a.on' }] }),
  ])
  const bFsm = makeFSM('b', 0, [
    Transition({ from: 0, on: 'go', to: 1, emit: [{ topic: 'b.inc' }] }),
  ])
  const p = product({ a: aFsm, b: bFsm })
  const result = step(p, { a: 'off', b: 0 }, { type: 'go' })
  assert(result.isRight(), 'A1: 둘 다 accept → Right')
  assertDeepEqual(result.value.state, { a: 'on', b: 1 }, 'A1: state merge')
  assertDeepEqual(
    result.value.events,
    [{ topic: 'a.on' }, { topic: 'b.inc' }],
    'A1: events in key order'
  )
  assert(result.value.perFsm.a.isRight() && result.value.perFsm.b.isRight(),
    'A1: perFsm 기록 (디버깅)')
}

// A2. state slot isolation — 한 child 만 accept, 다른 child 는 no-match → 거부 slot 불변
{
  const aFsm = makeFSM('a', 'x', [
    Transition({ from: 'x', on: 'go', to: 'y', emit: [{ topic: 'a.moved' }] }),
  ])
  const bFsm = makeFSM('b', 'p', [
    Transition({ from: 'p', on: 'other', to: 'q' }),  // 'go' 에는 no-match
  ])
  const p = product({ a: aFsm, b: bFsm })
  const result = step(p, { a: 'x', b: 'p' }, { type: 'go' })
  assert(result.isRight(), 'A2: 하나라도 accept → Right')
  assertDeepEqual(result.value.state, { a: 'y', b: 'p' }, 'A2: b slot 불변 (no-match)')
  assertDeepEqual(result.value.events, [{ topic: 'a.moved' }], 'A2: only a events')
}

// A3. explicit 거부가 수락을 이긴다 — 전체 Left, 모든 slot 불변
{
  const aFsm = makeFSM('a', 'x', [
    Transition({ from: 'x', on: 'go', to: 'y' }),
  ])
  const bFsm = makeFSM('b', 'busy', [
    Transition({ from: 'busy', on: 'go', reject: 'b-busy' }),
  ])
  const p = product({ a: aFsm, b: bFsm })
  const result = step(p, { a: 'x', b: 'busy' }, { type: 'go' })
  assert(result.isLeft(), 'A3: 한 FSM 이라도 explicit 거부면 전체 Left')
  assertDeepEqual(result.value.primaryReason, 'b-busy', 'A3: primary = 첫 explicit reason')
  assertDeepEqual(result.value.state, { a: 'x', b: 'busy' }, 'A3: state 전체 불변 (a slot 도 전이 안 됨)')
}

// A4. event 순서 = key array 순서 (객체 생성 순서)
{
  const bFsm = makeFSM('b', 0, [
    Transition({ from: 0, on: 'go', to: 1, emit: [{ topic: 'b.done' }] }),
  ])
  const aFsm = makeFSM('a', 0, [
    Transition({ from: 0, on: 'go', to: 1, emit: [{ topic: 'a.done' }] }),
  ])
  // key 순서 b, a — event 도 b.done, a.done
  const p = product({ b: bFsm, a: aFsm })
  const result = step(p, { b: 0, a: 0 }, { type: 'go' })
  assertDeepEqual(
    result.value.events,
    [{ topic: 'b.done' }, { topic: 'a.done' }],
    'A4: event 순서가 key 순서 따름'
  )
}

// --- R1 Case 3: 0 accepted + hasExplicit ---

// X1. explicit reject 만 → Left, primary = 첫 explicit
{
  const aFsm = makeFSM('a', 's', [
    Transition({ from: 's', on: 'go', reject: 'a-denied' }),
  ])
  const bFsm = makeFSM('b', 't', [
    Transition({ from: 't', on: 'go', reject: 'b-denied' }),
  ])
  const p = product({ a: aFsm, b: bFsm })
  const result = step(p, { a: 's', b: 't' }, { type: 'go' })
  assert(result.isLeft(), 'X1: 전부 reject → Left')
  assertDeepEqual(result.value.primaryReason, 'a-denied', 'X1: primary = first explicit')
  assert(result.value.reasons.length === 2, 'X1: 모든 reasons 합침')
  assert(result.value.reasons.every(r => r.kind === 'explicit'), 'X1: 둘 다 explicit kind')
}

// X2. no-match + explicit 혼합 → hasExplicit → Left primary=explicit
{
  const aFsm = makeFSM('a', 's', [
    Transition({ from: 's', on: 'go', reject: 'a-denied' }),
  ])
  const bFsm = makeFSM('b', 't', [])  // empty → no-match
  const p = product({ a: aFsm, b: bFsm })
  const result = step(p, { a: 's', b: 't' }, { type: 'go' })
  assert(result.isLeft(), 'X2: 0 accepted → Left')
  assertDeepEqual(result.value.primaryReason, 'a-denied',
    'X2: explicit 존재 시 primary = explicit reason')
  const kinds = result.value.reasons.map(r => r.kind).sort()
  assertDeepEqual(kinds, ['explicit', 'no-match'], 'X2: reasons 에 둘 다 포함')
}

// --- R1 Case 4: 0 accepted + !hasExplicit ---

// U1. 전부 no-match → primary = 'unhandled'
{
  const aFsm = makeFSM('a', 's', [
    Transition({ from: 's', on: 'other', to: 'x' }),
  ])
  const bFsm = makeFSM('b', 't', [])
  const p = product({ a: aFsm, b: bFsm })
  const result = step(p, { a: 's', b: 't' }, { type: 'go' })
  assert(result.isLeft(), 'U1: no-match 전부 → Left')
  assertDeepEqual(result.value.primaryReason, 'unhandled',
    'U1: explicit 없으면 primary=unhandled')
  assert(result.value.reasons.every(r => r.kind !== 'explicit'),
    'U1: explicit kind 없음')
}

// U2. guard-failed 만 → primary='unhandled' (guard-failed 는 primary 후보 아님, R2)
{
  const aFsm = makeFSM('a', 's', [
    Transition({
      from: 's', on: 'go',
      guard: () => false,
      to: 'x',
    }),
  ])
  const p = product({ a: aFsm })
  const result = step(p, { a: 's' }, { type: 'go' })
  assert(result.isLeft(), 'U2: guard-failed only → Left')
  assertDeepEqual(result.value.primaryReason, 'unhandled', 'U2: primary=unhandled')
  assert(result.value.reasons.some(r => r.kind === 'guard-failed'),
    'U2: reasons 에 guard-failed 포함')
}

// --- nested product ---

// NP1. product({ a, bc: product({ b, c }) }) 도 동작
{
  const aFsm = makeFSM('a', 0, [
    Transition({ from: 0, on: 'go', to: 1, emit: [{ topic: 'a' }] }),
  ])
  const bFsm = makeFSM('b', 0, [
    Transition({ from: 0, on: 'go', to: 1, emit: [{ topic: 'b' }] }),
  ])
  const cFsm = makeFSM('c', 0, [
    Transition({ from: 0, on: 'go', to: 1, emit: [{ topic: 'c' }] }),
  ])
  const inner = product({ b: bFsm, c: cFsm })
  const outer = product({ a: aFsm, bc: inner })
  const result = step(outer, { a: 0, bc: { b: 0, c: 0 } }, { type: 'go' })
  assert(result.isRight(), 'NP1: nested product accept')
  assertDeepEqual(result.value.state, { a: 1, bc: { b: 1, c: 1 } }, 'NP1: nested state')
  assertDeepEqual(
    result.value.events,
    [{ topic: 'a' }, { topic: 'b' }, { topic: 'c' }],
    'NP1: event 순서 = outer key then inner key'
  )
}

summary()
