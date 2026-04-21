import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { UserContext } from '@presence/infra/infra/user-context.js'
import { Session as SessionModule } from '@presence/infra/infra/sessions/index.js'
import { SESSION_TYPE } from '@presence/infra/infra/constants.js'
import { assert, summary } from '../../../test/lib/assert.js'

const delay = (ms) => new Promise(r => setTimeout(r, ms))

// agentId 기본값 주입 (M1 fixture)
const TEST_AGENT_ID = 'test/default'
const Session = {
  create: (uc, opts = {}) => SessionModule.create(uc, { agentId: TEST_AGENT_ID, ...opts }),
}

const createMockLLM = (handler) => {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      const response = handler ? handler(parsed) : JSON.stringify({ type: 'direct_response', message: '응답' })
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
    start: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

const baseConfig = (llmPort, tmpDir) => ({
  llm: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: 'test', apiKey: 'k', responseFormat: 'json_object', maxRetries: 0, timeoutMs: 5000 },
  embed: { provider: 'openai', baseUrl: null, apiKey: null, model: null, dimensions: 256 },
  locale: 'ko', maxIterations: 5,
  memory: { path: join(tmpDir, 'memory') },
  mcp: [],
  scheduler: { enabled: false, pollIntervalMs: 60000, todoReview: { enabled: false, cron: '0 9 * * *' } },
  delegatePolling: { intervalMs: 60000 },
  prompt: { maxContextTokens: 8000, reservedOutputTokens: 1000, maxContextChars: null, reservedOutputChars: null },
  agents: [],
})

