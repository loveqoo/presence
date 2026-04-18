// =============================================================================
// FSMRuntime — FSM state 보유 + command dispatch + event publication
//
// Phase 2 PoC. Actor 가 아니다 (packages/core/src/lib/fun-fp.js:2578 참고).
// 내부 큐 없음. Reentry serialization 없음. Observability 는 Either 가
// authoritative, FsmEventBus 는 best-effort observer.
//
// 설계: /Users/anthony/.claude/plans/purring-beaming-horizon.md (Phase 2)
//
// submit() 실행 흐름:
//   Phase A (commit, atomic):
//     1. enrichedCmd = { ...cmd, id ?? idGen(), ts ?? clock() } + freeze
//     2. step(fsm, state, enrichedCmd)
//     3. Right → state 갱신 (deepFreeze) + enrichedEvents 구성 + freeze
//        Left  → rejection 객체 구성 + freeze
//     4. Either 객체 확정 (freeze)
//   Phase B (publication, best-effort isolated):
//     outer try/catch 로 전체 감쌈. internal throw 는 silent swallow.
//     Right → events 각각 bus.publish
//     Left  → 'fsm.rejected' 토픽 publish
//
// FP-RULE-EXCEPTION: approved in plan purring-beaming-horizon (fsm/ factory + actor boundary)
// =============================================================================

import { randomUUID } from 'crypto'
import fp from '../../lib/fun-fp.js'
import { step } from './fsm.js'

const { Either } = fp

const REJECTION_TOPIC = 'fsm.rejected'

// plain object / array 만 재귀 freeze. class instance / Map / Set 은 top-level only.
// turnGateFSM 은 string state, product 는 {k: v} plain object map 이므로 Phase 2 FSM 에 충분.
const deepFreeze = (value) => {
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value
  Object.freeze(value)
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
  } else if (Object.getPrototypeOf(value) === Object.prototype) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

function makeFSMRuntime({
  fsm,
  initial,
  bus,
  clock = () => Date.now(),
  idGen = () => randomUUID(),
}) {
  if (!fsm) throw new Error('makeFSMRuntime: `fsm` required')
  if (!bus) throw new Error('makeFSMRuntime: `bus` required')

  let currentState = initial !== undefined ? initial : fsm.initial

  const submit = (cmd) => {
    // ── Phase A — commit (atomic) ──
    const enrichedCmd = Object.freeze({
      ...cmd,
      id: cmd.id ?? idGen(),
      ts: cmd.ts ?? clock(),
    })
    const result = step(fsm, currentState, enrichedCmd)

    let returnValue
    let publicationTask

    if (result.isRight()) {
      currentState = deepFreeze(result.value.state)
      const enrichedEvents = Object.freeze(result.value.events.map((ev) => Object.freeze({
        ...ev,
        source: ev.source ?? fsm.id,
        ts: ev.ts ?? clock(),
      })))
      returnValue = Either.Right(Object.freeze({
        state: currentState,
        events: enrichedEvents,
        command: enrichedCmd,
      }))
      publicationTask = () => {
        for (const ev of enrichedEvents) bus.publish(ev)
      }
    } else {
      const rejection = result.value
      returnValue = Either.Left(Object.freeze({
        ...rejection,
        command: enrichedCmd,
      }))
      publicationTask = () => {
        bus.publish({
          topic: REJECTION_TOPIC,
          ts: clock(),
          source: fsm.id,
          payload: {
            primaryReason: rejection.primaryReason,
            reasons: rejection.reasons,
            command: enrichedCmd,
          },
        })
      }
    }

    // ── Phase B — publication (best-effort, silent swallow per F6) ──
    try { publicationTask() } catch (_swallow) { /* Phase 2: runtime 레벨 reporting 없음 */ }

    return returnValue
  }

  return {
    get state() { return currentState },
    get fsm() { return fsm },
    submit,
  }
}

export { makeFSMRuntime, REJECTION_TOPIC, deepFreeze }
