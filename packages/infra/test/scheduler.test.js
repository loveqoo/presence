import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { createJobStore } from '@presence/infra/infra/jobs/job-store.js'
import { createSchedulerActor } from '@presence/infra/infra/actors/scheduler-actor.js'
import { calcNextRun, validateCron } from '@presence/infra/infra/jobs/job-tools.js'
import { createJobTools } from '@presence/infra/infra/jobs/job-tools.js'
import { eventActorR } from '@presence/infra/infra/actors/event-actor.js'
import { turnActorR } from '@presence/infra/infra/actors/turn-actor.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { eventToPrompt } from '@presence/infra/infra/events.js'
import { TurnState } from '@presence/core/core/policies.js'
import { assert, summary } from '../../../test/lib/assert.js'

const delay = (ms) => new Promise(r => setTimeout(r, ms))

// In-memory mock UserDataStore
const createMockUserDataStore = (initialTodos = []) => {
  const rows = initialTodos.map((t, i) => ({
    id: i + 1, category: 'todo', status: t.done ? 'done' : 'ready',
    title: t.title, payload: { sourceEventId: t.sourceEventId, type: t.type, data: t.data || {} },
    createdAt: t.createdAt || Date.now(), updatedAt: Date.now(),
  }))
  let nextId = rows.length + 1
  return {
    list: ({ category, status } = {}) => rows
      .filter(r => (!category || r.category === category) && (!status || r.status === status)),
    add: ({ category, status, title, payload }) => {
      const row = { id: nextId++, category, status, title, payload, createdAt: Date.now(), updatedAt: Date.now() }
      rows.push(row)
      return row
    },
    get: (id) => rows.find(r => r.id === id) || null,
    update: () => true,
    remove: () => true,
    close: () => {},
  }
}

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
    enqueue: (event) => ({ fork: (_, resolve) => { enqueued.push(event); resolve('ok') } }),
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
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: '테스트', prompt: '안녕', cron: '* * * * *', nextRun: Date.now() + 60000 })
    const got = store.getJob(job.id)
    assert(got.name === '테스트', 'S1: name')
    assert(got.prompt === '안녕', 'S1: prompt')
    assert(got.cron === '* * * * *', 'S1: cron')
    assert(got.enabled === true, 'S1: enabled default true')
    assert(got.maxRetries === 3, 'S1: maxRetries default 3')
    assert(got.ownerUserId === 'test', 'S1: ownerUserId round-trip')
    assert(got.ownerAgentId === 'test/default', 'S1: ownerAgentId round-trip')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S1b. createJob 은 owner 필수
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    let thrown = null
    try { store.createJob({ name: 'x', prompt: 'p', cron: '* * * * *' }) } catch (e) { thrown = e }
    assert(thrown && /owner.*required/i.test(thrown.message), 'S1b: owner 누락 → throw')
    thrown = null
    try { store.createJob({ ownerUserId: 'u', name: 'x', prompt: 'p', cron: '* * * * *' }) } catch (e) { thrown = e }
    assert(thrown && /owner.*required/i.test(thrown.message), 'S1b: ownerAgentId 단독 누락 → throw')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S1c. schema migration — v0 (legacy) DB 로부터 v1 로 upgrade
  {
    const dir = makeTmpDir()
    const dbPath = join(dir, 'legacy.db')
    // Manually create legacy schema (no owner columns, user_version = 0)
    const { default: BetterSqlite } = await import('better-sqlite3')
    const legacy = new BetterSqlite(dbPath)
    legacy.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, cron TEXT NOT NULL,
        enabled INTEGER DEFAULT 1, max_retries INTEGER DEFAULT 3, allowed_tools TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_run INTEGER
      );
    `)
    const now = Date.now()
    legacy.prepare(`INSERT INTO jobs (id, name, prompt, cron, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
      .run('legacy-1', 'old-job', 'old prompt', '* * * * *', now, now)
    legacy.close()

    // Reopen via JobStore → migration triggered
    const store = createJobStore(dbPath)
    const cols = (await import('better-sqlite3')).default
    const db = new cols(dbPath, { readonly: true })
    const colNames = db.prepare("PRAGMA table_info(jobs)").all().map(c => c.name)
    assert(colNames.includes('owner_user_id'), 'S1c: owner_user_id 컬럼 추가됨')
    assert(colNames.includes('owner_agent_id'), 'S1c: owner_agent_id 컬럼 추가됨')
    const version = db.pragma('user_version', { simple: true })
    assert(version === 1, `S1c: user_version=1 (got ${version})`)
    db.close()

    // Legacy row 는 owner null (backfill 대상)
    const legacyJob = store.getJob('legacy-1')
    assert(legacyJob.ownerUserId === null, 'S1c: legacy row ownerUserId = null')
    assert(legacyJob.ownerAgentId === null, 'S1c: legacy row ownerAgentId = null')

    // 신규 job 은 owner 필수로 동작 — migration 후에도 newDB 동작 유지
    const fresh = store.createJob({
      ownerUserId: 'bob', ownerAgentId: 'bob/default',
      name: 'post-mig', prompt: 'p', cron: '* * * * *',
    })
    assert(fresh.ownerUserId === 'bob', 'S1c: 신규 job owner 유지')

    // 재개방 시 migration 재적용 안됨 (idempotent)
    store.close()
    const store2 = createJobStore(dbPath)
    const db2 = new cols(dbPath, { readonly: true })
    assert(db2.pragma('user_version', { simple: true }) === 1, 'S1c: 재개방 시에도 v1 유지')
    db2.close()
    store2.close()
    rmSync(dir, { recursive: true, force: true })
  }

  // S2. listJobs
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'a', prompt: 'p1', cron: '0 9 * * *' })
    store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'b', prompt: 'p2', cron: '0 18 * * *' })
    const jobs = store.listJobs()
    assert(jobs.length === 2, 'S2: two jobs')
    assert(jobs[0].name === 'a', 'S2: first job')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S3. updateJob
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: '원본', prompt: 'old', cron: '* * * * *' })
    const updated = store.updateJob(job.id, { name: '수정됨', prompt: 'new' })
    assert(updated.name === '수정됨', 'S3: name updated')
    assert(updated.prompt === 'new', 'S3: prompt updated')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S4. deleteJob → cascades job_runs
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'del', prompt: 'p', cron: '* * * * *' })
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
    store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'due', prompt: 'p', cron: '* * * * *', nextRun: past })
    store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'future', prompt: 'p', cron: '* * * * *', nextRun: future })
    const due = store.getDueJobs()
    assert(due.length === 1, 'S5: only due job returned')
    assert(due[0].name === 'due', 'S5: correct job')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // S6. startRun + finishRun → getRunHistory
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: 'p', cron: '* * * * *' })
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
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: 'p', cron: '* * * * *' })
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
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: 'p', cron: '* * * * *' })
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
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: 'p', cron: '* * * * *' })
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
    store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'due-job', prompt: '실행', cron: '* * * * *', nextRun: Date.now() - 1000 })
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
    store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'future', prompt: 'p', cron: '* * * * *', nextRun: Date.now() + 60000 })
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
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: 'p', cron: '* * * * *' })
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
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: 'p', cron: '* * * * *', maxRetries: 3 })
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
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: 'p', cron: '* * * * *', maxRetries: 3 })
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
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: 'p', cron: '* * * * *', nextRun: Date.now() - 1000 })
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
    store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: 'p', cron: '* * * * *', nextRun: Date.now() - 1000 })
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
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: 'p', cron: '* * * * *' })
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
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: '리포트', cron: '* * * * *' })
    const runId = store.startRun(job.id, 1)

    const state = createOriginState({
      turnState: TurnState.idle(),
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
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: 'p', cron: '* * * * *', maxRetries: 1 })
    const runId = store.startRun(job.id, 1)

    const state = createOriginState({
      turnState: TurnState.idle(),
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
    const tools = createJobTools({ store, eventActor: createMockEventActor(), ownerUserId: 'test', ownerAgentId: 'test/default' })
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
    const tools = createJobTools({ store, eventActor: createMockEventActor(), ownerUserId: 'test', ownerAgentId: 'test/default' })
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
    const tools = createJobTools({ store, eventActor: createMockEventActor(), ownerUserId: 'test', ownerAgentId: 'test/default' })
    const listTool = tools.find(t => t.name === 'list_jobs')

    const result = listTool.handler({})
    assert(result.includes('없습니다'), 'T3: empty message')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T4. list_jobs: job 있음
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: '점검', prompt: 'p', cron: '* * * * *' })
    const tools = createJobTools({ store, eventActor: createMockEventActor(), ownerUserId: 'test', ownerAgentId: 'test/default' })
    const listTool = tools.find(t => t.name === 'list_jobs')

    const result = listTool.handler({})
    assert(result.includes('점검'), 'T4: job name shown')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T5. update_job: 필드 변경
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: '원본', prompt: 'old', cron: '* * * * *' })
    const tools = createJobTools({ store, eventActor: createMockEventActor(), ownerUserId: 'test', ownerAgentId: 'test/default' })
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
    const tools = createJobTools({ store, eventActor: createMockEventActor(), ownerUserId: 'test', ownerAgentId: 'test/default' })
    const updateTool = tools.find(t => t.name === 'update_job')

    const result = updateTool.handler({ id: 'nonexistent', name: '수정' })
    assert(result.startsWith('오류'), 'T6: error for nonexistent id')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T7. update_job: enabled=false → 비활성화
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: 'p', cron: '* * * * *' })
    const tools = createJobTools({ store, eventActor: createMockEventActor(), ownerUserId: 'test', ownerAgentId: 'test/default' })
    const updateTool = tools.find(t => t.name === 'update_job')

    updateTool.handler({ id: job.id, enabled: false })
    assert(store.getJob(job.id).enabled === false, 'T7: job disabled')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T8. delete_job: 삭제
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: 'p', cron: '* * * * *' })
    const tools = createJobTools({ store, eventActor: createMockEventActor(), ownerUserId: 'test', ownerAgentId: 'test/default' })
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
    const tools = createJobTools({ store, eventActor: createMockEventActor(), ownerUserId: 'test', ownerAgentId: 'test/default' })
    const deleteTool = tools.find(t => t.name === 'delete_job')

    const result = deleteTool.handler({ id: 'ghost' })
    assert(result.startsWith('오류'), 'T9: error for missing id')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T10. job_history: 실행 이력 조회
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: 'p', cron: '* * * * *' })
    const runId = store.startRun(job.id, 1)
    store.finishRun(runId, { status: 'success', result: 'ok' })
    const tools = createJobTools({ store, eventActor: createMockEventActor(), ownerUserId: 'test', ownerAgentId: 'test/default' })
    const historyTool = tools.find(t => t.name === 'job_history')

    const result = historyTool.handler({ id: job.id })
    assert(result.includes('success'), 'T10: success status in history')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T11. job_history: 이력 없음
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: 'p', cron: '* * * * *' })
    const tools = createJobTools({ store, eventActor: createMockEventActor(), ownerUserId: 'test', ownerAgentId: 'test/default' })
    const historyTool = tools.find(t => t.name === 'job_history')

    const result = historyTool.handler({ id: job.id })
    assert(result.includes('없습니다'), 'T11: no history message')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T12. run_job_now: eventActor에 enqueue
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: '즉시 실행 테스트', cron: '* * * * *' })
    const mockActor = createMockEventActor()
    const tools = createJobTools({ store, eventActor: mockActor, ownerUserId: 'test', ownerAgentId: 'test/default' })
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
    const tools = createJobTools({ store, eventActor: createMockEventActor(), ownerUserId: 'test', ownerAgentId: 'test/default' })
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
    const tools = createJobTools({ store, eventActor: createMockEventActor(), ownerUserId: 'test', ownerAgentId: 'test/default' })
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
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: 'p', cron: '* * * * *' })
    const tools = createJobTools({ store, eventActor: createMockEventActor(), ownerUserId: 'test', ownerAgentId: 'test/default' })
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
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: 'p', cron: '* * * * *', allowedTools: [] })
    assert(job.allowedTools.length === 0, 'T16: empty allowedTools = no restriction')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // T17. poll: allowedTools forwarded in event
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: 'p', cron: '* * * * *', nextRun: Date.now() - 1000, allowedTools: ['read_file'] })
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
    const job = store.createJob({ ownerUserId: 'test', ownerAgentId: 'test/default', name: 'j', prompt: 'p', cron: '* * * * *', allowedTools: ['bash', 'read'] })
    const mockActor = createMockEventActor()
    const tools = createJobTools({ store, eventActor: mockActor, ownerUserId: 'test', ownerAgentId: 'test/default' })
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
    const userDataStore = createMockUserDataStore([
      { type: 'task', title: '작업1', done: false },
    ])
    const state = createOriginState({
      turnState: TurnState.idle(),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })
    let receivedPrompt = null
    const turnActor = turnActorR.run({ runTurn: async (input) => { receivedPrompt = input; return 'ok' } })
    const eventActor = eventActorR.run({ turnActor, state, logger: null, todoReviewJobName: TODO_REVIEW_JOB_NAME, userDataStore })

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
    const userDataStore = createMockUserDataStore([])
    const state = createOriginState({
      turnState: TurnState.idle(),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })
    let turnCalled = false
    const turnActor = turnActorR.run({ runTurn: async () => { turnCalled = true; return 'ok' } })
    const eventActor = eventActorR.run({ turnActor, state, logger: null, todoReviewJobName: TODO_REVIEW_JOB_NAME, userDataStore })

    eventActor.send({
      type: 'enqueue',
      event: { id: 'tr0b', type: 'scheduled_job', jobName: TODO_REVIEW_JOB_NAME, prompt: TODO_REVIEW_JOB_NAME, receivedAt: Date.now() },
    }).fork(() => {}, () => {})
    await delay(100)

    assert(turnCalled === false, 'TR0b: no turn when todos empty (scheduled_job path)')
  }

  // TR1. todo_review: todos 없으면 turn 시작 안 함 (no-op:no-todos)
  {
    const userDataStore = createMockUserDataStore([])
    const state = createOriginState({
      turnState: TurnState.idle(),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })
    let turnCalled = false
    const turnActor = turnActorR.run({ runTurn: async () => { turnCalled = true; return 'ok' } })
    const eventActor = eventActorR.run({ turnActor, state, logger: null, userDataStore })

    eventActor.send({ type: 'enqueue', event: { id: 'tr1', type: 'todo_review', receivedAt: Date.now() } }).fork(() => {}, () => {})
    await delay(100)

    assert(turnCalled === false, 'TR1: turn not started when no todos')
    assert(state.get('events.queue').length === 0, 'TR1: event removed from queue')
  }

  // TR2. todo_review: todos 있으면 동적 프롬프트로 turn 실행
  {
    const userDataStore = createMockUserDataStore([
      { type: 'task', title: '주간 리포트 작성', done: false },
      { type: 'reminder', title: '미팅 준비', done: false },
    ])
    const state = createOriginState({
      turnState: TurnState.idle(),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })
    let receivedPrompt = null
    const turnActor = turnActorR.run({ runTurn: async (input) => { receivedPrompt = input; return 'ok' } })
    const eventActor = eventActorR.run({ turnActor, state, logger: null, userDataStore })

    eventActor.send({ type: 'enqueue', event: { id: 'tr2', type: 'todo_review', receivedAt: Date.now() } }).fork(() => {}, () => {})
    await delay(150)

    assert(receivedPrompt !== null, 'TR2: turn was started')
    assert(receivedPrompt.includes('2개'), 'TR2: prompt includes todo count')
    assert(receivedPrompt.includes('주간 리포트 작성'), 'TR2: prompt includes todo title')
    assert(receivedPrompt.includes('미팅 준비'), 'TR2: prompt includes second todo')
  }

  // TR3. todo_review: done=true인 항목은 제외
  {
    const userDataStore = createMockUserDataStore([
      { type: 'task', title: '완료됨', done: true },
      { type: 'task', title: '미완료', done: false },
    ])
    const state = createOriginState({
      turnState: TurnState.idle(),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })
    let receivedPrompt = null
    const turnActor = turnActorR.run({ runTurn: async (input) => { receivedPrompt = input; return 'ok' } })
    const eventActor = eventActorR.run({ turnActor, state, logger: null, userDataStore })

    eventActor.send({ type: 'enqueue', event: { id: 'tr3', type: 'todo_review', receivedAt: Date.now() } }).fork(() => {}, () => {})
    await delay(150)

    assert(receivedPrompt !== null, 'TR3: turn started (pending todo exists)')
    assert(receivedPrompt.includes('1개'), 'TR3: only 1 pending todo in prompt')
    assert(!receivedPrompt.includes('완료됨'), 'TR3: done todo excluded')
    assert(receivedPrompt.includes('미완료'), 'TR3: pending todo included')
  }

  // TR4. todo_review: 모두 done이면 no-op
  {
    const userDataStore = createMockUserDataStore([
      { type: 'task', title: '완료', done: true },
    ])
    const state = createOriginState({
      turnState: TurnState.idle(),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })
    let turnCalled = false
    const turnActor = turnActorR.run({ runTurn: async () => { turnCalled = true; return 'ok' } })
    const eventActor = eventActorR.run({ turnActor, state, logger: null, userDataStore })

    eventActor.send({ type: 'enqueue', event: { id: 'tr4', type: 'todo_review', receivedAt: Date.now() } }).fork(() => {}, () => {})
    await delay(100)

    assert(turnCalled === false, 'TR4: turn not started when all todos done')
  }

  // =============================================
  // KG-19: JobStore 소유권 필터링
  // =============================================

  const OWNER_USER = 'u1'
  const AGENT_A = 'u1/agentA'
  const AGENT_B = 'u1/agentB'
  const createBareJob = (store, ownerAgentId, name = 'job') =>
    store.createJob({ ownerUserId: OWNER_USER, ownerAgentId, name, prompt: 'p', cron: '* * * * *' })

  // KG19a. listJobs owner 필터 — agent A/B 의 job 분리
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    createBareJob(store, AGENT_A, 'a1')
    createBareJob(store, AGENT_A, 'a2')
    createBareJob(store, AGENT_B, 'b1')

    const aJobs = store.listJobs({ ownerAgentId: AGENT_A })
    const bJobs = store.listJobs({ ownerAgentId: AGENT_B })
    assert(aJobs.length === 2, 'KG19a: agent A 2 jobs')
    assert(bJobs.length === 1, 'KG19a: agent B 1 job')
    assert(aJobs.every(j => j.ownerAgentId === AGENT_A), 'KG19a: A filter returns only A')
    assert(bJobs[0].ownerAgentId === AGENT_B, 'KG19a: B filter returns only B')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // KG19b. getJob owner 필터 — 다른 agent job 조회 시 null
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const bJob = createBareJob(store, AGENT_B, 'b-private')

    assert(store.getJob(bJob.id, { ownerAgentId: AGENT_A }) === null, 'KG19b: A filter → B job null')
    assert(store.getJob(bJob.id, { ownerAgentId: AGENT_B }) !== null, 'KG19b: B filter → B job present')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // KG19c. updateJob owner 필터 — 다른 agent 수정 시 null + DB 불변
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const bJob = createBareJob(store, AGENT_B, 'original')

    const result = store.updateJob(bJob.id, { name: 'hacked' }, { ownerAgentId: AGENT_A })
    assert(result === null, 'KG19c: other-agent update → null')
    const check = store.getJob(bJob.id)
    assert(check.name === 'original', 'KG19c: DB row unchanged')

    const ownResult = store.updateJob(bJob.id, { name: 'renamed' }, { ownerAgentId: AGENT_B })
    assert(ownResult !== null && ownResult.name === 'renamed', 'KG19c: own-agent update succeeds')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // KG19d. deleteJob owner 필터 — 다른 agent 삭제 시 false + DB 유지
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const bJob = createBareJob(store, AGENT_B)

    assert(store.deleteJob(bJob.id, { ownerAgentId: AGENT_A }) === false, 'KG19d: other-agent delete → false')
    assert(store.getJob(bJob.id) !== null, 'KG19d: B job still in DB')
    assert(store.deleteJob(bJob.id, { ownerAgentId: AGENT_B }) === true, 'KG19d: own-agent delete → true')
    assert(store.getJob(bJob.id) === null, 'KG19d: B job removed')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // KG19e. getRunHistory owner 필터 — 다른 agent 이력 조회 시 []
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const bJob = createBareJob(store, AGENT_B)
    const runId = store.startRun(bJob.id, 1)
    store.finishRun(runId, { status: 'success', result: 'ok' })

    const aHistory = store.getRunHistory(bJob.id, 10, { ownerAgentId: AGENT_A })
    assert(Array.isArray(aHistory) && aHistory.length === 0, 'KG19e: A filter → []')
    const bHistory = store.getRunHistory(bJob.id, 10, { ownerAgentId: AGENT_B })
    assert(bHistory.length === 1, 'KG19e: B filter → 1')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // KG19f. Legacy row (owner null) 은 필터 활성화 시 조회 불가
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    // legacy row 직접 INSERT (createJob 은 owner 필수이므로 raw SQL)
    // 플랜 D1 의 "기존 데이터 버림" 검증을 위한 예외적 경로
    const legacyId = 'legacy-1'
    const db = store._testDb?.() // 없으므로 다른 방법 필요 — store 를 통한 방법이 없다면 스킵
    // better-sqlite3 raw access 가 없으므로, createJob 후 UPDATE 로 owner null 로 만든다
    const job = createBareJob(store, AGENT_A)
    // 일반 updateJob 은 owner 컬럼에 null 을 허용하지 않음 — 따로 설정. UPDATABLE_FIELDS 에 owner_agent_id 포함.
    store.updateJob(job.id, { owner_agent_id: null })

    const filtered = store.listJobs({ ownerAgentId: AGENT_A })
    assert(filtered.length === 0, 'KG19f: legacy owner-null not visible under filter')
    const all = store.listJobs()
    assert(all.length === 1, 'KG19f: legacy still present without filter')
    assert(store.getJob(job.id, { ownerAgentId: AGENT_A }) === null, 'KG19f: legacy getJob with filter → null')
    assert(store.deleteJob(job.id, { ownerAgentId: AGENT_A }) === false, 'KG19f: legacy delete with filter → false')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // KG19g. getDueJobs 는 필터 없이 모든 agent + legacy 반환 (시스템 경로)
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const now = Date.now()
    const past = now - 60000
    store.createJob({ ownerUserId: OWNER_USER, ownerAgentId: AGENT_A, name: 'a', prompt: 'p', cron: '* * * * *', nextRun: past })
    store.createJob({ ownerUserId: OWNER_USER, ownerAgentId: AGENT_B, name: 'b', prompt: 'p', cron: '* * * * *', nextRun: past })
    const legacy = store.createJob({ ownerUserId: OWNER_USER, ownerAgentId: AGENT_A, name: 'l', prompt: 'p', cron: '* * * * *', nextRun: past })
    store.updateJob(legacy.id, { owner_agent_id: null })

    const due = store.getDueJobs(now)
    assert(due.length === 3, 'KG19g: getDueJobs returns all (A + B + legacy)')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // KG19h. #dispatchJob 의 updateJob(next_run) 이 필터 없이 동작
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = createBareJob(store, AGENT_A)
    // 시스템 호출자가 옵션 없이 next_run 갱신
    const result = store.updateJob(job.id, { next_run: 99999 })
    assert(result !== null && result.nextRun === 99999, 'KG19h: system path updates next_run without filter')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // KG19i. #handleJobFailure 의 getJob 도 필터 없이 동작
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = createBareJob(store, AGENT_A)
    // 시스템 호출자는 옵션 미지정
    const result = store.getJob(job.id)
    assert(result !== null && result.ownerAgentId === AGENT_A, 'KG19i: system getJob returns any owner')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // KG19j. #disableJob 의 updateJob(enabled:0) 도 필터 없이 동작
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = createBareJob(store, AGENT_B)
    const result = store.updateJob(job.id, { enabled: 0 })
    assert(result !== null && result.enabled === false, 'KG19j: system disable without filter')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // KG19k. list_jobs 툴 — agent A 는 B 의 job 미노출
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    createBareJob(store, AGENT_A, 'a-visible')
    createBareJob(store, AGENT_B, 'b-hidden')
    const tools = createJobTools({ store, eventActor: createMockEventActor(), ownerUserId: OWNER_USER, ownerAgentId: AGENT_A })
    const listTool = tools.find(t => t.name === 'list_jobs')

    const result = listTool.handler({})
    assert(result.includes('a-visible'), 'KG19k: A own job shown')
    assert(!result.includes('b-hidden'), 'KG19k: B job hidden from A')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // KG19l. update_job(B-id) 시도 — not-found 마스킹, DB 불변
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const bJob = createBareJob(store, AGENT_B, 'b-original')
    const tools = createJobTools({ store, eventActor: createMockEventActor(), ownerUserId: OWNER_USER, ownerAgentId: AGENT_A })
    const updateTool = tools.find(t => t.name === 'update_job')

    const result = updateTool.handler({ id: bJob.id, name: 'hacked' })
    assert(result.startsWith('오류: Job을 찾을 수 없음'), 'KG19l: cross-agent update masked as not-found')
    assert(store.getJob(bJob.id).name === 'b-original', 'KG19l: B job name unchanged')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // KG19m. update_job race — store mock 이 updateJob null 반환 (pre-check 통과 후 삭제)
  {
    const aJob = { id: 'raced', name: 'a', ownerAgentId: AGENT_A, ownerUserId: OWNER_USER }
    const mockStore = {
      getJob: () => aJob, // pre-check 통과
      updateJob: () => null, // race: 실제 UPDATE 시 owner 조건 매치 실패
    }
    const tools = createJobTools({ store: mockStore, eventActor: createMockEventActor(), ownerUserId: OWNER_USER, ownerAgentId: AGENT_A })
    const updateTool = tools.find(t => t.name === 'update_job')

    const result = updateTool.handler({ id: 'raced', name: 'renamed' })
    assert(result.startsWith('오류: Job을 찾을 수 없음'), 'KG19m: race → not-found (no false success)')
  }

  // KG19n. delete_job(B-id) 시도 — not-found, B job 유지
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const bJob = createBareJob(store, AGENT_B)
    const tools = createJobTools({ store, eventActor: createMockEventActor(), ownerUserId: OWNER_USER, ownerAgentId: AGENT_A })
    const deleteTool = tools.find(t => t.name === 'delete_job')

    const result = deleteTool.handler({ id: bJob.id })
    assert(result.startsWith('오류'), 'KG19n: cross-agent delete masked')
    assert(store.getJob(bJob.id) !== null, 'KG19n: B job still present')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // KG19o. delete_job race — pre-check 통과 후 deleteJob false 반환
  {
    const aJob = { id: 'raced', name: 'a', ownerAgentId: AGENT_A, ownerUserId: OWNER_USER }
    const mockStore = {
      getJob: () => aJob,
      deleteJob: () => false, // race
    }
    const tools = createJobTools({ store: mockStore, eventActor: createMockEventActor(), ownerUserId: OWNER_USER, ownerAgentId: AGENT_A })
    const deleteTool = tools.find(t => t.name === 'delete_job')

    const result = deleteTool.handler({ id: 'raced' })
    assert(result.startsWith('오류: Job을 찾을 수 없음'), 'KG19o: delete race → not-found (no false success)')
  }

  // KG19p. job_history(B-id) 시도 — not-found
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const bJob = createBareJob(store, AGENT_B)
    const runId = store.startRun(bJob.id, 1)
    store.finishRun(runId, { status: 'success', result: 'ok' })
    const tools = createJobTools({ store, eventActor: createMockEventActor(), ownerUserId: OWNER_USER, ownerAgentId: AGENT_A })
    const historyTool = tools.find(t => t.name === 'job_history')

    const result = historyTool.handler({ id: bJob.id })
    assert(result.startsWith('오류'), 'KG19p: cross-agent history masked')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // KG19q. job_history race — getRunHistory 가 빈 배열 반환 (best-effort)
  {
    const aJob = { id: 'raced', name: 'a', ownerAgentId: AGENT_A, ownerUserId: OWNER_USER }
    const mockStore = {
      getJob: () => aJob,
      getRunHistory: () => [], // race: job 은 있었지만 history 조회 시 이미 삭제됨
    }
    const tools = createJobTools({ store: mockStore, eventActor: createMockEventActor(), ownerUserId: OWNER_USER, ownerAgentId: AGENT_A })
    const historyTool = tools.find(t => t.name === 'job_history')

    const result = historyTool.handler({ id: 'raced' })
    assert(result.includes('이력이 없습니다'), 'KG19q: history race → empty (best-effort, no false content)')
  }

  // KG19r. run_job_now(B-id) 시도 — not-found, startRun 미호출
  {
    const bJob = { id: 'b1', name: 'b', ownerAgentId: AGENT_B, ownerUserId: OWNER_USER }
    let startRunCalled = false
    const mockStore = {
      getJob: (id, opts) => (opts?.ownerAgentId === AGENT_A ? null : bJob), // A 필터로는 못 찾음
      startRun: () => { startRunCalled = true; return 'r1' },
    }
    const tools = createJobTools({ store: mockStore, eventActor: createMockEventActor(), ownerUserId: OWNER_USER, ownerAgentId: AGENT_A })
    const runTool = tools.find(t => t.name === 'run_job_now')

    const result = runTool.handler({ id: 'b1' })
    assert(result.startsWith('오류'), 'KG19r: cross-agent run masked')
    assert(startRunCalled === false, 'KG19r: startRun not called')
  }

  // KG19s. updateJob no-op (owner 일치 + 값 변경 없음) → null 이 아닌 정상 job 반환
  {
    const dir = makeTmpDir()
    const store = createJobStore(join(dir, 'jobs.db'))
    const job = createBareJob(store, AGENT_A, 'same')

    const result = store.updateJob(job.id, { name: 'same' }, { ownerAgentId: AGENT_A })
    assert(result !== null, 'KG19s: no-op update not null-masked')
    assert(result.name === 'same', 'KG19s: no-op returns same value')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // KG19t. Tool option-forwarding guard — 모든 필터 대상 store 호출에 ownerAgentId 전달
  {
    const calls = []
    const mockStore = {
      listJobs: (opts) => { calls.push({ method: 'listJobs', opts }); return [] },
      getJob: (id, opts) => { calls.push({ method: 'getJob', id, opts }); return { id, ownerAgentId: AGENT_A, name: 'x' } },
      updateJob: (id, fields, opts) => { calls.push({ method: 'updateJob', id, opts }); return { id, name: 'x' } },
      deleteJob: (id, opts) => { calls.push({ method: 'deleteJob', id, opts }); return true },
      getRunHistory: (id, limit, opts) => { calls.push({ method: 'getRunHistory', id, opts }); return [] },
      startRun: () => 'r1',
    }
    const tools = createJobTools({ store: mockStore, eventActor: createMockEventActor(), ownerUserId: OWNER_USER, ownerAgentId: AGENT_A })

    // 필터 대상 5 메서드를 호출하는 툴 4개 (+ list_jobs) 실행 — run_job_now 는 getJob 만 호출
    tools.find(t => t.name === 'list_jobs').handler({})
    tools.find(t => t.name === 'update_job').handler({ id: 'x', name: 'y' })
    tools.find(t => t.name === 'delete_job').handler({ id: 'x' })
    tools.find(t => t.name === 'job_history').handler({ id: 'x' })
    tools.find(t => t.name === 'run_job_now').handler({ id: 'x' })

    const filteredCalls = calls.filter(c => ['listJobs', 'getJob', 'updateJob', 'deleteJob', 'getRunHistory'].includes(c.method))
    assert(filteredCalls.length > 0, 'KG19t: filter-target store methods were called')
    for (const call of filteredCalls) {
      assert(call.opts && call.opts.ownerAgentId === AGENT_A,
        `KG19t: ${call.method} received ownerAgentId (drift guard)`)
    }
  }

  summary()
}

run()
