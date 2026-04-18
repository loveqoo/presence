import { Transition, makeFSM, step } from '@presence/core/core/fsm/fsm.js'
import { makeCommand } from '@presence/core/core/fsm/command.js'
import { makeEvent } from '@presence/core/core/fsm/event.js'
import fp from '@presence/core/lib/fun-fp.js'
import { assert, assertDeepEqual, summary } from '../../../../test/lib/assert.js'

const { Either } = fp

console.log('FSM core tests')

// --- Transition 불변식 ---

// T1. reject + to 동시 → throw
{
  let thrown = null
  try { Transition({ from: 'a', on: 'x', reject: 'nope', to: 'b' }) }
  catch (e) { thrown = e }
  assert(thrown !== null, 'Transition: reject+to → throw')
  assert(thrown.message.includes('mutually exclusive'), 'Transition: reject+to throw message')
}

// T2. reject + emit 동시 → throw
{
  let thrown = null
  try { Transition({ from: 'a', on: 'x', reject: 'nope', emit: [{ topic: 'e' }] }) }
  catch (e) { thrown = e }
  assert(thrown !== null, 'Transition: reject+emit → throw')
}

// T3. emit only 허용 (state 유지, event만)
{
  const t = Transition({ from: 'a', on: 'ping', emit: [{ topic: 'status.checked' }] })
  assert(t.emit !== undefined && t.to === undefined, 'Transition: emit only allowed')
}

// T4. identity (to/emit/reject 없음) 허용
{
  const t = Transition({ from: 'a', on: 'x' })
  assert(t.to === undefined && t.emit === undefined && t.reject === undefined,
    'Transition: identity allowed')
}

// T5. from 필수
{
  let thrown = null
  try { Transition({ on: 'x' }) }
  catch (e) { thrown = e }
  assert(thrown !== null, 'Transition: missing from throws')
}

// T6. on 필수
{
  let thrown = null
  try { Transition({ from: 'a' }) }
  catch (e) { thrown = e }
  assert(thrown !== null, 'Transition: missing on throws')
}

// --- makeFSM ---

// M1. 정상 생성
{
  const fsm = makeFSM('test', 'idle', [])
  assert(fsm.kind === 'atomic', 'makeFSM: kind=atomic')
  assert(fsm.id === 'test', 'makeFSM: id set')
  assert(fsm.initial === 'idle', 'makeFSM: initial set')
  assertDeepEqual(fsm.transitions, [], 'makeFSM: empty transitions')
}

// M2. id 비어있으면 throw
{
  let thrown = null
  try { makeFSM('', 'idle', []) }
  catch (e) { thrown = e }
  assert(thrown !== null, 'makeFSM: empty id throws')
}

// M3. transitions 배열 아니면 throw
{
  let thrown = null
  try { makeFSM('x', 'idle', null) }
  catch (e) { thrown = e }
  assert(thrown !== null, 'makeFSM: non-array transitions throws')
}

// --- step — basic accept ---

// S1. 단일 transition accept (to only)
{
  const fsm = makeFSM('light', 'off', [
    Transition({ from: 'off', on: 'toggle', to: 'on' }),
  ])
  const result = step(fsm, 'off', { type: 'toggle' })
  assert(result.isRight(), 'S1: accept → Right')
  assertDeepEqual(result.value.state, 'on', 'S1: state = on')
  assertDeepEqual(result.value.events, [], 'S1: no events')
}

// S2. emit only (state 유지)
{
  const fsm = makeFSM('probe', 'up', [
    Transition({ from: 'up', on: 'ping', emit: [{ topic: 'status.checked' }] }),
  ])
  const result = step(fsm, 'up', { type: 'ping' })
  assert(result.isRight(), 'S2: accept → Right')
  assertDeepEqual(result.value.state, 'up', 'S2: state 유지')
  assertDeepEqual(result.value.events, [{ topic: 'status.checked' }], 'S2: event emitted')
}

// S3. to + emit
{
  const fsm = makeFSM('sw', 'a', [
    Transition({ from: 'a', on: 'go', to: 'b', emit: [{ topic: 'moved' }] }),
  ])
  const result = step(fsm, 'a', { type: 'go' })
  assert(result.value.state === 'b' && result.value.events[0].topic === 'moved',
    'S3: to + emit both applied')
}

// S4. identity transition (매칭 but no-op)
{
  const fsm = makeFSM('id', 'x', [
    Transition({ from: 'x', on: 'noop' }),   // no to/emit/reject
  ])
  const result = step(fsm, 'x', { type: 'noop' })
  assert(result.isRight(), 'S4: identity → Right')
  assert(result.value.state === 'x', 'S4: state unchanged')
  assertDeepEqual(result.value.events, [], 'S4: no events')
}

// --- step — first-match ---

