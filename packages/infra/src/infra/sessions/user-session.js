import { createPersistence, migrateHistoryIds } from '../persistence.js'
import { STATE_PATH } from '@presence/core/core/policies.js'
import { SYSTEM_JOBS } from '../constants.js'
import { fireAndForget, forkTask } from '@presence/core/lib/task.js'
import { persistenceActorR } from '../actors/persistence-actor.js'
import { createSchedulerActor, calcNextRun } from '../jobs/scheduler-actor.js'
import { createJobTools } from '../jobs/job-tools.js'
import { formatTodosAsLines } from '../events.js'
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

  // --- State 복원: 디스크 → ReactiveState ---

  restoreState() {
    const restored = this.persistence.restore()
    if (!restored || typeof restored !== 'object') return
    try {
      if (typeof restored.turn === 'number') this.state.set(STATE_PATH.TURN, restored.turn)
      if (Array.isArray(restored.todos)) this.state.set(STATE_PATH.TODOS, restored.todos)
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

  notifyScheduler(event, { success, result, error }) {
    if (!this.localSchedulerActor) return
    if (success) {
      fireAndForget(this.localSchedulerActor.send({ type: 'job_done', runId: event.runId, jobId: event.jobId, result }))
    } else {
      fireAndForget(this.localSchedulerActor.send({
        type: 'job_fail', runId: event.runId, jobId: event.jobId,
        attempt: event.attempt ?? 1, error,
      }))
    }
  }

  // --- Scheduler: cron 기반 잡 실행 ---

  initScheduler(globalCtx, opts) {
    this.localSchedulerActor = opts.onScheduledJobDone ? null : createSchedulerActor({
      store: globalCtx.jobStore,
      onDispatch: (event) => fireAndForget(this.actors.eventActor.enqueue(event)),
      logger: this.logger,
      pollIntervalMs: globalCtx.config.scheduler.pollIntervalMs,
    })
  }

  // --- Tools: job/todo 툴 등록 ---

  initTools(globalCtx) {
    const jobTools = createJobTools({ store: globalCtx.jobStore, eventActor: this.actors.eventActor })
    for (const tool of jobTools) this.sessionToolRegistry.register(tool)

    this.sessionToolRegistry.register({
      name: 'read_todos',
      description: '현재 대기 중인 TODO 항목 목록을 반환합니다.',
      parameters: { type: 'object', properties: {} },
      handler: () => {
        const todos = (this.state.get(STATE_PATH.TODOS) || []).filter(todo => !todo.done)
        if (todos.length === 0) return '대기 중인 TODO 항목이 없습니다.'
        return formatTodosAsLines(todos).join('\n')
      },
    })

    if (globalCtx.config.scheduler.todoReview.enabled) {
      const exists = globalCtx.jobStore.listJobs().find(job => job.name === SYSTEM_JOBS.TODO_REVIEW)
      if (!exists) {
        const cron = globalCtx.config.scheduler.todoReview.cron
        globalCtx.jobStore.createJob({
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
    if (this.localSchedulerActor) fireAndForget(this.localSchedulerActor.send({ type: 'stop' }))
  }

  async flushPersistence() {
    try {
      await forkTask(this.actors.persistenceActor.flush(this.state.snapshot()))
    } catch (_unused) {}
  }
}

export { UserSession }
