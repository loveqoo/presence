import { forkTask } from '@presence/core/lib/task.js'
import { STATE_PATH } from '@presence/core/core/policies.js'
import { t } from '../../../i18n/index.js'

// =============================================================================
// TurnController: 턴 실행 제어.
// approve channel, abort signal, input 직렬화를 캡슐화.
// =============================================================================

class TurnController {
  constructor(state, logger, resolveTurnActor) {
    this.state = state
    this.logger = logger
    this.resolveTurnActor = resolveTurnActor
    this.approveResolve = null
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
      this.state.set(STATE_PATH.APPROVE, { description })
    })
  }

  handleApproveResponse(approved) {
    if (!this.approveResolve) return
    this.approveResolve(approved)
    this.approveResolve = null
    this.state.set(STATE_PATH.APPROVE, null)
  }

  // --- Abort signal ---

  getAbortSignal() { return this.turnAbort?.signal }

  handleCancel() {
    // 턴 실행 중: abort signal 로 중단 시도
    if (this.turnAbort && !this.turnAbort.signal.aborted) {
      this.turnAbort.abort()
      this.logger.info('Turn cancelled by user')
      return
    }
    // 턴 이미 완료: 마지막 history entry 에 cancelled 태그
    this.markLastEntryCancelled()
  }

  markLastEntryCancelled() {
    const history = this.state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY)
    if (!Array.isArray(history) || history.length === 0) return
    const last = history[history.length - 1]
    if (last.cancelled) return
    const updated = [...history.slice(0, -1), { ...last, cancelled: true }]
    this.state.set(STATE_PATH.CONTEXT_CONVERSATION_HISTORY, updated)
    this.logger.info('Last history entry marked as cancelled')
  }

  // --- Approve 정리 ---

  resetApprove() {
    if (!this.approveResolve) return
    this.approveResolve(false)
    this.approveResolve = null
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
      this.turnAbort = null
      this.interactive = false
      this.resetApprove()
    }
  }
}

export { TurnController }
