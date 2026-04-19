// =============================================================================
// delegateFSM — 세션의 위임 (delegate) 축 (idle / delegating)
//
// 설계: plan purring-beaming-horizon Phase 7
//
// turnGate / approve 와 직교 축. 단순 추적 용도 — "지금 pending delegation 이
// 있는가" flag + count. reactiveState.DELEGATES_PENDING 배열 관리는 기존
// delegate-actor 가 유지 (이번 phase 에서 delegate-actor 는 수정 안 함).
//
// SessionFSM 합성 (다음 phase) 시 세 번째 축으로 참여할 수 있도록 인터페이스만
// 준비. 실제 delegate-actor 와의 통합 (submit/resolve 호출) 은 이후 phase.
//
// State shape (TurnState ADT 패턴):
//   - { tag: 'idle' }
//   - { tag: 'delegating', count: N }
//
// Commands:
//   - submit    → 새 위임 등록 (count 증가)
//   - resolve   → 완료 (count 감소. 0 도달 시 idle)
//   - fail      → 실패 (count 감소)
//
// guard 로 "count > 1 → delegating 유지" / "count === 1 → idle" 분기.
// =============================================================================

import { Transition, makeFSM } from '@presence/core/core/fsm/fsm.js'

const DelegateState = Object.freeze({
  idle: () => ({ tag: 'idle' }),
  delegating: (count) => ({ tag: 'delegating', count }),
})

const isIdle = (s) => s && s.tag === 'idle'
const isDelegating = (s) => s && s.tag === 'delegating'

// count 하나 남았을 때 resolve/fail → idle 로 복귀
const lastPending = (s) => s && s.tag === 'delegating' && s.count === 1
const multiPending = (s) => s && s.tag === 'delegating' && s.count > 1

const transitions = [
  // --- Accept paths ---

  // idle + submit → delegating(1)
  Transition({
    from: isIdle,
    on: 'submit',
    to: () => DelegateState.delegating(1),
    emit: [{ topic: 'delegate.submitted', payload: { delegateState: DelegateState.delegating(1) } }],
  }),

  // delegating + submit → count + 1
  Transition({
    from: isDelegating,
    on: 'submit',
    to: (s) => DelegateState.delegating(s.count + 1),
    emit: (s) => [{
      topic: 'delegate.submitted',
      payload: { delegateState: DelegateState.delegating(s.count + 1) },
    }],
  }),

  // delegating(count=1) + resolve → idle
  Transition({
    from: lastPending,
    on: 'resolve',
    to: () => DelegateState.idle(),
    emit: [{ topic: 'delegate.resolved', payload: { delegateState: DelegateState.idle() } }],
  }),

  // delegating(count>1) + resolve → count - 1
  Transition({
    from: multiPending,
    on: 'resolve',
    to: (s) => DelegateState.delegating(s.count - 1),
    emit: (s) => [{
      topic: 'delegate.resolved',
      payload: { delegateState: DelegateState.delegating(s.count - 1) },
    }],
  }),

  // delegating(count=1) + fail → idle
  Transition({
    from: lastPending,
    on: 'fail',
    to: () => DelegateState.idle(),
    emit: [{ topic: 'delegate.failed', payload: { delegateState: DelegateState.idle() } }],
  }),

  // delegating(count>1) + fail → count - 1
  Transition({
    from: multiPending,
    on: 'fail',
    to: (s) => DelegateState.delegating(s.count - 1),
    emit: (s) => [{
      topic: 'delegate.failed',
      payload: { delegateState: DelegateState.delegating(s.count - 1) },
    }],
  }),

  // --- Explicit rejections ---

  // idle + resolve/fail — pending 없는데 완료 신호. 프로토콜 위반 방어.
  Transition({ from: isIdle, on: 'resolve', reject: 'no-pending-delegation' }),
  Transition({ from: isIdle, on: 'fail', reject: 'no-pending-delegation' }),
]

const delegateFSM = makeFSM('delegate', DelegateState.idle(), transitions)

export { delegateFSM, DelegateState }
