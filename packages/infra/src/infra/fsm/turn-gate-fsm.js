// =============================================================================
// turnGateFSM — 세션의 turnState 축 (idle / working / cancelling)
//
// 설계: docs/design/fsm.md §D13, §8.1
//
// Phase 1 실전 use case. 이 FSM 은 현재 세션의 turnState 한 축만 담당.
// approve / delegate / connection 등 다른 직교 축은 Phase 3 에서 별도 FSM 으로
// 정의 후 product 로 합성될 예정 (sessionFSM = product({...})).
//
// 주의: 이 파일은 FSM 의 "논리적 도메인 모델" 이다. 실제 runtime 의
// reactiveState.turnState 관찰 일치는 Phase 4 swap 시점에 확정된다.
// =============================================================================

import { Transition, makeFSM } from '@presence/core/core/fsm/fsm.js'

const transitions = [
  // Accept paths
  Transition({ from: 'idle',       on: 'chat',           to: 'working',    emit: [{ topic: 'turn.started' }] }),
  Transition({ from: 'working',    on: 'cancel',         to: 'cancelling', emit: [{ topic: 'cancel.requested' }] }),
  Transition({ from: 'working',    on: 'complete',       to: 'idle',       emit: [{ topic: 'turn.completed' }] }),
  Transition({ from: 'working',    on: 'failure',        to: 'idle',       emit: [{ topic: 'turn.failed' }] }),
  Transition({ from: 'cancelling', on: 'abort_complete', to: 'idle',       emit: [{ topic: 'turn.cancelled' }] }),

  // Explicit rejections
  Transition({ from: 'working',    on: 'chat',   reject: 'session-busy' }),
  Transition({ from: 'cancelling', on: 'chat',   reject: 'cancelling-in-progress' }),
  Transition({ from: 'cancelling', on: 'cancel', reject: 'already-cancelling' }),
]

const turnGateFSM = makeFSM('turnGate', 'idle', transitions)

export { turnGateFSM }