async function run() {
  console.log('SESSION_TYPE.AGENT behavior tests')

  const tmpDir = mkdtempSync(join(tmpdir(), 'presence-agent-session-'))
  const mockLLM = createMockLLM()
  const llmPort = await mockLLM.start()
  const config = baseConfig(llmPort, tmpDir)
  const userContext = await UserContext.create(config)

  try {

    // ========================================================================
    // SA1. AGENT 세션: persistence 없음 (항상 turn 0으로 시작)
    // ========================================================================
    {
      // USER 세션으로 먼저 turn 진행 후 flush
      const userDir = join(tmpDir, 'sa1-user')
      const userSession = Session.create(userContext, { type: SESSION_TYPE.USER, persistenceCwd: userDir })
      await userSession.handleInput('저장용 입력')
      assert(userSession.state.get('turn') === 1, 'SA1 setup: user turn incremented')
      await userSession.shutdown()  // flush to disk

      // AGENT 세션: 같은 디렉토리여도 restore 안 함
      const agentSession = Session.create(userContext, { type: SESSION_TYPE.AGENT, persistenceCwd: userDir })
      assert(agentSession.state.get('turn') === 0, 'SA1: agent session starts at turn 0 (no restore)')
      await agentSession.shutdown()
    }

    // ========================================================================
    // SA2. AGENT 세션: schedulerActor === null
    // ========================================================================
    {
      const agentSession = Session.create(userContext, { type: SESSION_TYPE.AGENT })
      assert(agentSession.schedulerActor === null, 'SA2: no schedulerActor in agent session')
      await agentSession.shutdown()
    }

    // ========================================================================
    // SA3. AGENT 세션: job/todo 툴이 없음 — USER 세션이 먼저 만들어진 후여도 마찬가지
    // job/todo 도구는 전역 registry에 등록 — 모든 세션 타입에서 접근 가능
    // ========================================================================
    {
      const freshGlobalCtx = await UserContext.create(config)

      // USER 세션 먼저 생성 (job 도구 전역 등록)
      const userSession = Session.create(freshGlobalCtx, { type: SESSION_TYPE.USER })
      const userToolNames = userSession.tools.map(t => t.name)
      assert(userToolNames.includes('schedule_job'), 'SA3 setup: user session has schedule_job')
      assert(userToolNames.includes('read_todos'), 'SA3 setup: user session has read_todos')

      // AGENT 세션도 전역 도구 접근 가능
      const agentSession = Session.create(freshGlobalCtx, { type: SESSION_TYPE.AGENT })
      const agentToolNames = agentSession.tools.map(t => t.name)
      assert(agentToolNames.includes('schedule_job'), 'SA3: agent session sees schedule_job (global tool)')
      assert(agentToolNames.includes('read_todos'), 'SA3: agent session sees read_todos (global tool)')
      assert(agentToolNames.includes('list_jobs'), 'SA3: agent session sees list_jobs (global tool)')

      await userSession.shutdown()
      await agentSession.shutdown()
      await freshGlobalCtx.shutdown()
    }

    // ========================================================================
    // SA4. AGENT 세션: handleInput 정상 동작 (LLM 응답 반환)
    // ========================================================================
    {
      const agentSession = Session.create(userContext, { type: SESSION_TYPE.AGENT })
      const result = await agentSession.handleInput('안녕')
      assert(typeof result === 'string', 'SA4: handleInput returns string')
      assert(result === '응답', 'SA4: correct LLM response')
      assert(agentSession.state.get('turn') === 1, 'SA4: turn incremented in state')
      await agentSession.shutdown()
    }

    // ========================================================================
    // SA5. AGENT 세션: shutdown 후 disk에 state 저장하지 않음
    // ========================================================================
    {
      const agentDir = join(tmpDir, 'sa5-agent')
      const agentSession = Session.create(userContext, { type: SESSION_TYPE.AGENT, persistenceCwd: agentDir })
      await agentSession.handleInput('저장되지 않아야 함')
      assert(agentSession.state.get('turn') === 1, 'SA5 setup: turn is 1')
      await agentSession.shutdown()

      // 다시 USER 세션으로 같은 경로 로드 → agent 저장 내용 없어야 함
      const freshUserSession = Session.create(userContext, { type: SESSION_TYPE.USER, persistenceCwd: agentDir })
      assert(freshUserSession.state.get('turn') === 0, 'SA5: agent shutdown did not flush state')
      await freshUserSession.shutdown()
    }

    // ========================================================================
    // SA6. USER 세션과 AGENT 세션은 독립적인 state (같은 userContext 공유)
    // persistenceCwd를 명시해 restore 영향 제거, turn 증분으로 검증
    // ========================================================================
    {
      const freshCtx = await UserContext.create(config)
      const sa6Dir = join(tmpDir, 'sa6')
      try {
        const userSession = Session.create(freshCtx, { type: SESSION_TYPE.USER, persistenceCwd: sa6Dir })
        const agentSession = Session.create(freshCtx, { type: SESSION_TYPE.AGENT })

        // 두 세션 state 객체가 독립적인지 확인
        assert(userSession.state !== agentSession.state, 'SA6: different state objects')

        const userTurnBefore = userSession.state.get('turn') || 0
        const agentTurnBefore = agentSession.state.get('turn') || 0

        await userSession.handleInput('user input')
        // user 턴 증가, agent 턴 불변
        assert(userSession.state.get('turn') === userTurnBefore + 1, 'SA6: user turn incremented')
        assert(agentSession.state.get('turn') === agentTurnBefore, 'SA6: agent turn unaffected by user session')

        await agentSession.handleInput('agent input')
        // agent 턴 증가, user 턴 불변
        assert(agentSession.state.get('turn') === agentTurnBefore + 1, 'SA6: agent turn incremented independently')
        assert(userSession.state.get('turn') === userTurnBefore + 1, 'SA6: user turn unaffected by agent session')

        await userSession.shutdown()
        await agentSession.shutdown()
      } finally {
        await freshCtx.shutdown()
      }
    }

    // ========================================================================
    // SA7. AGENT 세션을 agentRegistry에 등록 후 run() 직접 호출
    // ========================================================================
    {
      const freshCtx = await UserContext.create(config)
      try {
        const agentSession = Session.create(freshCtx, { type: SESSION_TYPE.AGENT })
        freshCtx.agentRegistry.register({
          name: 'test-agent-sa7',
          description: '테스트용',
          type: 'local',
          run: (task) => agentSession.handleInput(task),
        })

        const entry = freshCtx.agentRegistry.get('test-agent-sa7')
        assert(entry.isJust(), 'SA7: agent registered in registry')
        const delegateResult = await entry.value.run('위임 작업')
        assert(delegateResult === '응답', 'SA7: agent handleInput called via run()')
        assert(agentSession.state.get('turn') === 1, 'SA7: agent turn incremented via delegation')

        await agentSession.shutdown()
      } finally {
        await freshCtx.shutdown()
      }
    }

    // ========================================================================
    // SA8. AGENT 세션의 delegateActor는 start 가능
    // ========================================================================
    {
      const agentSession = Session.create(userContext, { type: SESSION_TYPE.AGENT })
      assert(agentSession.delegateActor !== undefined, 'SA8: delegateActor exists')
      // start 후 에러 없음
      agentSession.delegateActor.start().fork(() => {}, () => {})
      await delay(50)
      await agentSession.shutdown()
    }

    // ========================================================================
    // SA9. AGENT 세션의 SESSION_TYPE이 policies.js에 등록됨
    // ========================================================================
    {
      assert(SESSION_TYPE.AGENT === 'agent', 'SA9: SESSION_TYPE.AGENT value')
      assert(SESSION_TYPE.USER === 'user', 'SA9: SESSION_TYPE.USER unchanged')
      assert(SESSION_TYPE.SCHEDULED === 'scheduled', 'SA9: SESSION_TYPE.SCHEDULED unchanged')
      assert(Object.keys(SESSION_TYPE).length === 3, 'SA9: exactly 3 session types')
    }

  } finally {
    await userContext.shutdown()
    await mockLLM.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }

  summary()
}

run()
