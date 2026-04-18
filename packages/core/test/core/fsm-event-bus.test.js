import { makeFsmEventBus } from '@presence/core/core/fsm/event-bus.js'
import { assert, assertDeepEqual, summary } from '../../../../test/lib/assert.js'

console.log('FsmEventBus tests')

// --- 기본 publish / subscribe ---

// B1. 단일 subscriber — 정확 topic
{
  const bus = makeFsmEventBus({ clock: () => 1000 })
  const received = []
  bus.subscribe('turn.started', (ev) => received.push(ev))
  const ret = bus.publish({ topic: 'turn.started', source: 'turnGate' })
  assert(received.length === 1, 'B1: subscriber 호출됨')
  assertDeepEqual(received[0], { topic: 'turn.started', source: 'turnGate', ts: 1000 },
    'B1: ts 주입됨')
  assertDeepEqual(ret, received[0], 'B1: publish 가 enriched 반환')
}

// B2. 다른 topic 은 구독자 없으면 호출 없음
{
  const bus = makeFsmEventBus()
  const received = []
  bus.subscribe('turn.started', (ev) => received.push(ev))
  bus.publish({ topic: 'other.topic' })
  assert(received.length === 0, 'B2: 매칭 없으면 호출 없음')
}

// B3. unsubscribe 동작
{
  const bus = makeFsmEventBus()
  const received = []
  const handler = (ev) => received.push(ev)
  const unsub = bus.subscribe('t', handler)
  bus.publish({ topic: 't', ts: 1 })
  unsub()
  bus.publish({ topic: 't', ts: 2 })
  assert(received.length === 1, 'B3: unsubscribe 후 호출 안 됨')
}

// --- ts 안전망 주입 ---

// T1. event.ts 가 이미 있으면 보존
{
  const bus = makeFsmEventBus({ clock: () => 999 })
  const received = []
  bus.subscribe('t', (ev) => received.push(ev))
  bus.publish({ topic: 't', ts: 42 })
  assertDeepEqual(received[0].ts, 42, 'T1: 기존 ts 보존')
}

// T2. event.ts 가 undefined 면 clock() 주입
{
  const bus = makeFsmEventBus({ clock: () => 123 })
  const received = []
  bus.subscribe('t', (ev) => received.push(ev))
  bus.publish({ topic: 't' })
  assertDeepEqual(received[0].ts, 123, 'T2: 누락 시 clock 주입')
}

// --- '*' wildcard ---

// W1. wildcard subscriber 는 모든 topic 을 받음
{
  const bus = makeFsmEventBus()
  const received = []
  bus.subscribe('*', (ev) => received.push(ev.topic))
  bus.publish({ topic: 'a', ts: 1 })
  bus.publish({ topic: 'b', ts: 2 })
  bus.publish({ topic: 'c', ts: 3 })
  assertDeepEqual(received, ['a', 'b', 'c'], 'W1: wildcard 는 모두 수신')
}

// W2. exact + wildcard 양쪽 구독 시 각각 호출
{
  const bus = makeFsmEventBus()
  let exactCount = 0, wildCount = 0
  bus.subscribe('t', () => exactCount++)
  bus.subscribe('*', () => wildCount++)
  bus.publish({ topic: 't', ts: 1 })
  assert(exactCount === 1, 'W2: exact 호출됨')
  assert(wildCount === 1, 'W2: wildcard 호출됨')
}

// W3. 동일 fn 을 exact + wildcard 양쪽에 등록 시 각각 호출 (P3 결정)
{
  const bus = makeFsmEventBus()
  let count = 0
  const handler = () => count++
  bus.subscribe('t', handler)
  bus.subscribe('*', handler)
  bus.publish({ topic: 't', ts: 1 })
  assert(count === 2, 'W3: 동일 fn 이 exact+wildcard 둘 다 호출')
}

// --- publish 중 unsubscribe ---

// U1. subscriber 가 publish 중 자신을 unsubscribe — 현재 publish 에는 포함, 다음엔 제외
{
  const bus = makeFsmEventBus()
  const received = []
  let unsub
  const handler = (ev) => {
    received.push(ev.topic)
    unsub()
  }
  unsub = bus.subscribe('t', handler)
  bus.publish({ topic: 't', ts: 1 })
  bus.publish({ topic: 't', ts: 2 })
  assert(received.length === 1, 'U1: unsubscribe 후 재호출 없음')
}

// U2. publish 중 다른 subscriber 를 unsubscribe — snapshot 으로 인해 현재는 호출됨
{
  const bus = makeFsmEventBus()
  const received = []
  let unsubB
  const handlerA = () => { unsubB() }
  const handlerB = () => received.push('B')
  bus.subscribe('t', handlerA)
  unsubB = bus.subscribe('t', handlerB)
  bus.publish({ topic: 't', ts: 1 })
  assert(received.length === 1, 'U2: A 가 B 를 unsub 해도 snapshot 의 B 는 호출됨')
  bus.publish({ topic: 't', ts: 2 })
  assert(received.length === 1, 'U2: 다음 publish 부터 B 제외됨')
}

