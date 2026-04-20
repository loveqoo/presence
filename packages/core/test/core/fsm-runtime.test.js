import { Transition, makeFSM } from '@presence/core/core/fsm/fsm.js'
import { makeFsmEventBus } from '@presence/core/core/fsm/event-bus.js'
import { makeFSMRuntime, REJECTION_TOPIC, makeDefaultVersionGen } from '@presence/core/core/fsm/runtime.js'
import { turnGateFSM } from '@presence/infra/infra/fsm/turn-gate-fsm.js'
import { TurnState } from '@presence/core/core/policies.js'
import { assert, assertDeepEqual, summary } from '../../../../test/lib/assert.js'

console.log('FSMRuntime tests')

// 고정 clock / idGen — 결정론 테스트용
const fixedDeps = (tsStart = 1000, idStart = 100) => {
  let ts = tsStart
  let id = idStart
  return {
    clock: () => ts++,
    idGen: () => `id-${id++}`,
  }
}

// --- constructor ---

// C1. 기본 initial = fsm.initial
{
  const fsm = makeFSM('f', 'zero', [])
  const bus = makeFsmEventBus()
  const runtime = makeFSMRuntime({ fsm, bus })
  assertDeepEqual(runtime.state, 'zero', 'C1: initial 기본값')
  assert(runtime.fsm === fsm, 'C1: fsm 참조')
}

// C2. initial override 허용 (hydration)
{
  const fsm = makeFSM('f', 'zero', [])
  const bus = makeFsmEventBus()
  const runtime = makeFSMRuntime({ fsm, initial: 'restored', bus })
  assertDeepEqual(runtime.state, 'restored', 'C2: initial override')
}

// C3. fsm / bus 누락 시 throw
{
  let thrown = null
  try { makeFSMRuntime({ bus: makeFsmEventBus() }) } catch (e) { thrown = e }
  assert(thrown !== null, 'C3: fsm 누락 throw')
  thrown = null
  try { makeFSMRuntime({ fsm: makeFSM('f', 0, []) }) } catch (e) { thrown = e }
  assert(thrown !== null, 'C3: bus 누락 throw')
}

// --- Phase A commit — accept ---

// A1. 기본 accept — state 갱신 + Right 에 enriched 포함
{
  const fsm = makeFSM('f', 'off', [
    Transition({ from: 'off', on: 'toggle', to: 'on', emit: [{ topic: 'f.on' }] }),
  ])
  const received = []
  const bus = makeFsmEventBus({ clock: () => 500 })
  bus.subscribe('*', (ev) => received.push(ev))
  const runtime = makeFSMRuntime({ fsm, bus, ...fixedDeps() })

  const result = runtime.submit({ type: 'toggle' })
  assert(result.isRight(), 'A1: accept → Right')
  assertDeepEqual(result.value.state, 'on', 'A1: state=on')
  assertDeepEqual(runtime.state, 'on', 'A1: runtime.state 갱신')
  assertDeepEqual(result.value.events[0].topic, 'f.on', 'A1: Right 에 event topic')
  assertDeepEqual(result.value.events[0].source, 'f', 'A1: source 기본 = fsm.id')
  assertDeepEqual(result.value.events[0].ts, 1001, 'A1: event ts 주입 (runtime clock)')
  assertDeepEqual(result.value.command.type, 'toggle', 'A1: Right 에 enriched command')
  assertDeepEqual(result.value.command.id, 'id-100', 'A1: command.id 주입')
  assertDeepEqual(result.value.command.ts, 1000, 'A1: command.ts 주입 (먼저 호출)')
  assert(received.length === 1, 'A1: bus 로도 event 발행됨')
}

// A2. events 가 여러 개일 때 순서 보존 + 각각 enriched
{
  const fsm = makeFSM('f', 'a', [
    Transition({ from: 'a', on: 'go', to: 'b', emit: [{ topic: 't1' }, { topic: 't2' }] }),
  ])
  const topics = []
  const bus = makeFsmEventBus()
  bus.subscribe('*', (ev) => topics.push(ev.topic))
  const runtime = makeFSMRuntime({ fsm, bus, ...fixedDeps() })

  const result = runtime.submit({ type: 'go' })
  assertDeepEqual(result.value.events.map(e => e.topic), ['t1', 't2'], 'A2: 순서 보존')
  assertDeepEqual(topics, ['t1', 't2'], 'A2: bus 발행 순서')
}

