import fp from '@presence/core/lib/fun-fp.js'

const { Maybe } = fp

// --- Delegation 상태 enum (wire/trace 직렬화 호환 위해 값은 string) ---
const DelegationStatus = Object.freeze({
  COMPLETED: 'completed',
  SUBMITTED: 'submitted',
  FAILED: 'failed',
})

// --- 위임 실행 경로 enum. AgentEntry.type과 Delegation.mode에서 공용 ---
//   LOCAL  — in-process run() 호출
//   REMOTE — A2A HTTP 등 외부 transport
const DelegationMode = Object.freeze({
  LOCAL: 'local',
  REMOTE: 'remote',
})

// =============================================================================
// Delegation — 에이전트 위임 결과 3원 sum type. Transport-agnostic.
//
//   Completed(target, output, mode) — 작업 완료, output 보유 (종료 상태)
//   Submitted(target, taskId, mode) — 비동기 진행 중, 폴링 필요 (리모트 전용)
//   Failed   (target, error, mode)  — 실패, 사유 보유 (종료 상태)
//
// 로컬 위임(in-process run())은 completed/failed만 사용.
// 리모트 위임(A2A HTTP 등)은 3상태 전부 사용.
// 3상태 설계는 A2A TaskState 모델에서 차용 — 다른 비동기 transport도 재사용 가능.
//
// 공통 필드: target, mode. 각 생성자는 자기 상태의 필드만 소유 —
// "illegal states unrepresentable" 원칙.
//
// 공통 질의 (다형성): isTerminal/isPending/asOutput/asTaskId/asError.
//   새 상태 추가 시 기본값으로 안전하게 대답 → 호출처 안 깨짐.
// 상태별 분기: match({completed, submitted, failed}).
//   핸들러 누락 시 런타임 예외 → 새 상태 추가 시 호출처가 강제 업데이트.
//
// 소비측 선택 기준:
//   - "종료됐나? 출력이 뭐지?" (공통) → 다형성 메서드
//   - "이 상태일 때만 정확히 이걸 한다"  → match
// =============================================================================

class Delegation {
  constructor(target, mode) {
    this.target = target
    this.mode = mode
  }

  // status는 서브클래스가 고정값으로 노출. 기존 `result.status === '...'` API 호환.
  get status() { throw new Error('Delegation.status: abstract') }

  // 공통 질의 (기본값 — 해당 상태만 override)
  isCompleted() { return false }
  isSubmitted() { return false }
  isFailed()    { return false }
  isTerminal()  { return false }
  isPending()   { return false }
  asOutput()    { return Maybe.Nothing() }
  asTaskId()    { return Maybe.Nothing() }
  asError()     { return Maybe.Nothing() }

  // 총망라 패턴 매칭 — 누락 시 런타임 예외로 호출처 업데이트 강제
  match(cases) {
    const handler = cases[this.status]
    if (!handler) {
      throw new Error(`Delegation.match: missing handler for '${this.status}'. Got: [${Object.keys(cases).join(',')}]`)
    }
    return handler(this)
  }

  // --- static factories ---
  static completed(target, output, mode = DelegationMode.LOCAL)  { return new Completed(target, output, mode) }
  static submitted(target, taskId, mode = DelegationMode.REMOTE) { return new Submitted(target, taskId, mode) }
  static failed(target, error, mode = null)                       { return new Failed(target, error, mode) }

  // --- static match: Delegation 인스턴스뿐 아니라 plain {status,...} 객체에도 동작.
  // 직렬화 경계(trace 등)를 넘은 후에도 총망라 매칭을 쓸 수 있게 한다.
  static match(result, cases) {
    const handler = cases[result.status]
    if (!handler) {
      throw new Error(`Delegation.match: missing handler for '${result.status}'. Got: [${Object.keys(cases).join(',')}]`)
    }
    return handler(result)
  }
}

class Completed extends Delegation {
  constructor(target, output, mode = DelegationMode.LOCAL) {
    super(target, mode)
    this.output = output
  }
  get status() { return DelegationStatus.COMPLETED }
  isCompleted() { return true }
  isTerminal()  { return true }
  asOutput()    { return Maybe.Just(this.output) }
}

class Submitted extends Delegation {
  constructor(target, taskId, mode = DelegationMode.REMOTE) {
    super(target, mode)
    this.taskId = taskId
  }
  get status() { return DelegationStatus.SUBMITTED }
  isSubmitted() { return true }
  isPending()   { return true }
  asTaskId()    { return Maybe.Just(this.taskId) }
}

class Failed extends Delegation {
  constructor(target, error, mode = null) {
    super(target, mode)
    this.error = error
  }
  get status() { return DelegationStatus.FAILED }
  isFailed()   { return true }
  isTerminal() { return true }
  asError()    { return Maybe.Just(this.error) }
}

/**
 * `Delegation` — 3-state sum type for agent delegation outcomes (transport-agnostic).
 * Factories: `.completed(target, output, mode)`, `.submitted(target, taskId, mode)`, `.failed(target, error, mode)`.
 * Polymorphic API: `isTerminal/isPending/asOutput/asTaskId/asError`.
 * Exhaustive dispatch: `result.match({ completed, submitted, failed })`.
 */
export { Delegation, DelegationStatus, DelegationMode }