// --- F1 subscriber 에러 격리 ---

// F1-a. subscriber 가 throw 해도 다음 subscriber 호출
{
  const errors = []
  const bus = makeFsmEventBus({
    onError: (err, target) => errors.push({ err, target }),
  })
  const received = []
  const thrower = () => { throw new Error('boom') }
  const follower = (ev) => received.push(ev.topic)
  bus.subscribe('t', thrower)
  bus.subscribe('t', follower)
  bus.publish({ topic: 't', ts: 1 })
  assert(received.length === 1, 'F1-a: thrower 이후 follower 정상 호출')
  assert(errors.length === 1, 'F1-a: onError 1회 호출')
  assertDeepEqual(errors[0].err.message, 'boom', 'F1-a: err 인자')
  assert(errors[0].target === thrower, 'F1-a: target = 실패한 subscriber')
}

// F1-b. onError 자체가 throw 해도 publish 계속
{
  const bus = makeFsmEventBus({
    onError: () => { throw new Error('onError boom') },
  })
  const received = []
  const thrower = () => { throw new Error('boom') }
  const follower = (ev) => received.push(ev.topic)
  bus.subscribe('t', thrower)
  bus.subscribe('t', follower)
  let publishThrew = false
  try { bus.publish({ topic: 't', ts: 1 }) } catch { publishThrew = true }
  assert(!publishThrew, 'F1-b: onError throw 해도 publish 예외 없음')
  assert(received.length === 1, 'F1-b: follower 호출 유지')
}

// --- F2 depth overflow ---

// F2-a. 재진입 depth 가 MAX_DEPTH 초과 시 publish no-op + onError
{
  const errors = []
  const bus = makeFsmEventBus({
    maxDepth: 3,
    onError: (err, target) => errors.push({ err: err.message, target }),
  })
  let called = 0
  bus.subscribe('t', () => {
    called++
    bus.publish({ topic: 't', ts: 1 })  // 재귀 publish
  })
  bus.publish({ topic: 't', ts: 0 })
  assert(called === 3, 'F2-a: depth 3 에서 정지')
  assert(errors.length === 1, 'F2-a: overflow 1회 onError')
  assert(errors[0].err.includes('reentry depth'), 'F2-a: overflow err 메시지')
  assert(errors[0].target === null, 'F2-a: target null')
}

// F2-b. overflow 이후에도 depth 회복 → 다시 publish 정상
{
  const bus = makeFsmEventBus({ maxDepth: 2 })
  let called = 0
  bus.subscribe('t', () => { called++ })
  // 재진입 없이 publish 두 번 → 각 depth 0 → 정상
  bus.publish({ topic: 't', ts: 1 })
  bus.publish({ topic: 't', ts: 2 })
  assert(called === 2, 'F2-b: 별개 publish 2회 정상')
}

// --- F7 malformed event ---

// F7-a. topic 누락 → onError + skip
{
  const errors = []
  const bus = makeFsmEventBus({
    onError: (err) => errors.push(err.message),
  })
  const received = []
  bus.subscribe('*', (ev) => received.push(ev))
  const ret = bus.publish({ payload: 1 })
  assert(ret === null, 'F7-a: 반환 null')
  assert(received.length === 0, 'F7-a: subscriber 호출 없음')
  assert(errors.length === 1 && errors[0].includes('missing topic'),
    'F7-a: onError missing topic')
}

// F7-b. topic 이 빈 문자열도 거절
{
  const errors = []
  const bus = makeFsmEventBus({ onError: (err) => errors.push(err.message) })
  bus.publish({ topic: '' })
  assert(errors.length === 1 && errors[0].includes('missing topic'),
    'F7-b: 빈 문자열도 missing topic')
}

// F7-c. event 자체가 null/undefined
{
  const errors = []
  const bus = makeFsmEventBus({ onError: (err) => errors.push(err.message) })
  bus.publish(null)
  bus.publish(undefined)
  assert(errors.length === 2, 'F7-c: null/undefined 둘 다 onError')
}

// --- 반환값 ---

// R1. publish 가 drop (topic 누락 / overflow) 시 null 반환
{
  const bus = makeFsmEventBus({ maxDepth: 1 })
  const malformed = bus.publish({})
  assert(malformed === null, 'R1: malformed → null')

  // overflow 유도
  let overflowReturn
  bus.subscribe('t', () => {
    overflowReturn = bus.publish({ topic: 't', ts: 1 })
  })
  bus.publish({ topic: 't', ts: 0 })
  assert(overflowReturn === null, 'R1: overflow → null')
}

// R2. 정상 publish 시 enriched 객체 반환
{
  const bus = makeFsmEventBus({ clock: () => 555 })
  const ret = bus.publish({ topic: 't' })
  assertDeepEqual(ret, { topic: 't', ts: 555 }, 'R2: enriched 반환')
}

summary()