// A3. identity transition (events=[]) → state 유지 + Right, bus 호출 없음
{
  const fsm = makeFSM('f', 'x', [
    Transition({ from: 'x', on: 'noop' }),
  ])
  const received = []
  const bus = makeFsmEventBus()
  bus.subscribe('*', (ev) => received.push(ev))
  const runtime = makeFSMRuntime({ fsm, bus, ...fixedDeps() })

  const result = runtime.submit({ type: 'noop' })
  assert(result.isRight(), 'A3: identity → Right')
  assertDeepEqual(result.value.state, 'x', 'A3: state 유지')
  assertDeepEqual(result.value.events, [], 'A3: events 없음')
  assert(received.length === 0, 'A3: bus 호출 없음')
}

// --- Envelope 주입 우선순위 (기존 값 보존) ---

// E1. cmd.id / cmd.ts 가 있으면 보존
{
  const fsm = makeFSM('f', 'a', [Transition({ from: 'a', on: 'x', to: 'b' })])
  const bus = makeFsmEventBus()
  const runtime = makeFSMRuntime({ fsm, bus, ...fixedDeps() })

  const result = runtime.submit({ type: 'x', id: 'custom-id', ts: 42 })
  assertDeepEqual(result.value.command.id, 'custom-id', 'E1: cmd.id 보존')
  assertDeepEqual(result.value.command.ts, 42, 'E1: cmd.ts 보존')
}

// E2. event.source / event.ts 가 있으면 보존
{
  const fsm = makeFSM('f', 'a', [
    Transition({
      from: 'a', on: 'x', to: 'b',
      emit: [{ topic: 't', source: 'custom-src', ts: 999 }],
    }),
  ])
  const bus = makeFsmEventBus()
  const runtime = makeFSMRuntime({ fsm, bus, ...fixedDeps() })

  const result = runtime.submit({ type: 'x' })
  assertDeepEqual(result.value.events[0].source, 'custom-src', 'E2: event.source 보존')
  assertDeepEqual(result.value.events[0].ts, 999, 'E2: event.ts 보존')
}

// --- Freeze 검증 (state aliasing 방어) ---

// Z1. Right 반환 객체 + events + state 가 frozen
{
  const fsm = makeFSM('f', { count: 0 }, [
    Transition({ from: () => true, on: 'x', to: (s) => ({ count: s.count + 1 }) }),
  ])
  const bus = makeFsmEventBus()
  const runtime = makeFSMRuntime({ fsm, bus, ...fixedDeps() })

  const result = runtime.submit({ type: 'x' })
  assert(Object.isFrozen(result.value), 'Z1: Right.value frozen')
  assert(Object.isFrozen(result.value.events), 'Z1: events array frozen')
  assert(Object.isFrozen(result.value.state), 'Z1: state (plain object) frozen')
  assert(Object.isFrozen(result.value.command), 'Z1: command frozen')
  // runtime.state 와 반환값의 state 는 같은 참조
  assert(runtime.state === result.value.state, 'Z1: runtime.state === Right.state (aliasing)')
}

// Z2. frozen state 에 mutation 시도 — strict mode 하에서 TypeError
{
  const fsm = makeFSM('f', { a: 1 }, [
    Transition({ from: () => true, on: 'x', to: (s) => ({ a: s.a + 1 }) }),
  ])
  const bus = makeFsmEventBus()
  const runtime = makeFSMRuntime({ fsm, bus, ...fixedDeps() })
  const result = runtime.submit({ type: 'x' })
  let threw = false
  try { result.value.state.a = 999 } catch { threw = true }
  assert(threw, 'Z2: frozen state 에 mutation 시도 TypeError')
  assertDeepEqual(runtime.state.a, 2, 'Z2: 내부 state 오염 없음')
}