// F1. 여러 매칭 중 첫 번째만 승리
{
  const fsm = makeFSM('fm', 'a', [
    Transition({ from: 'a', on: 'x', to: 'b' }),    // 먼저
    Transition({ from: 'a', on: 'x', to: 'c' }),    // 무시됨
  ])
  const result = step(fsm, 'a', { type: 'x' })
  assert(result.value.state === 'b', 'F1: first-match wins')
}

// --- pattern matching ---

// P1. from 이 predicate 함수
{
  const fsm = makeFSM('p', 5, [
    Transition({ from: (s) => s > 0, on: 'dec', to: (s) => s - 1 }),
  ])
  const result = step(fsm, 5, { type: 'dec' })
  assert(result.value.state === 4, 'P1: from predicate + to function')
}

// P2. on 이 predicate 함수
{
  const fsm = makeFSM('p2', 'a', [
    Transition({ from: 'a', on: (c) => c.type.startsWith('go:'), to: 'b' }),
  ])
  const r1 = step(fsm, 'a', { type: 'go:fast' })
  const r2 = step(fsm, 'a', { type: 'stop' })
  assert(r1.isRight() && r1.value.state === 'b', 'P2: on predicate matches')
  assert(r2.isLeft(), 'P2: on predicate non-match → Left')
}

// --- explicit reject ---

// E1. explicit reject → Left with kind='explicit'
{
  const fsm = makeFSM('r', 'working', [
    Transition({ from: 'working', on: 'chat', reject: 'session-busy' }),
  ])
  const result = step(fsm, 'working', { type: 'chat' })
  assert(result.isLeft(), 'E1: explicit reject → Left')
  assertDeepEqual(result.value.primaryReason, 'session-busy', 'E1: primaryReason = reject string')
  assert(result.value.reasons.length === 1, 'E1: reasons has 1 entry')
  assertDeepEqual(result.value.reasons[0].kind, 'explicit', 'E1: kind=explicit')
  assertDeepEqual(result.value.reasons[0].fsm, 'r', 'E1: fsm id recorded')
}

// E2. reject 함수형
{
  const fsm = makeFSM('rf', 'locked', [
    Transition({
      from: 'locked',
      on: 'open',
      reject: (s, c) => `locked:${c.type}`,
    }),
  ])
  const result = step(fsm, 'locked', { type: 'open' })
  assertDeepEqual(result.value.primaryReason, 'locked:open', 'E2: reject function evaluated')
}

// --- no-match ---

// N1. 매칭 없음 (guard-failed 없음) → reasons = [no-match]
{
  const fsm = makeFSM('nm', 'a', [
    Transition({ from: 'a', on: 'x', to: 'b' }),
  ])
  const result = step(fsm, 'a', { type: 'y' })
  assert(result.isLeft(), 'N1: no match → Left')
  assertDeepEqual(result.value.primaryReason, 'unhandled', 'N1: primaryReason=unhandled')
  assert(result.value.reasons.length === 1, 'N1: 1 reason')
  assertDeepEqual(result.value.reasons[0].kind, 'no-match', 'N1: kind=no-match')
}

// N2. 빈 transitions
{
  const fsm = makeFSM('empty', 'x', [])
  const result = step(fsm, 'x', { type: 'any' })
  assert(result.isLeft(), 'N2: empty transitions → Left')
  assertDeepEqual(result.value.reasons[0].kind, 'no-match', 'N2: kind=no-match')
}

// --- guard-failed ---

// G1. guard fail 후 스캔 끝 (다른 매칭 없음) → reasons = guard-failed only, no-match 없음
{
  const fsm = makeFSM('g', 'a', [
    Transition({
      from: 'a', on: 'x',
      guard: (s, c) => c.payload === 'ok',
      to: 'b',
    }),
  ])
  const result = step(fsm, 'a', { type: 'x', payload: 'no' })
  assert(result.isLeft(), 'G1: guard fail → Left')
  assertDeepEqual(result.value.primaryReason, 'unhandled', 'G1: primaryReason=unhandled')
  assert(result.value.reasons.length === 1, 'G1: 1 reason')
  assertDeepEqual(result.value.reasons[0].kind, 'guard-failed', 'G1: kind=guard-failed')
  assert(result.value.reasons.every(r => r.kind !== 'no-match'),
    'G1: no-match entry 추가되지 않음')
}

// G2. guard fail + explicit reject 승리 → reasons = guard-failed ++ explicit
{
  const fsm = makeFSM('g2', 'a', [
    Transition({
      from: 'a', on: 'x',
      guard: () => false,
      to: 'b',
    }),
    Transition({ from: 'a', on: 'x', reject: 'denied' }),
  ])
  const result = step(fsm, 'a', { type: 'x' })
  assert(result.isLeft(), 'G2: explicit wins after guard fail → Left')
  assertDeepEqual(result.value.primaryReason, 'denied', 'G2: primaryReason=explicit reason')
  assert(result.value.reasons.length === 2, 'G2: 2 reasons (guard-failed + explicit)')
  assertDeepEqual(result.value.reasons[0].kind, 'guard-failed', 'G2: [0] guard-failed')
  assertDeepEqual(result.value.reasons[1].kind, 'explicit', 'G2: [1] explicit')
}

