import { fireAndForget } from '@presence/core/lib/task.js'
import { PHASE, STATE_PATH } from '@presence/core/core/policies.js'

// =============================================================================
// IdleMonitor: 세션 idle 상태 감시.
// turnState 변경에 반응하여 idle timeout, 이벤트 드레인, trace 초기화 수행.
// =============================================================================

class IdleMonitor {
  constructor(state, opts) {
    const { eventActor, delegateActor, budgetActor, resetTrace, idleTimeoutMs, onIdle } = opts
    this.state = state
    this.eventActor = eventActor
    this.delegateActor = delegateActor
    this.budgetActor = budgetActor
    this.resetTrace = resetTrace
    this.idleTimeoutMs = idleTimeoutMs
    this.onIdle = onIdle
    this.idleTimer = null

    this.bind()
  }

  bind() {
    this.state.hooks.on(STATE_PATH.TURN_STATE, (change) => {
      const phase = change.nextValue
      // idle 진입 시 이벤트 드레인 + 위임 폴링
      if (phase.tag === PHASE.IDLE) {
        fireAndForget(this.eventActor.drain())
        fireAndForget(this.delegateActor.poll())
        if (this.idleTimeoutMs && this.onIdle) {
          this.idleTimer = setTimeout(() => {
            const events = this.state.get(STATE_PATH.EVENTS)
            if (!events?.queue?.length && !events?.inFlight) this.onIdle()
          }, this.idleTimeoutMs)
        }
      } else {
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
      }
      // working 진입 시 trace 초기화
      if (phase.tag === PHASE.WORKING) {
        this.resetTrace()
        this.state.set(STATE_PATH.DEBUG_OP_TRACE, [])
      }
    })

    this.state.hooks.on(STATE_PATH.DEBUG_LAST_TURN, (change, stateRef) => {
      fireAndForget(this.budgetActor.check(change.nextValue, stateRef.get(STATE_PATH.TURN)))
    })
  }

  clearTimer() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
  }
}

export { IdleMonitor }