// Z3. Left 반환도 frozen
{
  const fsm = makeFSM('f', 'busy', [
    Transition({ from: 'busy', on: 'chat', reject: 'no' }),
  ])
  const bus = makeFsmEventBus()
  const runtime = makeFSMRuntime({ fsm, bus, ...fixedDeps() })
  const result = runtime.submit({ type: 'chat' })
  assert(result.isLeft(), 'Z3: reject → Left')
  assert(Object.isFrozen(result.value), 'Z3: Left.value frozen')
  assert(Object.isFrozen(result.value.command), 'Z3: Left.value.command frozen')
}

// --- Phase A reject ---

// R1. explicit reject → Left + state 불변 + bus 에 fsm.rejected 발행
{
  const fsm = makeFSM('gate', 'busy', [
    Transition({ from: 'busy', on: 'chat', reject: 'session-busy' }),
  ])
  const received = []
  const bus = makeFsmEventBus()
  bus.subscribe('*', (ev) => received.push(ev))
  const runtime = makeFSMRuntime({ fsm, bus, ...fixedDeps() })

  const result = runtime.submit({ type: 'chat' })
  assert(result.isLeft(), 'R1: Left')
  assertDeepEqual(result.value.primaryReason, 'session-busy', 'R1: primaryReason')
  assertDeepEqual(runtime.state, 'busy', 'R1: state 불변')
  assert(received.length === 1, 'R1: bus 에 rejection 발행')
  assertDeepEqual(received[0].topic, REJECTION_TOPIC, 'R1: topic = fsm.rejected')
  assertDeepEqual(received[0].source, 'gate', 'R1: source = fsm.id')
  assertDeepEqual(received[0].payload.primaryReason, 'session-busy', 'R1: payload.primaryReason')
  assertDeepEqual(received[0].payload.command.type, 'chat', 'R1: payload.command echo')
}

// R2. no-match → Left + primaryReason='unhandled' + bus publish
{
  const fsm = makeFSM('f', 'a', [
    Transition({ from: 'a', on: 'other', to: 'b' }),
  ])
  const received = []
  const bus = makeFsmEventBus()
  bus.subscribe(REJECTION_TOPIC, (ev) => received.push(ev))
  const runtime = makeFSMRuntime({ fsm, bus, ...fixedDeps() })

  runtime.submit({ type: 'unknown' })
  assert(received.length === 1, 'R2: no-match 도 bus 발행')
  assertDeepEqual(received[0].payload.primaryReason, 'unhandled', 'R2: unhandled')
}

// --- F1 runtime-level: subscriber throw → Either 정상 유지 ---

// F1r. subscriber throw 해도 submit 의 Either 는 정상, state 는 갱신
{
  const fsm = makeFSM('f', 'a', [
    Transition({ from: 'a', on: 'x', to: 'b', emit: [{ topic: 't' }] }),
  ])
  const errors = []
  const bus = makeFsmEventBus({ onError: (err) => errors.push(err.message) })
  bus.subscribe('t', () => { throw new Error('boom') })
  const runtime = makeFSMRuntime({ fsm, bus, ...fixedDeps() })

  const result = runtime.submit({ type: 'x' })
  assert(result.isRight(), 'F1r: Either 정상')
  assertDeepEqual(result.value.state, 'b', 'F1r: state 갱신됨')
  assertDeepEqual(runtime.state, 'b', 'F1r: runtime.state 갱신됨')
  assert(errors.length === 1, 'F1r: bus 의 onError 기록')
}

// --- F3 nested submit (interleave 허용) ---

// F3. subscriber 가 runtime.submit 하면 outer 진행 중 inner 처리
{
  const fsm = makeFSM('counter', 0, [
    Transition({
      from: () => true, on: 'inc',
      to: (s) => s + 1,
      emit: (s) => [{ topic: `inc:${s + 1}` }],
    }),
  ])
  const topics = []
  const bus = makeFsmEventBus()
  bus.subscribe('*', (ev) => {
    topics.push(ev.topic)
    // 첫 인덱스일 때 nested submit → inner 이 완료된 뒤 outer 가 계속
    if (ev.topic === 'inc:1') {
      runtime.submit({ type: 'inc' })
    }
  })
  let runtime
  runtime = makeFSMRuntime({ fsm, bus, ...fixedDeps() })

  runtime.submit({ type: 'inc' })
  // topics 에 interleave 관찰: outer 의 'inc:1' 발행 → subscriber 안에서 inner submit →
  // inner commit (state=2) + inner publish 'inc:2' → subscriber 재호출
  assertDeepEqual(topics, ['inc:1', 'inc:2'], 'F3: outer 와 inner 가 interleave')
  assertDeepEqual(runtime.state, 2, 'F3: state 는 inner commit 값')
}

