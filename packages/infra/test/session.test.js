import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { UserContext } from '@presence/infra/infra/user-context.js'
import { Session as SessionModule } from '@presence/infra/infra/sessions/index.js'
import { TurnState } from '@presence/core/core/policies.js'
import { assert, summary } from '../../../test/lib/assert.js'

const delay = (ms) => new Promise(r => setTimeout(r, ms))

// agentId 기본값을 자동 주입하는 테스트 helper (M1 fixture).
const TEST_AGENT_ID = 'test/default'
const Session = {
  create: (uc, opts = {}) => SessionModule.create(uc, { agentId: TEST_AGENT_ID, ...opts }),
}

const createMockLLM = (handler) => {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      calls.push(parsed)
      const response = handler(parsed, calls.length)
      const content = typeof response === 'string' ? response : JSON.stringify(response)
      if (parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content } }] }))
      }
    })
  })
  return {
    calls,
    start: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

const createTestConfig = (port, tmpDir) => ({
  llm: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test', apiKey: 'k', responseFormat: 'json_object', maxRetries: 0, timeoutMs: 5000 },
  embed: { provider: 'openai', baseUrl: null, apiKey: null, model: null, dimensions: 256 },
  locale: 'ko', maxIterations: 5,
  memory: { path: join(tmpDir, 'memory') },
  mcp: [],
  scheduler: { enabled: false, pollIntervalMs: 60000, todoReview: { enabled: false, cron: '0 9 * * *' } },
  delegatePolling: { intervalMs: 60000 },
  prompt: { maxContextTokens: 8000, reservedOutputTokens: 1000, maxContextChars: null, reservedOutputChars: null },
})

async function run() {
  console.log('Session lifecycle tests')

  const tmpDir = mkdtempSync(join(tmpdir(), 'presence-session-'))
  const mockLLM = createMockLLM(() =>
    JSON.stringify({ type: 'direct_response', message: '응답' })
  )
  const llmPort = await mockLLM.start()
  const config = createTestConfig(llmPort, tmpDir)
  const userContext = await UserContext.create(config)

  try {
    // SD1. user 세션: 정상 동작
    {
      const sessionDir = join(tmpDir, 'sd1')
      const session = Session.create(userContext, { type: 'user', persistenceCwd: sessionDir })
      assert(session.schedulerActor !== null, 'SD1: user session has local schedulerActor')
      const result = await session.handleInput('안녕')
      assert(result === '응답', 'SD1: response returned')
      assert(session.state.get('turn') === 1, 'SD1: turn incremented')
      await session.shutdown()
    }

    // SD2. ephemeral 세션: persistence restore 건너뜀
    {
      const userDir = join(tmpDir, 'user-restore-test')
      // user 세션으로 상태를 먼저 저장
      const userSession = Session.create(userContext, { type: 'user', persistenceCwd: userDir })
      await userSession.handleInput('저장용 입력')
      await userSession.shutdown()  // flush

      // ephemeral 세션: 같은 경로여도 restore 안 함
      const ephSession = Session.create(userContext, { type: 'scheduled', persistenceCwd: userDir })
      assert(ephSession.state.get('turn') === 0, 'SD2: ephemeral starts at turn 0 (no restore)')
      assert(ephSession.schedulerActor === null, 'SD2: ephemeral has no local schedulerActor')
      await ephSession.shutdown()
    }

    // SD3. ephemeral 세션: onScheduledJobDone 콜백
    {
      const done = []
      const session = Session.create(userContext, {
        type: 'scheduled',
        onScheduledJobDone: (event, outcome) => done.push({ event, outcome }),
      })

      // scheduled_job 이벤트를 EventActor에 직접 주입
      await new Promise((resolve) => {
        session.eventActor.send({
          type: 'enqueue',
          event: {
            id: 'evt-sd3', type: 'scheduled_job', runId: 'run-sd3', jobId: 'job-sd3',
            prompt: '배치 작업 실행', attempt: 1, createdAt: Date.now(),
          },
        }).fork(() => {}, resolve)
      })

      // EventActor drain → turnActor → onEventDone 완료 대기
      await delay(600)

      assert(done.length === 1, 'SD3: onScheduledJobDone called once')
      assert(done[0].event.runId === 'run-sd3', 'SD3: correct runId in callback')
      assert(done[0].outcome.success === true, 'SD3: outcome success')
      await session.shutdown()
    }

    // SD3b. allowedTools: scheduled_job에 allowedTools 있을 때 실행이 깨지지 않음
    // (이전 버그: createAgentTurn 호출 시 agents 변수 없어 ReferenceError)
    {
      const done = []
      const toolCalled = []

      // userContext.toolRegistry에 테스트 툴 등록
      const trackerTool = {
        name: 'tracker',
        description: 'track calls',
        parameters: { type: 'object', properties: {} },
        handler: () => { toolCalled.push(1); return 'tracked' },
      }

      // allowedTools를 사용하는 session: USER로 만들어야 job 툴 포함
      const freshCtx = await UserContext.create(config)
      const sd3bSession = Session.create(freshCtx, {
        type: 'user',
        onScheduledJobDone: (event, outcome) => done.push({ event, outcome }),
      })
      freshCtx.toolRegistry.register(trackerTool)

      await new Promise((resolve) => {
        sd3bSession.eventActor.send({
          type: 'enqueue',
          event: {
            id: 'evt-sd3b', type: 'scheduled_job', runId: 'run-sd3b', jobId: 'job-sd3b',
            prompt: '작업 실행', attempt: 1, createdAt: Date.now(),
            allowedTools: ['tracker'],  // 허용 툴 목록 설정
          },
        }).fork(() => {}, resolve)
      })

      await delay(600)

      // allowedTools > 0 분기가 실행돼도 오류 없이 완료
      assert(done.length === 1, 'SD3b: onScheduledJobDone called with allowedTools set')
      assert(done[0].outcome.success === true, 'SD3b: turn succeeds with allowedTools filtering')

      await sd3bSession.shutdown()
      await freshCtx.shutdown()
    }

    // SD4. idle timeout: turnState idle 전환 후 콜백 실행
    {
      const idled = []
      const session = Session.create(userContext, {
        type: 'user',
        idleTimeoutMs: 100,
        onIdle: () => idled.push(Date.now()),
      })

      // turnState를 비-idle로 변경 후 idle로 돌아오면 타이머 시작
      session.state.set('turnState', TurnState.working())
      await delay(10)
      session.state.set('turnState', TurnState.idle())
      await delay(200)

      assert(idled.length === 1, 'SD4: onIdle called after idle timeout')
      await session.shutdown()
    }

    // SD5. idle timeout: 턴 시작 시 타이머 취소
    {
      const idled = []
      const session = Session.create(userContext, {
        type: 'user',
        idleTimeoutMs: 200,
        onIdle: () => idled.push(Date.now()),
      })

      // idle → working (타이머 취소) → idle
      session.state.set('turnState', TurnState.working())
      await delay(10)
      session.state.set('turnState', TurnState.idle())
      await delay(50)  // 아직 timeout 전
      session.state.set('turnState', TurnState.working())  // 타이머 취소
      await delay(300)  // timeout 지났어도 canceled

      assert(idled.length === 0, 'SD5: onIdle not called when turn interrupted timer')

      // idle로 돌아오면 새 타이머 시작
      session.state.set('turnState', TurnState.idle())
      await delay(300)
      assert(idled.length === 1, 'SD5: onIdle fires after second idle')
      await session.shutdown()
    }

    // SD6. workingDir = Config.userDataPath(userId) 고정 (agent-identity.md I-WD).
    //      opts.workingDir 은 무시됨. pendingBackfill 개념 없음.
    {
      const { Config } = await import('@presence/infra/infra/config.js')
      const userId = 'sd6user'
      const session = Session.create(userContext, {
        type: 'user',
        userId,
        workingDir: '/ignored-by-design',    // 무시되어야 함
        persistenceCwd: join(tmpDir, 'sd6'),
      })
      assert(session.workingDir === Config.userDataPath(userId), 'SD6: workingDir = userDataPath')
      assert(session.pendingBackfill === undefined, 'SD6: pendingBackfill 필드 제거됨')
      await session.shutdown()
    }

    // SD11. agentId 필수 — 미제공 시 throw (M1)
    {
      let thrown = null
      try {
        SessionModule.create(userContext, { type: 'user', persistenceCwd: join(tmpDir, 'sd11') })
      } catch (e) { thrown = e }
      assert(thrown && /agentId/.test(thrown.message), 'SD11: agentId 없으면 throw')
    }

    // SD12. agentId 형식 위반 → throw (M1)
    {
      const invalidIds = ['', 'no-slash', 'Anthony/default', 'a/b/c', '3bot/a', 'a--b/c', 'abc-/def']
      for (const bad of invalidIds) {
        let thrown = null
        try {
          SessionModule.create(userContext, { type: 'user', agentId: bad, persistenceCwd: join(tmpDir, `sd12-${bad || 'empty'}`) })
        } catch (e) { thrown = e }
        assert(thrown, `SD12: invalid agentId "${bad}" → throw`)
      }
    }

    // SD13. agentId round-trip — 생성 시점 값이 persistence 복원보다 우선 (M1)
    {
      const persistCwd = join(tmpDir, 'sd13')
      // 첫 세션: agentId=anthony/alpha 로 생성 + flush
      const s1 = SessionModule.create(userContext, { type: 'user', agentId: 'anthony/alpha', persistenceCwd: persistCwd })
      assert(s1.agentId === 'anthony/alpha', 'SD13: 초기 agentId 설정')
      await s1.flushPersistence()
      await s1.shutdown()

      // 두 번째 세션: 같은 persistence + 다른 agentId 전달 — **생성 시점 값이 우선**
      const s2 = SessionModule.create(userContext, { type: 'user', agentId: 'anthony/beta', persistenceCwd: persistCwd })
      assert(s2.agentId === 'anthony/beta', `SD13: 생성 시점 agentId 우선 (got ${s2.agentId})`)
      await s2.shutdown()
    }

  } finally {
    await userContext.shutdown()
    await mockLLM.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }

  summary()
}

run()
