import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGlobalContext, createSession } from '../../src/main.js'
import { Phase } from '../../src/core/agent.js'
import { assert, summary } from '../lib/assert.js'

const delay = (ms) => new Promise(r => setTimeout(r, ms))

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
  const globalCtx = await createGlobalContext(config)

  try {
    // SD1. user 세션: 정상 동작
    {
      const sessionDir = join(tmpDir, 'sd1')
      const session = createSession(globalCtx, { type: 'user', persistenceCwd: sessionDir })
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
      const userSession = createSession(globalCtx, { type: 'user', persistenceCwd: userDir })
      await userSession.handleInput('저장용 입력')
      await userSession.shutdown()  // flush

      // ephemeral 세션: 같은 경로여도 restore 안 함
      const ephSession = createSession(globalCtx, { type: 'scheduled', persistenceCwd: userDir })
      assert(ephSession.state.get('turn') === 0, 'SD2: ephemeral starts at turn 0 (no restore)')
      assert(ephSession.schedulerActor === null, 'SD2: ephemeral has no local schedulerActor')
      await ephSession.shutdown()
    }

    // SD3. ephemeral 세션: onScheduledJobDone 콜백
    {
      const done = []
      const session = createSession(globalCtx, {
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

      // globalCtx.toolRegistry에 테스트 툴 등록
      const trackerTool = {
        name: 'tracker',
        description: 'track calls',
        parameters: { type: 'object', properties: {} },
        handler: () => { toolCalled.push(1); return 'tracked' },
      }

      // allowedTools를 사용하는 session: USER로 만들어야 job 툴 포함
      const freshCtx = await createGlobalContext(config)
      const sd3bSession = createSession(freshCtx, {
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
      const session = createSession(globalCtx, {
        type: 'user',
        idleTimeoutMs: 100,
        onIdle: () => idled.push(Date.now()),
      })

      // turnState를 비-idle로 변경 후 idle로 돌아오면 타이머 시작
      session.state.set('turnState', Phase.working())
      await delay(10)
      session.state.set('turnState', Phase.idle())
      await delay(200)

      assert(idled.length === 1, 'SD4: onIdle called after idle timeout')
      await session.shutdown()
    }

    // SD5. idle timeout: 턴 시작 시 타이머 취소
    {
      const idled = []
      const session = createSession(globalCtx, {
        type: 'user',
        idleTimeoutMs: 200,
        onIdle: () => idled.push(Date.now()),
      })

      // idle → working (타이머 취소) → idle
      session.state.set('turnState', Phase.working())
      await delay(10)
      session.state.set('turnState', Phase.idle())
      await delay(50)  // 아직 timeout 전
      session.state.set('turnState', Phase.working())  // 타이머 취소
      await delay(300)  // timeout 지났어도 canceled

      assert(idled.length === 0, 'SD5: onIdle not called when turn interrupted timer')

      // idle로 돌아오면 새 타이머 시작
      session.state.set('turnState', Phase.idle())
      await delay(300)
      assert(idled.length === 1, 'SD5: onIdle fires after second idle')
      await session.shutdown()
    }

  } finally {
    await globalCtx.shutdown()
    await mockLLM.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }

  summary()
}

run()
