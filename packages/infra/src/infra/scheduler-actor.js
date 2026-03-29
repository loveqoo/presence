import { Cron } from 'croner'
import fp from '@presence/core/lib/fun-fp.js'

const { Actor, Task } = fp

// --- SchedulerActor ---
// cron 기반 Job 스케줄러. DelegateActor와 동일한 self-send 타이머 패턴.
//
// 메시지:
//   start              → 타이머 시작
//   stop               → 타이머 정리
//   tick               → 다음 tick 예약 + poll 전송
//   poll               → due jobs 조회 → eventActor.enqueue
//   job_done(runId, result)  → 성공 기록 + nextRun 갱신
//   job_fail(runId, jobId, attempt, error) → retry or 비활성화
//   cleanup            → 만료된 job_runs 삭제

const BACKOFF_BASE_MS = 1_000

const nextBackoffMs = (attempt) => BACKOFF_BASE_MS * (2 ** (attempt - 1))

const createSchedulerActor = ({ store, onDispatch, logger, pollIntervalMs = 60_000 }) => {
  let actor

  actor = Actor({
    init: { running: false, polling: false },
    handle: (s, msg) => {
      switch (msg.type) {
        case 'start': {
          if (s.running) return ['already-running', s]
          setTimeout(() => actor.send({ type: 'tick' }).fork(() => {}, () => {}), pollIntervalMs)
          return ['started', { ...s, running: true }]
        }

        case 'stop': {
          return ['stopped', { ...s, running: false, polling: false }]
        }

        case 'tick': {
          if (!s.running) return ['no-op:stopped', s]
          setTimeout(() => actor.send({ type: 'tick' }).fork(() => {}, () => {}), pollIntervalMs)
          actor.send({ type: 'poll' }).fork(() => {}, () => {})
          actor.send({ type: 'cleanup' }).fork(() => {}, () => {})
          return ['ticked', s]
        }

        case 'poll': {
          if (s.polling) return ['no-op:polling', s]
          const due = store.getDueJobs()
          if (due.length === 0) return ['no-op:empty', s]

          const polling = { ...s, polling: true }

          return new Task((reject, resolve) => {
            for (const job of due) {
              const runId = store.startRun(job.id, 1)
              onDispatch({
                id: runId,
                type: 'scheduled_job',
                jobId: job.id,
                jobName: job.name,
                prompt: job.prompt,
                runId,
                attempt: 1,
                allowedTools: job.allowedTools || [],
                createdAt: Date.now(),
              })
              // nextRun을 미리 갱신 (중복 실행 방지)
              const nextRun = calcNextRun(job.cron)
              store.updateJob(job.id, { next_run: nextRun })
            }
            resolve(['polled', { ...polling, polling: false }])
          })
        }

        case 'job_done': {
          const { runId, jobId, result } = msg
          try {
            store.finishRun(runId, { status: 'success', result: String(result ?? ''), jobId })
          } catch (e) {
            ;(logger || console).warn('job_done: finishRun failed', { error: e.message })
          }
          return ['job-done', s]
        }

        case 'job_fail': {
          const { runId, jobId, attempt, error } = msg
          try {
            store.finishRun(runId, { status: 'failure', error: String(error ?? ''), jobId })
            const job = store.getJob(jobId)
            if (!job) return ['job-fail:not-found', s]

            if (attempt < job.maxRetries) {
              // 재시도: exponential backoff 후 eventActor에 재enqueue
              const delayMs = nextBackoffMs(attempt)
              setTimeout(() => {
                try {
                  const retryRunId = store.startRun(jobId, attempt + 1)
                  onDispatch({
                    id: retryRunId,
                    type: 'scheduled_job',
                    jobId,
                    jobName: job.name,
                    prompt: job.prompt,
                    runId: retryRunId,
                    attempt: attempt + 1,
                    allowedTools: job.allowedTools || [],
                    createdAt: Date.now(),
                  })
                } catch (_) {}  // store가 닫힌 경우 무시
              }, delayMs)
              ;(logger || console).info(`Job retry scheduled: ${job.name} (attempt ${attempt + 1}/${job.maxRetries})`)
            } else {
              // 최대 재시도 초과 → 비활성화
              store.updateJob(jobId, { enabled: 0 })
              ;(logger || console).warn(`Job disabled after ${attempt} failures: ${job.name}`)
            }
          } catch (e) {
            ;(logger || console).warn('job_fail: handler error', { error: e.message })
          }
          return ['job-failed', s]
        }

        case 'cleanup': {
          try {
            const removed = store.cleanupExpired()
            if (removed > 0) {
              ;(logger || console).info(`Scheduler cleanup: removed ${removed} expired runs`)
            }
          } catch (_) {}
          return ['cleaned', s]
        }

        default:
          return ['unknown', s]
      }
    },
  })

  return actor
}

// croner로 다음 실행 시각 계산 (epoch ms)
const calcNextRun = (cronExpr) => {
  try {
    const job = new Cron(cronExpr, { paused: true })
    const next = job.nextRun()
    return next ? next.getTime() : null
  } catch (_) {
    return null
  }
}

// cron 표현식 유효성 검사
const validateCron = (expr) => {
  try {
    new Cron(expr, { paused: true })
    return true
  } catch (_) {
    return false
  }
}

/**
 * `createSchedulerActor({ store, onDispatch, logger, pollIntervalMs? })` — Actor-based cron job scheduler.
 * Polls due jobs at each tick, dispatches `scheduled_job` events via `onDispatch`, and handles retry/backoff.
 *
 * `calcNextRun(cronExpr)` — Returns the next scheduled epoch ms for a cron expression, or null if invalid.
 * @param {string} cronExpr
 * @returns {number | null}
 *
 * `validateCron(expr)` — Returns true if the cron expression is syntactically valid.
 */
export { createSchedulerActor, calcNextRun, validateCron }
