import { HISTORY, STATE_PATH, EVENT_TYPE } from '@presence/core/core/policies.js'
import { SYSTEM_JOBS } from '../../constants.js'
import { fireAndForget } from '@presence/core/lib/task.js'
import { memoryActorR } from '../../actors/memory-actor.js'
import { CompactionActor, compactionActorR } from '../../actors/compaction-actor.js'
import { turnActorR } from '../../actors/turn-actor.js'
import { eventActorR } from '../../actors/event-actor.js'
import { budgetActorR } from '../../actors/budget-actor.js'
import { delegateActorR } from '../../actors/delegate-actor.js'
import { dispatchResponse } from '../../a2a/a2a-response-dispatcher.js'

// =============================================================================
// SessionActors: 세션에 필요한 Actor 생성 + compaction 구독.
// persistenceActor는 외부에서 주입 (세션 유형별로 다름).
// =============================================================================

class SessionActors {
  constructor(opts) {
    const { userContext, state, logger, persistenceActor, agentId, turnLifecycle, turnController, delegateRuntime, dispatchTurn, onScheduledJobDone } = opts
    // --- Turn 라이프사이클 (Session 이 주입한 단일 인스턴스) ---
    this.turnLifecycle = turnLifecycle
    this.turnController = turnController

    // A2A Phase 1 S1+S2 — receiver 측 queue 전이 + response dispatch 용 참조.
    this.a2aQueueStore = userContext.a2aQueueStore ?? null
    this.sessionManager = userContext.sessions ?? null

    // --- 메모리/압축 Actor ---
    // memoryActorR 는 agentId 로 mem0 격리. compactionActorR 는 extra field 무시하고 llm 만 사용.
    const sessionEnv = { memory: userContext.memory, agentId, logger, llm: userContext.llm, state }
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
      // A2A S1: markProcessing hook — drain 시작 전 a2a_request 이벤트는 queue row 전이 시도.
      //         false = 이미 processing/completed/failed/expired → skipDuplicateA2aRequest.
      a2aQueueStore: this.a2aQueueStore,
      // A2A S2: turnLifecycle — a2a_response drain 시 SYSTEM entry 추가용.
      //         SessionActors 가 주입한 turnLifecycle 을 그대로 전파.
      turnLifecycle: this.turnLifecycle,
      onEventDone: (event, outcome) => this.handleEventDone(event, outcome, {
        onScheduledJobDone,
        a2aQueueStore: this.a2aQueueStore,
        sessionManager: this.sessionManager,
        logger,
      }),
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

  // --- Event 완료 콜백 (type 별 분기) ---

  handleEventDone(event, outcome, deps) {
    const { success, result, error } = outcome
    const onScheduledJobDone = deps?.onScheduledJobDone
    const a2aQueueStore = deps?.a2aQueueStore
    const sessionManager = deps?.sessionManager
    const logger = deps?.logger
    if (event.type === EVENT_TYPE.SCHEDULED_JOB) {
      // scheduled_job: 기존 콜백 경로. 다른 type 과 분리.
      if (onScheduledJobDone) onScheduledJobDone(event, { success, result, error })
      return
    }
    if (event.type === EVENT_TYPE.A2A_REQUEST) {
      // A2A S1+S2: turn 성공/실패에 따라 queue 전이 + sender 에게 response 발행.
      if (!a2aQueueStore || !event.requestId) return
      const request = a2aQueueStore.getMessage(event.requestId)
      if (!request) return  // row 사라짐 (방어)
      const dispatchOpts = { a2aQueueStore, sessionManager, logger, request }
      if (success) {
        // markCompleted=false → expire tick 이 먼저 markExpired 한 race. 중복 response 방지로 skip.
        if (!a2aQueueStore.markCompleted(event.requestId)) return
        dispatchResponse({ ...dispatchOpts, status: 'completed', payload: result, error: null })
          .catch(err => logger?.warn?.('dispatchResponse threw (completed)', { error: err?.message }))
      } else {
        const errorMsg = String(error ?? 'agent-error')
        if (!a2aQueueStore.markFailed(event.requestId, errorMsg)) return
        dispatchResponse({ ...dispatchOpts, status: 'failed', payload: null, error: errorMsg })
          .catch(err => logger?.warn?.('dispatchResponse threw (failed)', { error: err?.message }))
      }
      return
    }
    // 다른 type (todo_review, a2a_response 등) 은 EventActor 내부에서 처리 완료 — 여기선 no-op.
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