// --- F5 rejection publish 중 overflow → Left 정상 ---

// F5. rejection 토픽에 overflow 발생해도 Left 정상
{
  const fsm = makeFSM('f', 'busy', [
    Transition({ from: 'busy', on: 'chat', reject: 'nope' }),
  ])
  // overflow 유도용 bus (maxDepth=1) — rejection subscriber 가 nested submit
  const bus = makeFsmEventBus({ maxDepth: 1 })
  const runtime = makeFSMRuntime({ fsm, bus, ...fixedDeps() })
  bus.subscribe(REJECTION_TOPIC, () => { runtime.submit({ type: 'chat' }) })

  const result = runtime.submit({ type: 'chat' })
  assert(result.isLeft(), 'F5: Left 정상 반환')
  assertDeepEqual(result.value.primaryReason, 'nope', 'F5: primaryReason')
}

// --- F6 bus.publish throw — Either 정상 + commit-forward ---

// F6. bus.publish 자체 throw → Either 는 Phase A 에서 확정. state 는 이미 갱신
{
  const fsm = makeFSM('f', 0, [
    Transition({
      from: () => true, on: 'inc',
      to: (s) => s + 1,
      emit: [{ topic: 't1' }, { topic: 't2' }, { topic: 't3' }],
    }),
  ])
  const received = []
  // publish 중간에 throw — t2 발행 시점
  const throwingBus = {
    publish: (ev) => {
      if (ev.topic === 't2') throw new Error('bus bug')
      received.push(ev.topic)
    },
    subscribe: () => () => {},
  }
  const runtime = makeFSMRuntime({ fsm, bus: throwingBus, ...fixedDeps() })

  const result = runtime.submit({ type: 'inc' })
  assert(result.isRight(), 'F6: Either 정상 반환 (publication throw 격리)')
  assertDeepEqual(result.value.state, 1, 'F6: state 갱신')
  assertDeepEqual(runtime.state, 1, 'F6: commit-forward (rollback 없음)')
  // prefix-partial: t1 만 도달, t2 에서 throw → t3 drop
  assertDeepEqual(received, ['t1'], 'F6: prefix-partial (t1만 도달)')
}

// --- DI 결정론 ---

// D1. 같은 clock / idGen 주입 시 결과 결정론
{
  const fsm = makeFSM('f', 'a', [
    Transition({ from: 'a', on: 'x', to: 'b', emit: [{ topic: 't' }] }),
  ])
  const mkRuntime = () => {
    const bus = makeFsmEventBus()
    return makeFSMRuntime({ fsm, bus, clock: () => 77, idGen: () => 'FIXED' })
  }
  const r1 = mkRuntime().submit({ type: 'x' })
  const r2 = mkRuntime().submit({ type: 'x' })
  assertDeepEqual(r1.value.command, r2.value.command, 'D1: command 동일')
  assertDeepEqual(r1.value.events, r2.value.events, 'D1: events 동일')
}

// --- turnGateFSM 통합 ---

// T1. idle + chat → working(input) + turn.started (payload 에 turnState 포함)
{
  const received = []
  const bus = makeFsmEventBus()
  bus.subscribe('*', (ev) => received.push(ev))
  const runtime = makeFSMRuntime({ fsm: turnGateFSM, bus, ...fixedDeps() })

  const result = runtime.submit({ type: 'chat', payload: { input: 'hi' } })
  assert(result.isRight(), 'T1: chat accept')
  assertDeepEqual(result.value.state, TurnState.working('hi'), 'T1: state=working(hi)')
  assertDeepEqual(runtime.state, TurnState.working('hi'), 'T1: runtime.state=working(hi)')
  assert(received.length === 1, 'T1: bus 1 event')
  assertDeepEqual(received[0].topic, 'turn.started', 'T1: turn.started')
  assertDeepEqual(received[0].source, 'turnGate', 'T1: source=turnGate')
  assertDeepEqual(received[0].payload.turnState, TurnState.working('hi'), 'T1: payload turnState')
}