// G3. guard fail 후 accept 승리 → Right (guardFailures 버림)
{
  const fsm = makeFSM('g3', 'a', [
    Transition({
      from: 'a', on: 'x',
      guard: () => false,
      to: 'b',
    }),
    Transition({ from: 'a', on: 'x', to: 'c' }),
  ])
  const result = step(fsm, 'a', { type: 'x' })
  assert(result.isRight(), 'G3: accept wins after guard fail → Right')
  assertDeepEqual(result.value.state, 'c', 'G3: second transition state')
}

// --- emit pure pass-through (ts 주입 없음) ---

// X1. step 이 events 에 ts 주입하지 않음
{
  const fsm = makeFSM('x1', 'a', [
    Transition({ from: 'a', on: 'go', emit: [{ topic: 'done', payload: 42 }] }),
  ])
  const result = step(fsm, 'a', { type: 'go' })
  const ev = result.value.events[0]
  assert(!('ts' in ev), 'X1: step 이 ts 주입하지 않음')
  assertDeepEqual(ev, { topic: 'done', payload: 42 }, 'X1: event shape 그대로')
}

// X2. emit 함수형 pure pass-through
{
  const fsm = makeFSM('x2', 'a', [
    Transition({
      from: 'a',
      on: 'go',
      to: 'b',
      emit: (s, c) => [{ topic: `from:${s}`, payload: c.type }],
    }),
  ])
  const result = step(fsm, 'a', { type: 'go' })
  assertDeepEqual(result.value.events, [{ topic: 'from:a', payload: 'go' }],
    'X2: emit function evaluated with (state, command)')
}

// --- makeCommand ---

// C1. type 만 있는 최소 command
{
  const c = makeCommand({ type: 'chat' })
  assertDeepEqual(c, { type: 'chat' }, 'C1: minimal command')
  assert(!('ts' in c), 'C1: ts 주입 안 됨')
}

// C2. 모든 선택 필드 pass-through
{
  const c = makeCommand({
    type: 'chat',
    origin: 'tui:A',
    principal: 'user:gunam',
    payload: { text: 'hi' },
    id: 'uuid-1',
  })
  assertDeepEqual(c, {
    type: 'chat',
    origin: 'tui:A',
    principal: 'user:gunam',
    payload: { text: 'hi' },
    id: 'uuid-1',
  }, 'C2: all optional fields')
}

// C3. type 누락 → throw
{
  let thrown = null
  try { makeCommand({ origin: 'x' }) } catch (e) { thrown = e }
  assert(thrown !== null, 'C3: missing type throws')
}

// C4. type 이 빈 문자열 → throw
{
  let thrown = null
  try { makeCommand({ type: '' }) } catch (e) { thrown = e }
  assert(thrown !== null, 'C4: empty type throws')
}

// C5. undefined 선택 필드는 제외
{
  const c = makeCommand({ type: 'chat', origin: undefined, payload: undefined })
  assert(!('origin' in c) && !('payload' in c), 'C5: undefined fields omitted')
}

// --- makeEvent ---

// V1. topic 만 있는 최소 event
{
  const e = makeEvent({ topic: 'turn.started' })
  assertDeepEqual(e, { topic: 'turn.started' }, 'V1: minimal event')
  assert(!('ts' in e), 'V1: ts 주입 안 됨')
}

// V2. 선택 필드 pass-through
{
  const e = makeEvent({ topic: 'turn.started', payload: { id: 1 }, source: 'turnGate' })
  assertDeepEqual(e, { topic: 'turn.started', payload: { id: 1 }, source: 'turnGate' },
    'V2: all optional fields')
}

// V3. topic 누락 → throw
{
  let thrown = null
  try { makeEvent({ payload: 1 }) } catch (e) { thrown = e }
  assert(thrown !== null, 'V3: missing topic throws')
}

// V4. topic 이 빈 문자열 → throw
{
  let thrown = null
  try { makeEvent({ topic: '' }) } catch (e) { thrown = e }
  assert(thrown !== null, 'V4: empty topic throws')
}

// V5. makeEvent 가 step 과 호환 (emit 으로 전달된 후 pass-through 확인)
{
  const fsm = makeFSM('ev', 'a', [
    Transition({
      from: 'a', on: 'go', to: 'b',
      emit: (s, c) => [makeEvent({ topic: `from:${s}`, payload: c.type })],
    }),
  ])
  const result = step(fsm, 'a', makeCommand({ type: 'go' }))
  assertDeepEqual(result.value.events, [{ topic: 'from:a', payload: 'go' }],
    'V5: makeEvent + makeCommand interoperate with step')
  assert(!('ts' in result.value.events[0]), 'V5: step pass-through 유지 (no ts)')
}

summary()
