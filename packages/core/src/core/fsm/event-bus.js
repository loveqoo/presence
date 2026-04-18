// =============================================================================
// FsmEventBus — topic-based fanout, FSM emit 용 best-effort observer 채널
//
// 다음 컴포넌트와 직교 축. 혼동 금지:
// - HookBus    : state path pub/sub, state 변화 동기 관찰 (packages/infra/src/infra/states/state.js)
// - EventActor : async event queue, turnActor 연동 비동기 실행 (packages/infra/src/infra/actors/event-actor.js)
// - FsmEventBus: topic fanout. FSM 의 emit event 를 observer 에 전달. 동기. best-effort
//
// 설계: /Users/anthony/.claude/plans/purring-beaming-horizon.md (Phase 2)
//
// FP-RULE-EXCEPTION: approved in plan purring-beaming-horizon (fsm/ factory + actor boundary)
//   - mutable state encapsulation (subs Map, depth counter)
//   - factory DI pattern (make*({deps})) — Reader.asks 로 전환 의무 없음
// =============================================================================

const WILDCARD = '*'
const DEFAULT_MAX_DEPTH = 10

// onError 자체가 throw 해도 publish 흐름이 끊기지 않도록 최종 방어망.
const safeOnError = (onError, err, target) => {
  try { onError(err, target) } catch (_swallow) { /* F6 */ }
}

function makeFsmEventBus({
  clock = () => Date.now(),
  maxDepth = DEFAULT_MAX_DEPTH,
  onError = () => {},
} = {}) {
  const subs = new Map()
  let depth = 0

  const publish = (event) => {
    // F7: defensive — topic 누락 event 는 라우팅 불가
    if (!event || typeof event.topic !== 'string' || event.topic.length === 0) {
      safeOnError(onError, new Error('FsmEventBus: missing topic'), null)
      return null
    }
    // F2: reentry depth 제한 (HookBus MAX_DEPTH=10 선례)
    if (depth >= maxDepth) {
      safeOnError(onError, new Error('FsmEventBus: max reentry depth exceeded'), null)
      return null
    }
    const enriched = event.ts !== undefined ? event : { ...event, ts: clock() }

    // subscribers snapshot — publish 중 unsubscribe 허용
    const targets = []
    const exact = subs.get(enriched.topic)
    const wild = subs.get(WILDCARD)
    if (exact) for (const fn of exact) targets.push(fn)
    if (wild) for (const fn of wild) targets.push(fn)

    depth++
    try {
      for (const fn of targets) {
        // F1: per-subscriber 격리
        try { fn(enriched) } catch (err) { safeOnError(onError, err, fn) }
      }
    } finally {
      depth--
    }
    return enriched
  }

  const subscribe = (topic, fn) => {
    if (!subs.has(topic)) subs.set(topic, new Set())
    subs.get(topic).add(fn)
    return () => { subs.get(topic)?.delete(fn) }
  }

  return { publish, subscribe }
}

export { makeFsmEventBus, WILDCARD, DEFAULT_MAX_DEPTH }