// T2. working + chat → Left session-busy + fsm.rejected
{
  const received = []
  const bus = makeFsmEventBus()
  bus.subscribe('*', (ev) => received.push(ev))
  const runtime = makeFSMRuntime({
    fsm: turnGateFSM,
    initial: TurnState.working('q'),
    bus,
    ...fixedDeps(),
  })

  const result = runtime.submit({ type: 'chat', payload: { input: 'later' } })
  assert(result.isLeft(), 'T2: reject')
  assertDeepEqual(result.value.primaryReason, 'session-busy', 'T2: primaryReason')
  assertDeepEqual(runtime.state, TurnState.working('q'), 'T2: state 불변')
  assert(received.length === 1, 'T2: bus 에 rejection 1회')
  assertDeepEqual(received[0].topic, REJECTION_TOPIC, 'T2: fsm.rejected')
  assertDeepEqual(received[0].payload.primaryReason, 'session-busy', 'T2: payload primaryReason')
}

// --- stateVersion ---

// SV1. 초기 stateVersion 은 null
{
  const fsm = makeFSM('f', 'a', [])
  const bus = makeFsmEventBus()
  const runtime = makeFSMRuntime({ fsm, bus })
  assertDeepEqual(runtime.stateVersion, null, 'SV1: 초기값 null')
}

// SV2. accept 시 새 stateVersion 발급 + 이벤트에 자동 첨부 + Right.value 에 포함
{
  const fsm = makeFSM('f', 'a', [
    Transition({ from: 'a', on: 'x', to: 'b', emit: [{ topic: 't' }] }),
  ])
  const bus = makeFsmEventBus()
  const received = []
  bus.subscribe('*', (ev) => received.push(ev))
  const runtime = makeFSMRuntime({
    fsm, bus, clock: () => 999,
    idGen: () => 'V',
    versionGen: () => 'VER',
  })

  const result = runtime.submit({ type: 'x' })
  assertDeepEqual(runtime.stateVersion, 'VER', 'SV2: accept 후 stateVersion 발급')
  assertDeepEqual(result.value.stateVersion, 'VER', 'SV2: Right.value 에 stateVersion')
  assertDeepEqual(received[0].stateVersion, 'VER', 'SV2: 이벤트에 stateVersion 자동 첨부')
}

// SV3. 매 accept 마다 새 stateVersion
{
  const fsm = makeFSM('f', 0, [
    Transition({ from: () => true, on: 'inc', to: (s) => s + 1, emit: [{ topic: 'inc' }] }),
  ])
  const bus = makeFsmEventBus()
  let id = 0
  const runtime = makeFSMRuntime({ fsm, bus, idGen: () => `v-${id++}` })

  runtime.submit({ type: 'inc' })
  const v1 = runtime.stateVersion
  runtime.submit({ type: 'inc' })
  const v2 = runtime.stateVersion
  assert(v1 !== v2, 'SV3: 매 accept 마다 stateVersion 변경')
}

// SV4. reject 시 stateVersion 유지 (state 안 바뀌므로)
{
  const fsm = makeFSM('f', 'busy', [
    Transition({ from: 'busy', on: 'chat', reject: 'no' }),
  ])
  const bus = makeFsmEventBus()
  let id = 0
  const runtime = makeFSMRuntime({ fsm, bus, idGen: () => `v-${id++}` })

  const before = runtime.stateVersion  // null
  runtime.submit({ type: 'chat' })
  const after = runtime.stateVersion
  assertDeepEqual(after, before, 'SV4: reject 시 stateVersion 유지')
}

// SV5. rejection event 에도 stateVersion 첨부 (현재 버전)
{
  const fsm = makeFSM('f', 'busy', [
    Transition({ from: 'busy', on: 'chat', reject: 'no' }),
  ])
  const bus = makeFsmEventBus()
  const received = []
  bus.subscribe(REJECTION_TOPIC, (ev) => received.push(ev))
  const runtime = makeFSMRuntime({ fsm, bus, idGen: () => 'V' })

  runtime.submit({ type: 'chat' })
  assertDeepEqual(received[0].stateVersion, null, 'SV5: 초기 상태에서 reject → stateVersion=null')
}

