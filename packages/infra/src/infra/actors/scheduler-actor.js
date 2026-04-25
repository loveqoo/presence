import fp from '@presence/core/lib/fun-fp.js'
import { fireAndForget } from '@presence/core/lib/task.js'
import { SCHEDULER, EVENT_TYPE } from '@presence/core/core/policies.js'
import { calcNextRun } from '../jobs/job-tools.js'
import { ActorWrapper } from './actor-wrapper.js'

const { Task, Reader } = fp

// =============================================================================
// SchedulerActor: cron 기반 Job 스케줄러.
//
// 메시지:
//   start    → 타이머 시작
//   stop     → 타이머 정리
//   tick     → 다음 tick 예약 + poll/cleanup 전송
//   poll     → due jobs 조회 → onDispatch 발행
//   job_done → 성공 기록
//   job_fail → 실패 기록 + retry or 비활성화
//   cleanup  → 만료된 job_runs 삭제
// =============================================================================

const nextBackoffMs = (attempt) =>
  SCHEDULER.BACKOFF_BASE_MS * (SCHEDULER.BACKOFF_EXPONENT ** (attempt - 1))

class SchedulerActor extends ActorWrapper {
  static MSG = Object.freeze({
    START: 'start', STOP: 'stop', TICK: 'tick', POLL: 'poll',
    JOB_DONE: 'job_done', JOB_FAIL: 'job_fail', CLEANUP: 'cleanup',
  })
  static RESULT = Object.freeze({
    STARTED: 'started', STOPPED: 'stopped', TICKED: 'ticked',
    ALREADY_RUNNING: 'already-running',
    NO_OP_STOPPED: 'no-op:stopped',
    NO_OP_POLLING: 'no-op:polling', NO_OP_EMPTY: 'no-op:empty',
    POLLED: 'polled',
    JOB_DONE: 'job-done', JOB_FAILED: 'job-failed',
    CLEANED: 'cleaned', UNKNOWN: 'unknown',
  })

  #store
  #onDispatch
  #logger
  #pollIntervalMs

  constructor(store, onDispatch, opts = {}) {
    const { logger, pollIntervalMs = SCHEDULER.POLL_INTERVAL_MS } = opts
    const M = SchedulerActor.MSG
    const R = SchedulerActor.RESULT

    super(
      { running: false, polling: false },
      (actorState, msg) => {
        switch (msg.type) {
          // 타이머 시작 (이미 실행 중이면 no-op)
          case M.START:
            if (actorState.running) return [R.ALREADY_RUNNING, actorState]
            this.#scheduleTick()
            return [R.STARTED, { ...actorState, running: true }]

          // 타이머 정리
          case M.STOP:
            return [R.STOPPED, { ...actorState, running: false, polling: false }]

          // 다음 tick 예약 + poll/cleanup 트리거
          case M.TICK:
            if (!actorState.running) return [R.NO_OP_STOPPED, actorState]
            this.#scheduleTick()
            fireAndForget(this.poll())
            fireAndForget(this.cleanup())
            return [R.TICKED, actorState]

          // due job 조회 → onDispatch 발행
          case M.POLL:
            if (actorState.polling) return [R.NO_OP_POLLING, actorState]
            return this.#pollDueJobs(actorState)

          // 성공 기록
          case M.JOB_DONE:
            this.#recordSuccess(msg.runId, msg.jobId, msg.result)
            return [R.JOB_DONE, actorState]

          // 실패 기록 + retry/비활성화
          case M.JOB_FAIL:
            this.#handleJobFailure(msg)
            return [R.JOB_FAILED, actorState]

          // 만료된 job_runs 삭제
          case M.CLEANUP:
            this.#runCleanup()
            return [R.CLEANED, actorState]

          default:
            return [R.UNKNOWN, actorState]
        }
      },
    )

    this.#store = store
    this.#onDispatch = onDispatch
    this.#logger = logger
    this.#pollIntervalMs = pollIntervalMs
  }

