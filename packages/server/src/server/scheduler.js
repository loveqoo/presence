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
          const msg = outcome.success
            ? { type: 'job_done', runId: event.runId, jobId: event.jobId, result: outcome.result }
            : { type: 'job_fail', runId: event.runId, jobId: event.jobId, attempt: event.attempt ?? 1, error: outcome.error }
          scheduler.send(msg).fork(() => {}, () => {})
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