// SV7. 기본 versionGen 이 sortable + monotonic — lex 순서 보장
{
  const gen = makeDefaultVersionGen()
  const v1 = gen()
  const v2 = gen()
  const v3 = gen()
  assert(v1 < v2, 'SV7: v1 < v2 (lex 순서)')
  assert(v2 < v3, 'SV7: v2 < v3')
  assert(v1 !== v2 && v2 !== v3, 'SV7: 모두 unique')
  // format: 12 hex ts - 6 hex counter
  assert(/^[0-9a-f]{12}-[0-9a-f]{6}$/.test(v1), 'SV7: format 12-6 hex')
}

// SV8. clock rollback 방어 — Date.now() 가 뒤로 가도 순서 유지
{
  let nowStub = 1000
  const origDateNow = Date.now
  Date.now = () => nowStub
  try {
    const gen = makeDefaultVersionGen()
    const v1 = gen()   // ts=1000
    nowStub = 500      // 뒤로 감 (NTP 보정 시뮬)
    const v2 = gen()   // prevTs=1000 유지, counter 증가
    nowStub = 1000
    const v3 = gen()   // now === prevTs, counter 증가
    nowStub = 2000
    const v4 = gen()   // forward, counter reset
    assert(v1 < v2, 'SV8: rollback 후에도 v1 < v2')
    assert(v2 < v3, 'SV8: v2 < v3 (같은 ts counter 증가)')
    assert(v3 < v4, 'SV8: forward 시 v3 < v4')
  } finally {
    Date.now = origDateNow
  }
}

// SV6. accept 후 reject — rejection event 에 최신 accept 버전 첨부
{
  const fsm = makeFSM('f', 'idle', [
    Transition({ from: 'idle', on: 'start', to: 'working', emit: [{ topic: 'started' }] }),
    Transition({ from: 'working', on: 'start', reject: 'busy' }),
  ])
  const bus = makeFsmEventBus()
  const rejections = []
  bus.subscribe(REJECTION_TOPIC, (ev) => rejections.push(ev))
  let id = 0
  const runtime = makeFSMRuntime({ fsm, bus, idGen: () => `v-${id++}` })

  runtime.submit({ type: 'start' })  // accept → stateVersion='v-0' (cmd.id 는 그 뒤)
  // 실제 순서: cmd.id idGen → stateVersion idGen. cmd.id='v-0', stateVersion='v-1'
  const accepted = runtime.stateVersion
  runtime.submit({ type: 'start' })  // reject → stateVersion 유지
  assertDeepEqual(runtime.stateVersion, accepted, 'SV6: reject 후에도 stateVersion 유지')
  assertDeepEqual(rejections[0].stateVersion, accepted, 'SV6: rejection event 에 최신 accept 버전')
}

// SV9. restoreStateVersion — persistence 복원 경로 (Phase 10)
{
  const fsm = makeFSM('f', 'a', [
    Transition({ from: 'a', on: 'x', to: 'b', emit: [{ topic: 't' }] }),
  ])
  const bus = makeFsmEventBus()
  const runtime = makeFSMRuntime({ fsm, bus, versionGen: () => 'V-NEW' })

  // 초기 null
  assertDeepEqual(runtime.stateVersion, null, 'SV9: 초기 null')

  // 외부 복원 (서버 재시작 시나리오)
  runtime.restoreStateVersion('V-RESTORED')
  assertDeepEqual(runtime.stateVersion, 'V-RESTORED', 'SV9: 복원된 버전')

  // 다음 submit 은 versionGen 으로 새 버전
  runtime.submit({ type: 'x' })
  assertDeepEqual(runtime.stateVersion, 'V-NEW', 'SV9: submit 후 새 버전 발급')
}

// SV10. restoreStateVersion(null) — null 복원 (빈 persistence)
{
  const fsm = makeFSM('f', 'a', [])
  const bus = makeFsmEventBus()
  const runtime = makeFSMRuntime({ fsm, bus, versionGen: () => 'X' })

  runtime.restoreStateVersion('v-1')  // 먼저 뭔가 복원
  runtime.restoreStateVersion(null)   // null 복원
  assertDeepEqual(runtime.stateVersion, null, 'SV10: null 로 복원')
}

summary()
