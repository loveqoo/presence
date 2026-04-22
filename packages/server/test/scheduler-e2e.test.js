/**
 * Scheduler E2E — 실제 서버 기동 후 cron polling 으로 job 이 자동 실행되는지 검증.
 *
 * scheduler.test.js 는 SchedulerActor 단위 테스트. 이 파일은 서버 전체 연동 경로:
 *   scheduler polling → scheduled_job 이벤트 → SCHEDULED session 생성 →
 *   eventActor → turnActor → mock LLM → jobDone → DB 기록
 */

import { createTestServer } from '../../../test/lib/mock-server.js'
import { assert, summary } from '../../../test/lib/assert.js'

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const waitFor = (fn, { timeout = 3000, interval = 50 } = {}) =>
  new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      try { const result = fn(); if (result) return resolve(result) } catch (_) {}
      if (Date.now() - start > timeout) return reject(new Error(`waitFor timeout`))
      setTimeout(check, interval)
    }
    check()
  })

async function run() {
  console.log('Scheduler E2E tests')

  // Scheduler 활성 + 짧은 polling + mock LLM direct_response 반환
  const ctx = await createTestServer(
    (_req, n) => JSON.stringify({ type: 'direct_response', message: `scheduled done ${n}` }),
    { configOverrides: { scheduler: { enabled: true, pollIntervalMs: 200, todoReview: { enabled: false, cron: '0 9 * * *' } } } },
  )
  const { userContext, shutdown } = ctx

  try {
    // SE1. 스케줄러가 due job 을 자동 감지 → 실행 → DB 에 completed 기록
    {
      const store = userContext.jobStore
      // 과거 next_run 으로 job 삽입 → polling 이 즉시 due 로 감지
      const job = store.createJob({
        name: 'e2e-test-job',
        prompt: '테스트 작업 실행',
        cron: '0 0 1 1 *',   // 실제 다음 실행은 먼 미래
        maxRetries: 0,
        nextRun: 1,           // 과거 → polling 이 즉시 due
        ownerUserId: 'default',
        ownerAgentId: 'default/default',
      })

      // scheduler polling (200ms) + turn 실행 + DB update 대기
      await waitFor(() => {
        const runs = store.getRunHistory(job.id, 10)
        return runs.some(r => r.status === 'success')
      }, { timeout: 5000 })

      const runs = store.getRunHistory(job.id, 10)
      assert(runs.length >= 1, `SE1: run 기록 생성 (got ${runs.length})`)
      const last = runs[0]
      assert(last.status === 'success',
        `SE1: run status=success (got ${last.status})`)
      assert(last.finishedAt && last.finishedAt >= last.startedAt,
        'SE1: finishedAt 기록')
    }

    // SE2. cron 미래 설정 시 추가 실행 없음
    {
      const firstJob = userContext.jobStore.listJobs()[0]
      const before = userContext.jobStore.getRunHistory(firstJob.id, 10).length
      await delay(500)
      const after = userContext.jobStore.getRunHistory(firstJob.id, 10).length
      assert(after === before, `SE2: cron 미래 설정 시 추가 실행 없음 (before=${before}, after=${after})`)
    }

    // SE3. SCHEDULED session 의 workingDir 이 allowedDirs[0] 로 명시 결정, pendingBackfill=false
    //      (WS join 이 없으므로 backfill 대상 아님 — 생성 시점에 확정되어야)
    {
      // 새 job 을 만들어 session 생성 시점을 포착
      const store = userContext.jobStore
      const job = store.createJob({
        name: 'wd-check',
        prompt: 'workingDir 확인',
        cron: '0 0 1 1 *',
        maxRetries: 0,
        nextRun: 1,
        ownerUserId: 'default',
        ownerAgentId: 'default/default',
      })
      let capturedSession = null
      const origCreate = userContext.sessions.create.bind(userContext.sessions)
      userContext.sessions.create = (params) => {
        const entry = origCreate(params)
        if (params.type === 'scheduled') capturedSession = entry.session
        return entry
      }
      await waitFor(() => capturedSession !== null, { timeout: 3000 })
      userContext.sessions.create = origCreate
      const expectedWd = userContext.config.tools.allowedDirs[0]
      assert(capturedSession.workingDir === expectedWd,
        `SE3: SCHEDULED.workingDir === allowedDirs[0] (got ${capturedSession.workingDir})`)
      assert(capturedSession.pendingBackfill === false,
        `SE3: SCHEDULED.pendingBackfill=false (got ${capturedSession.pendingBackfill})`)
      // 실행이 완료될 때까지 대기해 리소스 정리 실패 회피
      await waitFor(() => store.getRunHistory(job.id, 10).some(r => r.status === 'success'),
        { timeout: 5000 })
    }
  } finally {
    await shutdown()
  }

  summary()
}

run()
