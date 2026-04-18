import { Session } from './session.js'
import { ephemeralInits } from './internal/ephemeral-inits.js'

// =============================================================================
// EphemeralSession: 일회성 세션 (SCHEDULED, AGENT 공통).
// Session 알고리즘의 기본 구현. persistence 없음, scheduler 없음.
//
// init 단계는 복잡도 억제를 위해 `ephemeralInits` 로 분리되어 prototype 에 부착.
// UserSession 등 파생 클래스는 기존대로 메서드를 override 할 수 있다.
// =============================================================================

class EphemeralSession extends Session {
  // --- Public 인터페이스 (turnController / actors 위임) ---

  async handleInput(input) { return this.turnController.handleInput(input) }
  handleApproveResponse(approved) { this.turnController.handleApproveResponse(approved) }
  handleCancel() { this.turnController.handleCancel() }
  emit(event) { return this.actors.eventActor.emit(event) }

  get tools() { return this.getTools() }
  get eventActor() { return this.actors.eventActor }
  get delegateActor() { return this.actors.delegateActor }
  get schedulerActor() { return null }

  shutdownActors() { this.actors.shutdown() }
  clearTimers() { this.idleMonitor.clearTimer() }
}

// init 메서드들을 prototype 에 부착. Session 의 Template Method 가 this.initX() 를
// 호출할 때 이 메서드들이 해석된다. UserSession 이 override 시 class 메서드가 우선.
Object.assign(EphemeralSession.prototype, ephemeralInits)

export { EphemeralSession }
