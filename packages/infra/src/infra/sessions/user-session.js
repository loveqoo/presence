import { createPersistence, migrateHistoryIds } from '../persistence.js'
import { STATE_PATH, TODO } from '@presence/core/core/policies.js'
import { SYSTEM_JOBS } from '../constants.js'
import { fireAndForget, forkTask } from '@presence/core/lib/task.js'
import { persistenceActorR } from '../actors/persistence-actor.js'
import { createSchedulerActor } from '../actors/scheduler-actor.js'
import { calcNextRun } from '../jobs/job-tools.js'
import { createJobTools } from '../jobs/job-tools.js'
import { formatTodosAsLines, syncTodosProjection } from '../events.js'
import { EphemeralSession } from './ephemeral-session.js'

// =============================================================================
// UserSession: 사용자 대화 세션.
// EphemeralSession을 확장하여 persistence, scheduler, job 툴을 추가.
// =============================================================================

class UserSession extends EphemeralSession {

  // --- Persistence: 실제 디스크 저장 ---

  initPersistence(opts) {
    this.persistence = createPersistence(opts.persistenceCwd ? { cwd: opts.persistenceCwd } : {})
    this.persistenceActor = persistenceActorR.run({ store: this.persistence.store })
  }

  // --- State 복원: 디스크 → OriginState ---

  restoreState() {
    // TODO projection: snapshot 유무와 무관하게 항상 store → state 동기화
    syncTodosProjection(this.state, this.userContext.userDataStore)

    const restored = this.persistence.restore()
    if (!restored || typeof restored !== 'object') return
    try {
      if (typeof restored.turn === 'number') this.state.set(STATE_PATH.TURN, restored.turn)
      if (restored.context && typeof restored.context === 'object') {
        const migrated = migrateHistoryIds(restored.context.conversationHistory)
        this.state.set(STATE_PATH.CONTEXT, { ...restored.context, conversationHistory: migrated })
        this.state.set(STATE_PATH.COMPACTION_EPOCH, (this.state.get(STATE_PATH.COMPACTION_EPOCH) || 0) + 1)
      }
      this.logger.info(`State restored (turn: ${restored.turn || 0})`)
    } catch (err) {
      this.logger.warn('State restore failed, starting fresh', { error: err.message })
    }
  }

  // --- Job 완료: 로컬 scheduler에 결과 전달 ---

  resolveJobDoneHandler(opts) {
    return opts.onScheduledJobDone || ((event, outcome) => this.notifyScheduler(event, outcome))
  }

  notifyScheduler(event, outcome) {
    if (!this.localSchedulerActor) return
    const { success, result, error } = outcome
    const task = success
      ? this.localSchedulerActor.jobDone(event.runId, event.jobId, result)
      : this.localSchedulerActor.jobFail(event.runId, event.jobId, event.attempt ?? 1, error)
    fireAndForget(task)
  }

  // --- Scheduler: cron 기반 잡 실행 ---

  initScheduler(userContext, opts) {
    this.localSchedulerActor = opts.onScheduledJobDone ? null : createSchedulerActor({
      store: userContext.jobStore,
      onDispatch: (event) => fireAndForget(this.actors.eventActor.enqueue(event)),
      logger: this.logger,
      pollIntervalMs: userContext.config.scheduler.pollIntervalMs,
    })
  }

  // --- Tools: job/todo 툴 등록 ---

  initTools(userContext) {
    const jobTools = createJobTools({ store: userContext.jobStore, eventActor: this.actors.eventActor })
    for (const tool of jobTools) userContext.toolRegistry.register(tool)

    userContext.toolRegistry.register({
      name: 'read_todos',
      description: '현재 대기 중인 TODO 항목 목록을 반환합니다.',
      parameters: { type: 'object', properties: {} },
      handler: (_args, context) => {
        const todos = context?.userDataStore
          ? context.userDataStore.list({ category: TODO.CATEGORY, status: TODO.STATUS_READY })
          : []
        if (todos.length === 0) return '대기 중인 TODO 항목이 없습니다.'
        return formatTodosAsLines(todos).join('\n')
      },
    })

    if (userContext.config.scheduler.todoReview.enabled) {
      const exists = userContext.jobStore.listJobs().find(job => job.name === SYSTEM_JOBS.TODO_REVIEW)
      if (!exists) {
        const cron = userContext.config.scheduler.todoReview.cron
        userContext.jobStore.createJob({
          name: SYSTEM_JOBS.TODO_REVIEW,
          prompt: SYSTEM_JOBS.TODO_REVIEW,
          cron,
          maxRetries: 1,
          nextRun: calcNextRun(cron),
        })
      }
    }
  }

  // --- Scheduler 접근 ---

  get schedulerActor() { return this.localSchedulerActor }

  // --- Shutdown: scheduler 정지 + persistence flush ---

  shutdownScheduler() {
    if (this.localSchedulerActor) fireAndForget(this.localSchedulerActor.stop())
  }

  async flushPersistence() {
    try {
      await forkTask(this.actors.persistenceActor.flush(this.state.snapshot()))
    } catch (_unused) {}
  }

  clearPersistence() {
    if (this.persistence) this.persistence.clear()
  }
}

export { UserSession }
