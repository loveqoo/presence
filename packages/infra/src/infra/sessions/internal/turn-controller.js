import { forkTask } from '@presence/core/lib/task.js'
import { STATE_PATH, HISTORY_TAG } from '@presence/core/core/policies.js'
import { t } from '../../../i18n/index.js'

// =============================================================================
// TurnController: 턴 실행 제어.
// approve channel, abort signal, input 직렬화를 캡슐화.
//
// history write 는 하지 않는다. 모든 SYSTEM entry append 는 turnLifecycle 을 통해
// 중앙화된다 (INV-SYS-2, INV-SYS-3).
// =============================================================================

class TurnController {
  constructor(state, logger, resolveTurnActor, turnLifecycle) {
    this.state = state
    this.logger = logger
    this.resolveTurnActor = resolveTurnActor
    this.turnLifecycle = turnLifecycle
    this.approveResolve = null
    this.approveDescription = null
    this.interactive = false
    this.turnAbort = null
  }

  // --- Approve channel ---

  onApprove(description) {
    if (!this.interactive) {
      this.logger.warn(t('error.approve_rejected_bg'), { description })
      return false
    }
    return new Promise(resolve => {
      this.approveResolve = resolve
      this.approveDescription = description
      this.state.set(STATE_PATH.APPROVE, { description })
    })
  }

  handleApproveResponse(approved) {
    if (!this.approveResolve) return
    const description = this.approveDescription || ''
    this.approveResolve(approved)
    this.approveResolve = null
    this.approveDescription = null
    this.state.set(STATE_PATH.APPROVE, null)

    // approve/reject 결과를 history 에 SYSTEM entry 로 기록 (INV-SYS-3)
    if (this.turnLifecycle) {
      const key = approved ? 'history.approve_notice' : 'history.reject_notice'
      this.turnLifecycle.appendSystemEntrySync(this.state, {
        content: t(key, { description }),
        tag: approved ? HISTORY_TAG.APPROVE : HISTORY_TAG.REJECT,
      })
    }
  }

  // --- Abort signal ---

  getAbortSignal() { return this.turnAbort?.signal }

  isAborted() {
    return !!(this.turnAbort && this.turnAbort.signal.aborted)
  }

  handleCancel() {
    // turnState 가 working 인 동안만 abort 신호가 의미를 갖는다.
    // handleInput 의 finally 보다 applyFinalState(turnState=idle) 가 먼저 실행되므로,
    // turnState 가 idle 이면 Free 프로그램이 이미 완료 → abort() 는 no-op →
    // markLastTurnCancelledSync 경로로 진입해야 한다 (race condition 방지).
    const turnState = this.state.get(STATE_PATH.TURN_STATE)
    const stillWorking = turnState?.tag === 'working'

    if (stillWorking && this.turnAbort && !this.turnAbort.signal.aborted) {
      // 진행 중 턴: abort 신호만 전송. SYSTEM entry 기록은 executor.recover 에서.
      this.turnAbort.abort()
      this.logger.info('Turn cancelled by user')
      return
    }
    // 턴 이미 완료 또는 working 아님: 가장 최근 turn entry 에 cancelled 플래그 (INV-CNC-1).
    if (!this.turnLifecycle) return
    const before = this.state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
    this.turnLifecycle.markLastTurnCancelledSync(this.state)
    if (this.state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY) !== before) {
      this.logger.info('Last turn entry marked as cancelled')
    }
  }

  // --- Approve 정리 ---

  resetApprove() {
    if (!this.approveResolve) return
    this.approveResolve(false)
    this.approveResolve = null
    this.approveDescription = null
    this.state.set(STATE_PATH.APPROVE, null)
  }

  // --- Input 처리 ---

  async handleInput(input) {
    this.interactive = true
    this.turnAbort = new AbortController()
    try {
      return await forkTask(this.resolveTurnActor().run(input))
    } catch (err) {
      this.logger.error('Turn failed', { error: err.message })
      throw err
    } finally {
      // abort() 가 호출됐지만 executor.recover 에 도달하지 못한 경우
      // (Free 가 완료된 뒤 cancel 도착, 또는 applyFinalState 진행 중 cancel 도착).
      // recordAbortSync 가 이미 새 cancelled entry 를 만들었으면 markLastTurnCancelled 는 no-op.
      const abortedPostCompletion = this.turnAbort?.signal.aborted
      this.turnAbort = null
      this.interactive = false
      this.resetApprove()
      if (abortedPostCompletion && this.turnLifecycle) {
        this.turnLifecycle.markLastTurnCancelledSync(this.state)
      }
    }
  }
}

export { TurnController }
