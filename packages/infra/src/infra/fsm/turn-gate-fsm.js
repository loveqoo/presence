// =============================================================================
// turnGateFSM — 세션의 turnState 축 (idle / working / cancelling)
//
// 설계: docs/design/fsm.md §D13, §8.1 + Phase 4 플랜
//
// 이 FSM 은 현재 세션의 turnState 한 축만 담당. approve / delegate /
// connection 등 다른 직교 축은 다음 phase 에서 별도 FSM 으로 정의 후
// product 로 합성될 예정.
//
// 상태 shape: TurnState ADT 를 직접 사용 (`packages/core/src/core/policies.js:29`).
//   - TurnState.idle()                = { tag: 'idle' }
//   - TurnState.working(input)        = { tag: 'working', input }
//   - cancelling 은 PHASE 에 없는 FSM 내부 전용 태그.
//     `{ tag: 'cancelling', input }` — bridge 가 projection 시 working 으로 매핑.
//
// emit payload 에는 구독자가 그대로 reactiveState 에 쓸 수 있는 turnState 값
// (+ 필요한 side-effect 신호) 를 담는다. bridge 는 dumb forwarder.
// =============================================================================

import { Transition, makeFSM } from '@presence/core/core/fsm/fsm.js'
import { TurnState } from '@presence/core/core/policies.js'

// FSM 내부 전용 cancelling 태그. PHASE 에 추가하지 않는 이유: 외부 소비자 (10곳)
// 는 tag === 'working' / 'idle' 만 체크하므로 wire format 유지.
const CANCELLING = 'cancelling'
const cancelling = (input) => ({ tag: CANCELLING, input })

const isIdle       = (s) => s && s.tag === 'idle'
const isWorking    = (s) => s && s.tag === 'working'
const isCancelling = (s) => s && s.tag === CANCELLING

const transitions = [
  // --- Accept paths ---

  // idle + chat → working(input)
  Transition({
    from: isIdle,
    on: 'chat',
    to: (s, c) => TurnState.working(c.payload?.input),
    emit: (s, c) => [{
      topic: 'turn.started',
      payload: { turnState: TurnState.working(c.payload?.input) },
    }],
  }),

  // working + cancel → cancelling(input). abort 신호 + projection 유지 (bridge 가 working 그대로)
  Transition({
    from: isWorking,
    on: 'cancel',
    to: (s) => cancelling(s.input),
    emit: (s) => [{
      topic: 'cancel.requested',
      payload: { turnState: cancelling(s.input), abort: true },
    }],
  }),

  // working + complete → idle
  Transition({
    from: isWorking,
    on: 'complete',
    to: () => TurnState.idle(),
    emit: [{ topic: 'turn.completed', payload: { turnState: TurnState.idle() } }],
  }),

  // working + failure → idle
  Transition({
    from: isWorking,
    on: 'failure',
    to: () => TurnState.idle(),
    emit: [{ topic: 'turn.failed', payload: { turnState: TurnState.idle() } }],
  }),

  // cancelling + abort_complete → idle
  Transition({
    from: isCancelling,
    on: 'abort_complete',
    to: () => TurnState.idle(),
    emit: [{ topic: 'turn.cancelled', payload: { turnState: TurnState.idle() } }],
  }),

  // working + abort_complete → idle (handleCancel 없이 외부 abort 되는 방어 경로)
  // 예: LLM SDK 자체 abort, 외부 SIGTERM 등. cancelling 을 거치지 않은 abort 도 idle 로 수렴.
  Transition({
    from: isWorking,
    on: 'abort_complete',
    to: () => TurnState.idle(),
    emit: [{ topic: 'turn.cancelled', payload: { turnState: TurnState.idle() } }],
  }),

  // --- Explicit rejections ---
  Transition({ from: isWorking,    on: 'chat',   reject: 'session-busy' }),
  Transition({ from: isCancelling, on: 'chat',   reject: 'cancelling-in-progress' }),
  Transition({ from: isCancelling, on: 'cancel', reject: 'already-cancelling' }),
]

const turnGateFSM = makeFSM('turnGate', TurnState.idle(), transitions)

export { turnGateFSM, CANCELLING, cancelling }
