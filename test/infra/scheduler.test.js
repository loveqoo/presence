import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { createJobStore } from '@presence/infra/infra/job-store.js'
import { createSchedulerActor, calcNextRun, validateCron } from '@presence/infra/infra/scheduler-actor.js'
import { createJobTools } from '@presence/infra/infra/job-tools.js'
import { eventActorR, turnActorR } from '@presence/infra/infra/actors.js'
import { createReactiveState } from '@presence/infra/infra/state.js'
import { eventToPrompt } from '@presence/infra/infra/events.js'
import { Phase } from '@presence/core/core/agent.js'
import { assert, summary } from '../lib/assert.js'

const delay = (ms) => new Promise(r => setTimeout(r, ms))

const makeTmpDir = () => {
  const dir = join(tmpdir(), `presence-scheduler-test-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const createMockEventActor = () => {
  const enqueued = []
  const onDispatch = (event) => enqueued.push(event)
  return {
    enqueued,
    onDispatch,
    send: (msg) => ({ fork: (_, resolve) => { if (msg.type === 'enqueue') enqueued.push(msg.event); resolve('ok') } }),
  }
}

async function run() {
  console.log('Scheduler tests')

  // =============================================
  // JobStore
  // =============================================

  // S1. createJob → getJob 왕복
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: '테스트', prompt: '안녕', cron: '* * * * *', nextRun: Date.now() + 60000 })
    const got = store.getJob(job.id)
    assert(got.name === '테스트', 'S1: name')
    assert(got.prompt === '안녕', 'S1: prompt')
    assert(got.cron === '* * * * *', 'S1: cron')
    assert(got.enabled === true, 'S1: enabled default true')
    assert(got.maxRetries === 3, 'S1: maxRetries default 3')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S2. listJobs
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    store.createJob({ name: 'a', prompt: 'p1', cron: '0 9 * * *' })
    store.createJob({ name: 'b', prompt: 'p2', cron: '0 18 * * *' })
    const jobs = store.listJobs()
    assert(jobs.length === 2, 'S2: two jobs')
    assert(jobs[0].name === 'a', 'S2: first job')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S3. updateJob
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: '원본', prompt: 'old', cron: '* * * * *' })
    const updated = store.updateJob(job.id, { name: '수정됨', prompt: 'new' })
    assert(updated.name === '수정됨', 'S3: name updated')
    assert(updated.prompt === 'new', 'S3: prompt updated')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S4. deleteJob → cascades job_runs
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'del', prompt: 'p', cron: '* * * * *' })
    store.startRun(job.id, 1)
    store.deleteJob(job.id)
    assert(store.getJob(job.id) === null, 'S4: job deleted')
    assert(store.getRunHistory(job.id).length === 0, 'S4: runs cascaded')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S5. getDueJobs — next_run <= now만 반환
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const past = Date.now() - 1000
    const future = Date.now() + 60000
    store.createJob({ name: 'due', prompt: 'p', cron: '* * * * *', nextRun: past })
    store.createJob({ name: 'future', prompt: 'p', cron: '* * * * *', nextRun: future })
    const due = store.getDueJobs()
    assert(due.length === 1, 'S5: only due job returned')
    assert(due[0].name === 'due', 'S5: correct job')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S6. startRun + finishRun → getRunHistory
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'j', prompt: 'p', cron: '* * * * *' })
    const runId = store.startRun(job.id, 1)
    store.finishRun(runId, { status: 'success', result: 'done' })
    const history = store.getRunHistory(job.id)
    assert(history.length === 1, 'S6: one run')
    assert(history[0].status === 'success', 'S6: success status')
    assert(history[0].result === 'done', 'S6: result saved')
    assert(history[0].finishedAt !== null, 'S6: finishedAt set')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S7. finishRun failure
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'j', prompt: 'p', cron: '* * * * *' })
    const runId = store.startRun(job.id, 1)
    store.finishRun(runId, { status: 'failure', error: 'timeout' })
    const history = store.getRunHistory(job.id)
    assert(history[0].status === 'failure', 'S7: failure status')
    assert(history[0].error === 'timeout', 'S7: error saved')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S8. trimHistory: HISTORY_MAX_PER_JOB 초과 시 오래된 것 삭제
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'j', prompt: 'p', cron: '* * * * *' })
    // 52개 run 생성 (max 50)
    for (let i = 0; i < 52; i++) {
      const runId = store.startRun(job.id, 1)
      store.finishRun(runId, { status: 'success' })
    }
    const history = store.getRunHistory(job.id, 100)
    assert(history.length <= 50, 'S8: history trimmed to max 50')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S9. cleanupExpired
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'j', prompt: 'p', cron: '* * * * *' })
    // expire_at를 과거로 직접 삽입하기 위해 startRun 후 DB 수정은 어려우므로
    // cleanupExpired 는 expire_at < now()를 삭제 — 새로 생성된 건 미래이므로 삭제 안 됨
    store.startRun(job.id, 1)
    const removed = store.cleanupExpired()
    assert(removed === 0, 'S9: no expired runs to clean')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // =============================================
  // calcNextRun / validateCron
  // =============================================

  // S10. validateCron
  {
    assert(validateCron('* * * * *') === true, 'S10: valid cron')
    assert(validateCron('0 9 * * 1-5') === true, 'S10: weekday cron')
    assert(validateCron('*/30 * * * *') === true, 'S10: interval cron')
    assert(validateCron('not-a-cron') === false, 'S10: invalid cron')
    assert(validateCron('99 99 99 99 99') === false, 'S10: out of range cron')
  }

  // S11. calcNextRun returns future timestamp
  {
    const next = calcNextRun('* * * * *')
    assert(typeof next === 'number', 'S11: returns number')
    assert(next > Date.now(), 'S11: next run is in the future')
  }

  // S12. calcNextRun invalid → null
  {
    const next = calcNextRun('invalid')
    assert(next === null, 'S12: invalid cron returns null')
  }

  // =============================================
  // SchedulerActor
  // =============================================

  // S13. poll: due job → eventActor.enqueue
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    store.createJob({ name: 'due-job', prompt: '실행', cron: '* * * * *', nextRun: Date.now() - 1000 })
    const mockActor = createMockEventActor()
    const actor = createSchedulerActor({ store, onDispatch: mockActor.onDispatch, pollIntervalMs: 10_000 })

    await new Promise(r => actor.send({ type: 'poll' }).fork(() => {}, r))
    assert(mockActor.enqueued.length === 1, 'S13: enqueued due job')
    assert(mockActor.enqueued[0].type === 'scheduled_job', 'S13: event type')
    assert(mockActor.enqueued[0].prompt === '실행', 'S13: prompt forwarded')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S14. poll: no due jobs → no-op:empty
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    store.createJob({ name: 'future', prompt: 'p', cron: '* * * * *', nextRun: Date.now() + 60000 })
    const mockActor = createMockEventActor()
    const actor = createSchedulerActor({ store, onDispatch: mockActor.onDispatch, pollIntervalMs: 10_000 })

    const result = await new Promise(r => actor.send({ type: 'poll' }).fork(() => {}, r))
    assert(result === 'no-op:empty', 'S14: no-op:empty when no due jobs')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S15. job_done → run finishes as success
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'j', prompt: 'p', cron: '* * * * *' })
    const runId = store.startRun(job.id, 1)
    const actor = createSchedulerActor({ store, onDispatch: () => {}, pollIntervalMs: 10_000 })

    await new Promise(r => actor.send({ type: 'job_done', runId, result: 'finished' }).fork(() => {}, r))
    const history = store.getRunHistory(job.id)
    assert(history[0].status === 'success', 'S15: run marked success')
    assert(history[0].result === 'finished', 'S15: result saved')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S16. job_fail attempt < maxRetries → retry enqueued
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'j', prompt: 'p', cron: '* * * * *', maxRetries: 3 })
    const runId = store.startRun(job.id, 1)
    const mockActor = createMockEventActor()
    const actor = createSchedulerActor({ store, onDispatch: mockActor.onDispatch, pollIntervalMs: 10_000 })

    await new Promise(r => actor.send({ type: 'job_fail', runId, jobId: job.id, attempt: 1, error: 'oops' }).fork(() => {}, r))
    // 첫 번째 run 실패로 기록됨
    const history = store.getRunHistory(job.id)
    assert(history[0].status === 'failure', 'S16: run marked failure')
    // retry는 backoff 후 enqueue (1000ms 기다리기 어려우므로 job이 여전히 enabled인지만 확인)
    const updatedJob = store.getJob(job.id)
    assert(updatedJob.enabled === true, 'S16: job still enabled after first failure')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S17. job_fail attempt >= maxRetries → job 비활성화
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'j', prompt: 'p', cron: '* * * * *', maxRetries: 3 })
    const runId = store.startRun(job.id, 3)
    const actor = createSchedulerActor({ store, onDispatch: () => {}, pollIntervalMs: 10_000 })

    await new Promise(r => actor.send({ type: 'job_fail', runId, jobId: job.id, attempt: 3, error: 'fatal' }).fork(() => {}, r))
    const updated = store.getJob(job.id)
    assert(updated.enabled === false, 'S17: job disabled after max retries')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S18. poll: disabled job → not enqueued
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'j', prompt: 'p', cron: '* * * * *', nextRun: Date.now() - 1000 })
    store.updateJob(job.id, { enabled: 0 })
    const mockActor = createMockEventActor()
    const actor = createSchedulerActor({ store, onDispatch: mockActor.onDispatch, pollIntervalMs: 10_000 })

    await new Promise(r => actor.send({ type: 'poll' }).fork(() => {}, r))
    assert(mockActor.enqueued.length === 0, 'S18: disabled job not enqueued')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S19. poll: nextRun 갱신 후 동일 job 중복 실행 방지
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    store.createJob({ name: 'j', prompt: 'p', cron: '* * * * *', nextRun: Date.now() - 1000 })
    const mockActor = createMockEventActor()
    const actor = createSchedulerActor({ store, onDispatch: mockActor.onDispatch, pollIntervalMs: 10_000 })

    await new Promise(r => actor.send({ type: 'poll' }).fork(() => {}, r))
    await new Promise(r => actor.send({ type: 'poll' }).fork(() => {}, r))
    assert(mockActor.enqueued.length === 1, 'S19: job not re-enqueued after nextRun updated')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S20. stop 후 tick → no-op:stopped
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const actor = createSchedulerActor({ store, onDispatch: () => {}, pollIntervalMs: 10_000 })

    await new Promise(r => actor.send({ type: 'start' }).fork(() => {}, r))
    await new Promise(r => actor.send({ type: 'stop' }).fork(() => {}, r))
    const result = await new Promise(r => actor.send({ type: 'tick' }).fork(() => {}, r))
    assert(result === 'no-op:stopped', 'S20: tick no-op after stop')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // =============================================
  // cleanupExpired — 실제 만료 케이스
  // =============================================

  // S21. cleanupExpired: 과거 expire_at인 run 삭제
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    // expire_at을 과거로 직접 DB에 삽입
    const db = new (await import('better-sqlite3')).default(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'j', prompt: 'p', cron: '* * * * *' })
    const runId = store.startRun(job.id, 1)
    // expire_at을 1ms(과거)로 강제 설정
    db.prepare('UPDATE job_runs SET expire_at = ? WHERE id = ?').run(1, runId)
    db.close()

    const removed = store.cleanupExpired()
    assert(removed === 1, 'S21: expired run removed')
    assert(store.getRunHistory(job.id).length === 0, 'S21: no runs remain')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // =============================================
  // eventToPrompt — scheduled_job
  // =============================================

  // S22. eventToPrompt: scheduled_job → prompt 필드 사용
  {
    const event = { type: 'scheduled_job', prompt: '일일 리포트 생성' }
    assert(eventToPrompt(event) === '일일 리포트 생성', 'S22: scheduled_job uses prompt field')
  }

  // S23. eventToPrompt: prompt 없으면 fallback
  {
    const event = { type: 'scheduled_job' }
    assert(eventToPrompt(event) === '이벤트 처리: scheduled_job', 'S23: fallback when no prompt')
  }

  // =============================================
  // onEventDone 통합: EventActor → SchedulerActor
  // =============================================

  // S24. scheduled_job 성공 → job_done 호출 → DB success 기록
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'j', prompt: '리포트', cron: '* * * * *' })
    const runId = store.startRun(job.id, 1)

    const state = createReactiveState({
      turnState: Phase.idle(),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })
    const turnActor = turnActorR.run({ runTurn: async () => '성공 결과' })
    const schedulerActor = createSchedulerActor({ store, onDispatch: () => {}, pollIntervalMs: 10_000 })

    const eventActor = eventActorR.run({
      turnActor, state, logger: null,
      onEventDone: (event, { success, result, error }) => {
        if (event.type !== 'scheduled_job') return
        if (success) {
          schedulerActor.send({ type: 'job_done', runId: event.runId, result }).fork(() => {}, () => {})
        } else {
          schedulerActor.send({ type: 'job_fail', runId: event.runId, jobId: event.jobId, attempt: event.attempt ?? 1, error }).fork(() => {}, () => {})
        }
      },
    })

    // scheduled_job 이벤트 enqueue
    eventActor.send({
      type: 'enqueue',
      event: { id: runId, type: 'scheduled_job', jobId: job.id, jobName: job.name, prompt: '리포트', runId, attempt: 1, createdAt: Date.now() },
    }).fork(() => {}, () => {})

    await delay(150)

    const history = store.getRunHistory(job.id)
    assert(history.length === 1, 'S24: run recorded')
    assert(history[0].status === 'success', 'S24: status is success')
    assert(history[0].result === '성공 결과', 'S24: result saved')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S25. scheduled_job 실패 (turnActor 예외) → job_fail 호출 → DB failure 기록
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'j', prompt: 'p', cron: '* * * * *', maxRetries: 1 })
    const runId = store.startRun(job.id, 1)

    const state = createReactiveState({
      turnState: Phase.idle(),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })
    const turnActor = turnActorR.run({ runTurn: async () => { throw new Error('job crashed') } })
    const schedulerActor = createSchedulerActor({ store, onDispatch: () => {}, pollIntervalMs: 10_000 })

    const eventActor = eventActorR.run({
      turnActor, state, logger: null,
      onEventDone: (event, { success, result, error }) => {
        if (event.type !== 'scheduled_job') return
        if (success) {
          schedulerActor.send({ type: 'job_done', runId: event.runId, result }).fork(() => {}, () => {})
        } else {
          schedulerActor.send({ type: 'job_fail', runId: event.runId, jobId: event.jobId, attempt: event.attempt ?? 1, error }).fork(() => {}, () => {})
        }
      },
    })

    eventActor.send({
      type: 'enqueue',
      event: { id: runId, type: 'scheduled_job', jobId: job.id, jobName: job.name, prompt: 'p', runId, attempt: 1, createdAt: Date.now() },
    }).fork(() => {}, () => {})

    await delay(150)

    const history = store.getRunHistory(job.id)
    assert(history.length === 1, 'S25: run recorded')
    assert(history[0].status === 'failure', 'S25: status is failure')
    // maxRetries=1, attempt=1 → 비활성화
    const updated = store.getJob(job.id)
    assert(updated.enabled === false, 'S25: job disabled after max retries reached')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // =============================================
  // job-tools 핸들러
  // =============================================

  // T1. schedule_job: 유효한 cron → job 생성
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const tools = createJobTools({ store, eventActor: createMockEventActor() })
    const scheduleTool = tools.find(t => t.name === 'schedule_job')

    const result = scheduleTool.handler({ name: '일일 리포트', cron: '0 9 * * *', prompt: '오늘 현황 정리' })
    assert(result.includes('일일 리포트'), 'T1: name in result')
    assert(result.includes('0 9 * * *'), 'T1: cron in result')
    assert(store.listJobs().length === 1, 'T1: job stored in DB')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T2. schedule_job: 잘못된 cron → 오류 메시지
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const tools = createJobTools({ store, eventActor: createMockEventActor() })
    const scheduleTool = tools.find(t => t.name === 'schedule_job')

    const result = scheduleTool.handler({ name: '잘못됨', cron: 'bad-cron', prompt: 'p' })
    assert(result.startsWith('오류'), 'T2: error on invalid cron')
    assert(store.listJobs().length === 0, 'T2: no job created')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T3. list_jobs: 빈 목록
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const tools = createJobTools({ store, eventActor: createMockEventActor() })
    const listTool = tools.find(t => t.name === 'list_jobs')

    const result = listTool.handler({})
    assert(result.includes('없습니다'), 'T3: empty message')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T4. list_jobs: job 있음
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    store.createJob({ name: '점검', prompt: 'p', cron: '* * * * *' })
    const tools = createJobTools({ store, eventActor: createMockEventActor() })
    const listTool = tools.find(t => t.name === 'list_jobs')

    const result = listTool.handler({})
    assert(result.includes('점검'), 'T4: job name shown')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T5. update_job: 필드 변경
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: '원본', prompt: 'old', cron: '* * * * *' })
    const tools = createJobTools({ store, eventActor: createMockEventActor() })
    const updateTool = tools.find(t => t.name === 'update_job')

    const result = updateTool.handler({ id: job.id, name: '수정', prompt: '새 프롬프트' })
    assert(result.includes('수정'), 'T5: updated name shown')
    assert(store.getJob(job.id).prompt === '새 프롬프트', 'T5: prompt updated in DB')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T6. update_job: 없는 id → 오류
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const tools = createJobTools({ store, eventActor: createMockEventActor() })
    const updateTool = tools.find(t => t.name === 'update_job')

    const result = updateTool.handler({ id: 'nonexistent', name: '수정' })
    assert(result.startsWith('오류'), 'T6: error for nonexistent id')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T7. update_job: enabled=false → 비활성화
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'j', prompt: 'p', cron: '* * * * *' })
    const tools = createJobTools({ store, eventActor: createMockEventActor() })
    const updateTool = tools.find(t => t.name === 'update_job')

    updateTool.handler({ id: job.id, enabled: false })
    assert(store.getJob(job.id).enabled === false, 'T7: job disabled')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T8. delete_job: 삭제
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'j', prompt: 'p', cron: '* * * * *' })
    const tools = createJobTools({ store, eventActor: createMockEventActor() })
    const deleteTool = tools.find(t => t.name === 'delete_job')

    const result = deleteTool.handler({ id: job.id })
    assert(result.includes('삭제됨'), 'T8: delete confirmed')
    assert(store.getJob(job.id) === null, 'T8: job removed from DB')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T9. delete_job: 없는 id → 오류
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const tools = createJobTools({ store, eventActor: createMockEventActor() })
    const deleteTool = tools.find(t => t.name === 'delete_job')

    const result = deleteTool.handler({ id: 'ghost' })
    assert(result.startsWith('오류'), 'T9: error for missing id')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T10. job_history: 실행 이력 조회
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'j', prompt: 'p', cron: '* * * * *' })
    const runId = store.startRun(job.id, 1)
    store.finishRun(runId, { status: 'success', result: 'ok' })
    const tools = createJobTools({ store, eventActor: createMockEventActor() })
    const historyTool = tools.find(t => t.name === 'job_history')

    const result = historyTool.handler({ id: job.id })
    assert(result.includes('success'), 'T10: success status in history')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T11. job_history: 이력 없음
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'j', prompt: 'p', cron: '* * * * *' })
    const tools = createJobTools({ store, eventActor: createMockEventActor() })
    const historyTool = tools.find(t => t.name === 'job_history')

    const result = historyTool.handler({ id: job.id })
    assert(result.includes('없습니다'), 'T11: no history message')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T12. run_job_now: eventActor에 enqueue
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'j', prompt: '즉시 실행 테스트', cron: '* * * * *' })
    const mockActor = createMockEventActor()
    const tools = createJobTools({ store, eventActor: mockActor })
    const runNowTool = tools.find(t => t.name === 'run_job_now')

    const result = runNowTool.handler({ id: job.id })
    assert(result.includes('즉시 실행 요청됨'), 'T12: success message')
    assert(mockActor.enqueued.length === 1, 'T12: event enqueued')
    assert(mockActor.enqueued[0].type === 'scheduled_job', 'T12: correct event type')
    assert(mockActor.enqueued[0].prompt === '즉시 실행 테스트', 'T12: prompt forwarded')
    // run_id가 DB에 기록됨
    const history = store.getRunHistory(job.id)
    assert(history.length === 1, 'T12: run recorded in DB')
    assert(history[0].status === 'running', 'T12: status is running')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T13. run_job_now: 없는 id → 오류
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const tools = createJobTools({ store, eventActor: createMockEventActor() })
    const runNowTool = tools.find(t => t.name === 'run_job_now')

    const result = runNowTool.handler({ id: 'ghost' })
    assert(result.startsWith('오류'), 'T13: error for missing id')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // =============================================
  // allowedTools — 허용 툴 목록 (allowlist)
  // =============================================

  // T14. schedule_job with allowed_tools → stored and retrievable
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const tools = createJobTools({ store, eventActor: createMockEventActor() })
    const scheduleTool = tools.find(t => t.name === 'schedule_job')

    scheduleTool.handler({ name: '제한된 Job', cron: '* * * * *', prompt: 'p', allowed_tools: ['read_file', '^search'] })
    const job = store.listJobs()[0]
    assert(Array.isArray(job.allowedTools), 'T14: allowedTools is array')
    assert(job.allowedTools.length === 2, 'T14: two patterns stored')
    assert(job.allowedTools[0] === 'read_file', 'T14: first pattern')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T15. update_job with allowed_tools → updated in DB
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'j', prompt: 'p', cron: '* * * * *' })
    const tools = createJobTools({ store, eventActor: createMockEventActor() })
    const updateTool = tools.find(t => t.name === 'update_job')

    updateTool.handler({ id: job.id, allowed_tools: ['bash'] })
    const updated = store.getJob(job.id)
    assert(updated.allowedTools.length === 1, 'T15: one pattern after update')
    assert(updated.allowedTools[0] === 'bash', 'T15: pattern value correct')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T16. schedule_job empty allowed_tools → no restriction (all tools)
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'j', prompt: 'p', cron: '* * * * *', allowedTools: [] })
    assert(job.allowedTools.length === 0, 'T16: empty allowedTools = no restriction')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T17. poll: allowedTools forwarded in event
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    store.createJob({ name: 'j', prompt: 'p', cron: '* * * * *', nextRun: Date.now() - 1000, allowedTools: ['read_file'] })
    const mockActor = createMockEventActor()
    const actor = createSchedulerActor({ store, onDispatch: mockActor.onDispatch, pollIntervalMs: 10_000 })

    await new Promise(r => actor.send({ type: 'poll' }).fork(() => {}, r))
    assert(mockActor.enqueued.length === 1, 'T17: enqueued')
    assert(Array.isArray(mockActor.enqueued[0].allowedTools), 'T17: allowedTools in event')
    assert(mockActor.enqueued[0].allowedTools[0] === 'read_file', 'T17: pattern forwarded')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T18. run_job_now: allowedTools forwarded in event
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ name: 'j', prompt: 'p', cron: '* * * * *', allowedTools: ['bash', 'read'] })
    const mockActor = createMockEventActor()
    const tools = createJobTools({ store, eventActor: mockActor })
    const runNowTool = tools.find(t => t.name === 'run_job_now')

    runNowTool.handler({ id: job.id })
    assert(mockActor.enqueued[0].allowedTools.length === 2, 'T18: allowedTools in run_job_now event')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // =============================================
  // todo_review 이벤트 처리
  // =============================================

  // TR0. scheduled_job 이벤트에서 jobName으로 todo_review 감지 (실제 프로덕션 경로)
  {
    const TODO_REVIEW_JOB_NAME = '__todo_review__'
    const state = createReactiveState({
      turnState: Phase.idle(),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [
        { id: 't1', type: 'task', title: '작업1', done: false, createdAt: Date.now() },
      ],
    })
    let receivedPrompt = null
    const turnActor = turnActorR.run({ runTurn: async (input) => { receivedPrompt = input; return 'ok' } })
    const eventActor = eventActorR.run({ turnActor, state, logger: null, todoReviewJobName: TODO_REVIEW_JOB_NAME })

    // SchedulerActor가 생성하는 것과 동일한 형태 (type: 'scheduled_job', jobName: '__todo_review__')
    eventActor.send({
      type: 'enqueue',
      event: { id: 'tr0', type: 'scheduled_job', jobName: TODO_REVIEW_JOB_NAME, prompt: TODO_REVIEW_JOB_NAME, receivedAt: Date.now() },
    }).fork(() => {}, () => {})
    await delay(150)

    assert(receivedPrompt !== null, 'TR0: turn started for scheduled_job with todoReviewJobName')
    assert(receivedPrompt.includes('1개'), 'TR0: dynamic prompt injected via jobName')
    assert(!receivedPrompt.includes(TODO_REVIEW_JOB_NAME), 'TR0: sentinel prompt replaced')
  }

  // TR0b. scheduled_job + todoReviewJobName, todos 없으면 no-op
  {
    const TODO_REVIEW_JOB_NAME = '__todo_review__'
    const state = createReactiveState({
      turnState: Phase.idle(),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })
    let turnCalled = false
    const turnActor = turnActorR.run({ runTurn: async () => { turnCalled = true; return 'ok' } })
    const eventActor = eventActorR.run({ turnActor, state, logger: null, todoReviewJobName: TODO_REVIEW_JOB_NAME })

    eventActor.send({
      type: 'enqueue',
      event: { id: 'tr0b', type: 'scheduled_job', jobName: TODO_REVIEW_JOB_NAME, prompt: TODO_REVIEW_JOB_NAME, receivedAt: Date.now() },
    }).fork(() => {}, () => {})
    await delay(100)

    assert(turnCalled === false, 'TR0b: no turn when todos empty (scheduled_job path)')
  }

  // TR1. todo_review: todos 없으면 turn 시작 안 함 (no-op:no-todos)
  {
    const state = createReactiveState({
      turnState: Phase.idle(),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })
    let turnCalled = false
    const turnActor = turnActorR.run({ runTurn: async () => { turnCalled = true; return 'ok' } })
    const eventActor = eventActorR.run({ turnActor, state, logger: null })

    eventActor.send({ type: 'enqueue', event: { id: 'tr1', type: 'todo_review', receivedAt: Date.now() } }).fork(() => {}, () => {})
    await delay(100)

    assert(turnCalled === false, 'TR1: turn not started when no todos')
    assert(state.get('events.queue').length === 0, 'TR1: event removed from queue')
  }

  // TR2. todo_review: todos 있으면 동적 프롬프트로 turn 실행
  {
    const state = createReactiveState({
      turnState: Phase.idle(),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [
        { id: 't1', type: 'task', title: '주간 리포트 작성', done: false, createdAt: Date.now() },
        { id: 't2', type: 'reminder', title: '미팅 준비', done: false, createdAt: Date.now() },
      ],
    })
    let receivedPrompt = null
    const turnActor = turnActorR.run({ runTurn: async (input) => { receivedPrompt = input; return 'ok' } })
    const eventActor = eventActorR.run({ turnActor, state, logger: null })

    eventActor.send({ type: 'enqueue', event: { id: 'tr2', type: 'todo_review', receivedAt: Date.now() } }).fork(() => {}, () => {})
    await delay(150)

    assert(receivedPrompt !== null, 'TR2: turn was started')
    assert(receivedPrompt.includes('2개'), 'TR2: prompt includes todo count')
    assert(receivedPrompt.includes('주간 리포트 작성'), 'TR2: prompt includes todo title')
    assert(receivedPrompt.includes('미팅 준비'), 'TR2: prompt includes second todo')
  }

  // TR3. todo_review: done=true인 항목은 제외
  {
    const state = createReactiveState({
      turnState: Phase.idle(),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [
        { id: 't1', type: 'task', title: '완료됨', done: true, createdAt: Date.now() },
        { id: 't2', type: 'task', title: '미완료', done: false, createdAt: Date.now() },
      ],
    })
    let receivedPrompt = null
    const turnActor = turnActorR.run({ runTurn: async (input) => { receivedPrompt = input; return 'ok' } })
    const eventActor = eventActorR.run({ turnActor, state, logger: null })

    eventActor.send({ type: 'enqueue', event: { id: 'tr3', type: 'todo_review', receivedAt: Date.now() } }).fork(() => {}, () => {})
    await delay(150)

    assert(receivedPrompt !== null, 'TR3: turn started (pending todo exists)')
    assert(receivedPrompt.includes('1개'), 'TR3: only 1 pending todo in prompt')
    assert(!receivedPrompt.includes('완료됨'), 'TR3: done todo excluded')
    assert(receivedPrompt.includes('미완료'), 'TR3: pending todo included')
  }

  // TR4. todo_review: 모두 done이면 no-op
  {
    const state = createReactiveState({
      turnState: Phase.idle(),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [
        { id: 't1', type: 'task', title: '완료', done: true, createdAt: Date.now() },
      ],
    })
    let turnCalled = false
    const turnActor = turnActorR.run({ runTurn: async () => { turnCalled = true; return 'ok' } })
    const eventActor = eventActorR.run({ turnActor, state, logger: null })

    eventActor.send({ type: 'enqueue', event: { id: 'tr4', type: 'todo_review', receivedAt: Date.now() } }).fork(() => {}, () => {})
    await delay(100)

    assert(turnCalled === false, 'TR4: turn not started when all todos done')
  }

  summary()
}

run()