  // --- Public 메시지 API ---
  start() { return this.send({ type: SchedulerActor.MSG.START }) }
  stop() { return this.send({ type: SchedulerActor.MSG.STOP }) }
  poll() { return this.send({ type: SchedulerActor.MSG.POLL }) }
  cleanup() { return this.send({ type: SchedulerActor.MSG.CLEANUP }) }
  jobDone(runId, jobId, result) { return this.send({ type: SchedulerActor.MSG.JOB_DONE, runId, jobId, result }) }
  jobFail(runId, jobId, attempt, error) { return this.send({ type: SchedulerActor.MSG.JOB_FAIL, runId, jobId, attempt, error }) }

  // --- 내부: 타이머 ---
  #scheduleTick() {
    setTimeout(() => fireAndForget(this.send({ type: SchedulerActor.MSG.TICK })), this.#pollIntervalMs)
  }

  // --- 내부: Poll ---
  #pollDueJobs(actorState) {
    const R = SchedulerActor.RESULT
    const due = this.#store.getDueJobs()
    if (due.length === 0) return [R.NO_OP_EMPTY, actorState]

    const polling = { ...actorState, polling: true }
    return new Task((_reject, resolve) => {
      for (const job of due) this.#dispatchJob(job, 1)
      resolve([R.POLLED, { ...polling, polling: false }])
    })
  }

  // due job 1회 실행: runId 발급 + onDispatch + nextRun 미리 갱신 (중복 실행 방지)
  #dispatchJob(job, attempt) {
    const runId = this.#store.startRun(job.id, attempt)
    this.#onDispatch(this.#buildJobEvent(job, runId, attempt))
    this.#store.updateJob(job.id, { next_run: calcNextRun(job.cron) })
  }

  #buildJobEvent(job, runId, attempt) {
    return {
      id: runId,
      type: EVENT_TYPE.SCHEDULED_JOB,
      jobId: job.id,
      jobName: job.name,
      prompt: job.prompt,
      runId,
      attempt,
      allowedTools: job.allowedTools || [],
      createdAt: Date.now(),
      // docs §4.3 — scheduler dispatch 시 job owner 를 event 로 전파.
      // scheduler-factory 가 scheduled session 생성 시 agentId 로 사용.
      ownerUserId: job.ownerUserId,
      ownerAgentId: job.ownerAgentId,
    }
  }

  // --- 내부: Job 성공 ---
  #recordSuccess(runId, jobId, result) {
    try {
      this.#store.finishRun(runId, { status: 'success', result: String(result ?? ''), jobId })
    } catch (e) {
      (this.#logger || console).warn('job_done: finishRun failed', { error: e.message })
    }
  }

  // --- 내부: Job 실패 ---
  #handleJobFailure(msg) {
    const { runId, jobId, attempt, error } = msg
    try {
      this.#store.finishRun(runId, { status: 'failure', error: String(error ?? ''), jobId })
      const job = this.#store.getJob(jobId)
      if (!job) return
      if (attempt < job.maxRetries) this.#scheduleRetry(job, attempt)
      else this.#disableJob(job, attempt)
    } catch (e) {
      (this.#logger || console).warn('job_fail: handler error', { error: e.message })
    }
  }

  #scheduleRetry(job, attempt) {
    const delayMs = nextBackoffMs(attempt)
    setTimeout(() => this.#dispatchRetry(job, attempt + 1), delayMs)
    ;(this.#logger || console).info(`Job retry scheduled: ${job.name} (attempt ${attempt + 1}/${job.maxRetries})`)
  }

  // retry 디스패치: store가 닫힌 경우 무시
  #dispatchRetry(job, attempt) {
    try { this.#dispatchJob(job, attempt) } catch (_) { /* store closed */ }
  }

  #disableJob(job, attempt) {
    this.#store.updateJob(job.id, { enabled: 0 })
    ;(this.#logger || console).warn(`Job disabled after ${attempt} failures: ${job.name}`)
  }

  // --- 내부: Cleanup ---
  #runCleanup() {
    try {
      const removed = this.#store.cleanupExpired()
      if (removed > 0) (this.#logger || console).info(`Scheduler cleanup: removed ${removed} expired runs`)
    } catch (_) { /* store closed */ }
  }
}

const schedulerActorR = Reader.asks(({ store, onDispatch, ...opts }) =>
  new SchedulerActor(store, onDispatch, opts))

// Legacy bridge (single-line delegate)
const createSchedulerActor = (deps) => schedulerActorR.run(deps)

export { SchedulerActor, schedulerActorR, createSchedulerActor }
