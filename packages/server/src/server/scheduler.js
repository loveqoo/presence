import { createSchedulerActor } from '@presence/infra/infra/actors/scheduler-actor.js'
import { SESSION_TYPE } from '@presence/core/core/policies.js'

// =============================================================================
// Global scheduler: cron 잡 실행 시 ephemeral 세션 생성 → 이벤트 enqueue.
// 잡 완료 후 세션 자동 소멸 + scheduler에 job_done/job_fail 통지.
// =============================================================================

const createGlobalScheduler = (userContext) => {
  let scheduler
  scheduler = createSchedulerActor({
    store: userContext.jobStore,
    onDispatch: (jobEvent) => {
      const sessionId = `scheduled-${jobEvent.runId}`
      const entry = userContext.sessions.create({
        type: SESSION_TYPE.SCHEDULED,
        id: sessionId,
        onScheduledJobDone: (event, outcome) => {
          const task = outcome.success
            ? scheduler.jobDone(event.runId, event.jobId, outcome.result)
            : scheduler.jobFail(event.runId, event.jobId, event.attempt ?? 1, outcome.error)
          task.fork(() => {}, () => {})
          userContext.sessions.destroy(sessionId).catch(() => {})
        },
      })
      entry.session.eventActor.enqueue(jobEvent).fork(() => {}, () => {})
    },
    logger: userContext.logger,
    pollIntervalMs: userContext.config.scheduler.pollIntervalMs,
  })
  return scheduler
}

export { createGlobalScheduler }
