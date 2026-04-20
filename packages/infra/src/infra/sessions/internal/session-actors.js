import { HISTORY, STATE_PATH } from '@presence/core/core/policies.js'
import { SYSTEM_JOBS } from '../../constants.js'
import { fireAndForget } from '@presence/core/lib/task.js'
import { memoryActorR } from '../../actors/memory-actor.js'
import { CompactionActor, compactionActorR } from '../../actors/compaction-actor.js'
import { turnActorR } from '../../actors/turn-actor.js'
import { eventActorR } from '../../actors/event-actor.js'
import { budgetActorR } from '../../actors/budget-actor.js'
import { delegateActorR } from '../../actors/delegate-actor.js'

// =============================================================================
// SessionActors: 세션에 필요한 Actor 생성 + compaction 구독.
// persistenceActor는 외부에서 주입 (세션 유형별로 다름).
// =============================================================================

class SessionActors {
  constructor(opts) {
    const { userContext, state, logger, persistenceActor, userId, turnLifecycle, turnController, delegateRuntime, dispatchTurn, onScheduledJobDone } = opts
    // --- Turn 라이프사이클 (Session 이 주입한 단일 인스턴스) ---
    this.turnLifecycle = turnLifecycle
    this.turnController = turnController

    // --- 메모리/압축 Actor ---
    const sessionEnv = { memory: userContext.memory, userId, logger, llm: userContext.llm, state }
    this.memoryActor = memoryActorR.run(sessionEnv)
    this.compactionActor = compactionActorR.run(sessionEnv)
    this.persistenceActor = persistenceActor

    this.subscribeCompaction(state, logger)

    // --- 턴 직렬화 Actor ---
    this.turnActor = turnActorR.run({ runTurn: dispatchTurn })

    // --- 이벤트/예산/위임 Actor ---
    this.eventActor = eventActorR.run({
      turnActor: this.turnActor, state, logger,
      todoReviewJobName: SYSTEM_JOBS.TODO_REVIEW,
      userDataStore: userContext.userDataStore,
      onEventDone: (event, outcome) => this.handleEventDone(event, outcome, onScheduledJobDone),
    })

    this.budgetActor = budgetActorR.run({ state })
    this.delegateActor = delegateActorR.run({
      state, eventActor: this.eventActor,
      agentRegistry: userContext.agentRegistry, logger,
      pollIntervalMs: userContext.config.delegatePolling.intervalMs,
      delegateRuntime,
    })
  }

  // --- Compaction 결과 → conversationHistory 반영 ---

  subscribeCompaction(state, logger) {
    this.compactionActor.subscribe((result) => {
      if (result === CompactionActor.RESULT.SKIP) return
      const { summary, extractedIds, epoch } = result
      const currentEpoch = state.get(STATE_PATH.COMPACTION_EPOCH) || 0
      if (epoch !== undefined && epoch !== currentEpoch) {
        logger.info('Compaction result discarded (epoch mismatch)')
        return
      }
      const current = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY) || []
      const filtered = current.filter(item => !item.id || !extractedIds.has(item.id))
      const merged = [summary, ...filtered]
      const trimmed = merged.length > HISTORY.MAX_CONVERSATION
        ? [merged[0], ...merged.slice(-(HISTORY.MAX_CONVERSATION - 1))]
        : merged
      state.set(STATE_PATH.CONTEXT_CONVERSATION_HISTORY, trimmed)
    })
  }

  // --- Scheduled job 완료 콜백 ---

  handleEventDone(event, { success, result, error }, onScheduledJobDone) {
    if (event.type !== 'scheduled_job') return
    if (onScheduledJobDone) {
      onScheduledJobDone(event, { success, result, error })
    }
  }

  // --- Agent에 전달할 actors 묶음 ---

  forAgent(logger) {
    return {
      memoryActor: this.memoryActor,
      compactionActor: this.compactionActor,
      persistenceActor: this.persistenceActor,
      turnLifecycle: this.turnLifecycle,
      // executor.recover 가 abort 판별에 사용. 순환 참조 회피 위해 콜백 형태.
      isAborted: () => !!(this.turnController && this.turnController.isAborted()),
      logger,
    }
  }

  // --- Shutdown ---

  shutdown() {
    fireAndForget(this.delegateActor.stop())
  }
}

export { SessionActors }
