import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startServer } from '@presence/server'
import { assert, summary } from '../lib/assert.js'

// --- 헬퍼 ---

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

const request = (port, method, path, body) =>
  new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json' } }
    const req = http.request(opts, (res) => {
      let data = ''
      res.on('data', d => { data += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, body: data }) }
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })

const baseConfig = (llmPort, tmpDir, extra = {}) => ({
  llm: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: 'test', apiKey: 'k', responseFormat: 'json_object', maxRetries: 0, timeoutMs: 5000 },
  embed: { provider: 'openai', baseUrl: null, apiKey: null, model: null, dimensions: 256 },
  locale: 'ko', maxIterations: 5,
  memory: { path: join(tmpDir, 'memory') },
  mcp: [],
  scheduler: { enabled: false, pollIntervalMs: 60000, todoReview: { enabled: false, cron: '0 9 * * *' } },
  delegatePolling: { intervalMs: 60000 },
  prompt: { maxContextTokens: 8000, reservedOutputTokens: 1000, maxContextChars: null, reservedOutputChars: null },
  agents: [],
  ...extra,
})

async function run() {
  console.log('Supervisor pattern tests')

  // ==========================================================================
  // SV1. config.agents → agentRegistry에 자동 등록 (메타데이터 정확성)
  // ==========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'presence-sv-'))
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: '응답' }))
    const llmPort = await mockLLM.start()

    const config = baseConfig(llmPort, tmpDir, {
      agents: [
        { name: 'researcher', description: '정보를 조사합니다.', capabilities: ['search', 'read'] },
        { name: 'writer', description: '글을 작성합니다.', capabilities: ['write'] },
      ],
    })

    const { server, shutdown, userContext } = await startServer(config, { port: 0, persistenceCwd: tmpDir })

    try {
      // researcher 등록 확인
      assert(userContext.agentRegistry.has('researcher'), 'SV1: researcher registered')
      const researcher = userContext.agentRegistry.get('researcher').value
      assert(researcher.name === 'researcher', 'SV1: researcher name')
      assert(researcher.description === '정보를 조사합니다.', 'SV1: researcher description')
      assert(researcher.type === 'local', 'SV1: researcher type local')
      assert(typeof researcher.run === 'function', 'SV1: researcher has run function')
      assert(Array.isArray(researcher.capabilities), 'SV1: researcher capabilities is array')
      assert(researcher.capabilities.includes('search'), 'SV1: researcher capability search')
      assert(researcher.capabilities.includes('read'), 'SV1: researcher capability read')

      // writer 등록 확인
      assert(userContext.agentRegistry.has('writer'), 'SV1: writer registered')
      const writer = userContext.agentRegistry.get('writer').value
      assert(writer.capabilities.includes('write'), 'SV1: writer capability write')

      // summarizer(main.js 하드코딩)도 유지
      assert(userContext.agentRegistry.has('summarizer'), 'SV1: summarizer still registered')

      // agentRegistry.list()에 모두 포함
      const names = userContext.agentRegistry.list().map(a => a.name)
      assert(names.includes('researcher'), 'SV1: list includes researcher')
      assert(names.includes('writer'), 'SV1: list includes writer')
      assert(names.includes('summarizer'), 'SV1: list includes summarizer')
    } finally {
      await shutdown()
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // ==========================================================================
  // SV2. /api/sessions 목록: agent 세션 포함, type='agent', id='agent-{name}'
  // ==========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'presence-sv-'))
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: 'ok' }))
    const llmPort = await mockLLM.start()

    const config = baseConfig(llmPort, tmpDir, {
      agents: [
        { name: 'analyst', description: '분석 에이전트', capabilities: [] },
        { name: 'coder', description: '코딩 에이전트', capabilities: [] },
      ],
    })

    const { server, shutdown } = await startServer(config, { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    try {
      const res = await request(port, 'GET', '/api/sessions')
      assert(res.status === 200, 'SV2: GET /api/sessions 200')
      assert(Array.isArray(res.body), 'SV2: returns array')

      const sessions = res.body
      const ids = sessions.map(s => s.id)
      assert(ids.includes('user-default'), 'SV2: user-default present')
      assert(ids.includes('agent-analyst'), 'SV2: agent-analyst present')
      assert(ids.includes('agent-coder'), 'SV2: agent-coder present')
      assert(sessions.length === 3, 'SV2: exactly 3 sessions')

      const analystSession = sessions.find(s => s.id === 'agent-analyst')
      assert(analystSession.type === 'agent', 'SV2: analyst type is agent')

      const coderSession = sessions.find(s => s.id === 'agent-coder')
      assert(coderSession.type === 'agent', 'SV2: coder type is agent')
    } finally {
      await shutdown()
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // ==========================================================================
  // SV3. agent 세션 state는 /api/sessions/:id/state로 독립 조회 가능
  // ==========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'presence-sv-'))
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: 'ok' }))
    const llmPort = await mockLLM.start()

    const config = baseConfig(llmPort, tmpDir, {
      agents: [{ name: 'worker', description: '작업 에이전트', capabilities: [] }],
    })

    const { server, shutdown } = await startServer(config, { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    try {
      const res = await request(port, 'GET', '/api/sessions/agent-worker/state')
      assert(res.status === 200, 'SV3: GET agent session state 200')
      assert(res.body.turnState?.tag === 'idle', 'SV3: agent session starts idle')
      assert(res.body.turn === 0, 'SV3: agent session turn starts at 0')

      // user-default와 별개 확인: user-default에 chat 후 agent state 불변
      await request(port, 'POST', '/api/chat', { input: '안녕' })
      const userState = await request(port, 'GET', '/api/state')
      const agentState = await request(port, 'GET', '/api/sessions/agent-worker/state')

      assert(userState.body.turn === 1, 'SV3: user-default turn incremented')
      assert(agentState.body.turn === 0, 'SV3: agent-worker turn unaffected by user chat')
    } finally {
      await shutdown()
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // ==========================================================================
  // SV4. Supervisor → sub-agent 위임 실행 흐름
  // 호출 순서: supervisor LLM → DELEGATE plan → researcher.run() → researcher LLM
  //           → researcher 응답 → supervisor LLM (iterate) → 최종 응답
  // ==========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'presence-sv-'))
    const callLog = []

    // 시스템 프롬프트에 'agent-researcher'가 포함되면 researcher 호출로 판단
    const mockLLM = createMockLLM((req) => {
      const systemMsg = req.messages?.find(m => m.role === 'system')?.content || ''
      const userMsg = req.messages?.find(m => m.role === 'user')?.content || ''

      // researcher 세션: agents 목록이 없고 user 메시지가 '조사 태스크'
      const isResearcherCall = userMsg === '조사 태스크' && !systemMsg.includes('Available agents')
      callLog.push(isResearcherCall ? 'researcher' : 'supervisor')

      if (!isResearcherCall && callLog.filter(c => c === 'supervisor').length === 1) {
        // supervisor 1차 호출: DELEGATE 플랜 반환
        return JSON.stringify({
          type: 'plan',
          steps: [{ op: 'DELEGATE', args: { target: 'researcher', task: '조사 태스크' } }],
        })
      }
      // supervisor 2차 호출 (위임 결과 수신 후) 또는 researcher 호출: 직접 응답
      return JSON.stringify({ type: 'direct_response', message: '조사 완료' })
    })

    const llmPort = await mockLLM.start()
    const config = baseConfig(llmPort, tmpDir, {
      agents: [{ name: 'researcher', description: '정보를 조사합니다.', capabilities: [] }],
    })

    const { server, shutdown } = await startServer(config, { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    try {
      const res = await request(port, 'POST', '/api/chat', { input: '조사 태스크' })
      assert(res.status === 200, 'SV4: delegation request 200')
      assert(res.body.type === 'agent', 'SV4: type agent')
      assert(typeof res.body.content === 'string', 'SV4: content is string')
      // supervisor LLM은 최소 1번 (DELEGATE plan), researcher LLM 1번 이상 호출
      assert(mockLLM.calls.length >= 2, 'SV4: at least 2 LLM calls (supervisor + researcher)')
    } finally {
      await shutdown()
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // ==========================================================================
  // SV5. 알 수 없는 에이전트에 DELEGATE → Delegation.failed 반환, 턴 실패 아님
  // ==========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'presence-sv-'))
    let callCount = 0
    const mockLLM = createMockLLM(() => {
      callCount++
      if (callCount === 1) {
        return JSON.stringify({
          type: 'plan',
          steps: [{ op: 'DELEGATE', args: { target: 'nonexistent-agent', task: '존재하지 않음' } }],
        })
      }
      // 2차 호출: DELEGATE 실패 결과 수신 후 응답
      return JSON.stringify({ type: 'direct_response', message: '에이전트를 찾을 수 없음' })
    })
    const llmPort = await mockLLM.start()

    const config = baseConfig(llmPort, tmpDir, { agents: [] })
    const { server, shutdown } = await startServer(config, { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    try {
      const res = await request(port, 'POST', '/api/chat', { input: '없는 에이전트에 위임' })
      // 턴은 실패하지 않고 계속 실행됨 (Delegation.failed → 다음 iteration)
      assert(res.status === 200, 'SV5: unknown delegate does not crash turn')
      assert(res.body.type === 'agent', 'SV5: type agent')
      // LLM이 Delegation.failed를 받아 2차 호출됨
      assert(callCount >= 2, 'SV5: supervisor LLM called again after failed delegation')
    } finally {
      await shutdown()
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // ==========================================================================
  // SV6. 여러 에이전트 등록 및 독립 동작 확인
  // ==========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'presence-sv-'))
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: 'ok' }))
    const llmPort = await mockLLM.start()

    const config = baseConfig(llmPort, tmpDir, {
      agents: [
        { name: 'agent-a', description: '에이전트 A', capabilities: ['cap-a'] },
        { name: 'agent-b', description: '에이전트 B', capabilities: ['cap-b'] },
        { name: 'agent-c', description: '에이전트 C', capabilities: ['cap-c'] },
      ],
    })

    const { server, shutdown, userContext } = await startServer(config, { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    try {
      // 3개 에이전트 모두 등록
      assert(userContext.agentRegistry.has('agent-a'), 'SV6: agent-a registered')
      assert(userContext.agentRegistry.has('agent-b'), 'SV6: agent-b registered')
      assert(userContext.agentRegistry.has('agent-c'), 'SV6: agent-c registered')

      // run()이 각자 독립적으로 동작
      const aResult = await userContext.agentRegistry.get('agent-a').value.run('test')
      const bResult = await userContext.agentRegistry.get('agent-b').value.run('test')
      const cResult = await userContext.agentRegistry.get('agent-c').value.run('test')
      assert(aResult === 'ok', 'SV6: agent-a run returns ok')
      assert(bResult === 'ok', 'SV6: agent-b run returns ok')
      assert(cResult === 'ok', 'SV6: agent-c run returns ok')

      // 세션 목록에 4개 (user-default + 3 agents)
      const sessions = await request(port, 'GET', '/api/sessions')
      assert(sessions.body.length === 4, 'SV6: 4 sessions total')

      // 각 agent 세션 state 독립
      await userContext.agentRegistry.get('agent-a').value.run('extra')
      const aState = await request(port, 'GET', '/api/sessions/agent-agent-a/state')
      const bState = await request(port, 'GET', '/api/sessions/agent-agent-b/state')
      assert(aState.body.turn === 2, 'SV6: agent-a turn is 2 after 2 runs')
      assert(bState.body.turn === 1, 'SV6: agent-b turn is 1 (independent)')
    } finally {
      await shutdown()
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // ==========================================================================
  // SV7. agents 없는 경우 기존 동작 완전 유지
  // ==========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'presence-sv-'))
    const mockLLM = createMockLLM((_req, n) => JSON.stringify({ type: 'direct_response', message: `r${n}` }))
    const llmPort = await mockLLM.start()

    const config = baseConfig(llmPort, tmpDir, { agents: [] })
    const { server, shutdown, userContext } = await startServer(config, { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    try {
      // summarizer만 등록
      assert(userContext.agentRegistry.has('summarizer'), 'SV7: summarizer still present')
      assert(!userContext.agentRegistry.has('researcher'), 'SV7: no researcher')

      // 세션 1개만 (user-default)
      const sessions = await request(port, 'GET', '/api/sessions')
      assert(sessions.body.length === 1, 'SV7: exactly 1 session')
      assert(sessions.body[0].id === 'user-default', 'SV7: only user-default')

      // 채팅 정상 동작
      const chatRes = await request(port, 'POST', '/api/chat', { input: '안녕' })
      assert(chatRes.status === 200, 'SV7: chat still works')
      assert(chatRes.body.content === 'r1', 'SV7: correct response')
    } finally {
      await shutdown()
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // ==========================================================================
  // SV8. sub-agent 세션에 직접 chat: /api/sessions/:id/chat
  // ==========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'presence-sv-'))
    const mockLLM = createMockLLM((_req, n) => JSON.stringify({ type: 'direct_response', message: `sub-${n}` }))
    const llmPort = await mockLLM.start()

    const config = baseConfig(llmPort, tmpDir, {
      agents: [{ name: 'direct-agent', description: '직접 호출 테스트', capabilities: [] }],
    })

    const { server, shutdown } = await startServer(config, { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    try {
      // agent 세션에 직접 chat POST
      const res = await request(port, 'POST', '/api/sessions/agent-direct-agent/chat', { input: '직접 호출' })
      assert(res.status === 200, 'SV8: direct chat to agent session 200')
      assert(res.body.type === 'agent', 'SV8: type agent')
      assert(typeof res.body.content === 'string', 'SV8: content is string')

      // state 업데이트 확인
      const stateRes = await request(port, 'GET', '/api/sessions/agent-direct-agent/state')
      assert(stateRes.body.turn === 1, 'SV8: agent session turn incremented after direct chat')
    } finally {
      await shutdown()
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // ==========================================================================
  // SV9. 존재하지 않는 세션 ID → 404
  // ==========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'presence-sv-'))
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: 'ok' }))
    const llmPort = await mockLLM.start()

    const config = baseConfig(llmPort, tmpDir, { agents: [] })
    const { server, shutdown } = await startServer(config, { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    try {
      const stateRes = await request(port, 'GET', '/api/sessions/nonexistent/state')
      assert(stateRes.status === 404, 'SV9: nonexistent session state → 404')

      const chatRes = await request(port, 'POST', '/api/sessions/nonexistent/chat', { input: 'hi' })
      assert(chatRes.status === 404, 'SV9: nonexistent session chat → 404')
    } finally {
      await shutdown()
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // ==========================================================================
  // SV10. supervisor 프롬프트에 agent 목록 포함 확인 (formatAgentList 반영)
  // ==========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'presence-sv-'))
    let capturedSystemMsg = null
    const mockLLM = createMockLLM((req) => {
      if (!capturedSystemMsg) {
        capturedSystemMsg = req.messages?.find(m => m.role === 'system')?.content || ''
      }
      return JSON.stringify({ type: 'direct_response', message: 'ok' })
    })
    const llmPort = await mockLLM.start()

    const config = baseConfig(llmPort, tmpDir, {
      agents: [
        { name: 'planner', description: '계획을 수립합니다.', capabilities: [] },
      ],
    })

    const { server, shutdown } = await startServer(config, { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    try {
      await request(port, 'POST', '/api/chat', { input: '안녕' })

      assert(capturedSystemMsg !== null, 'SV10: system message captured')
      assert(capturedSystemMsg.includes('planner'), 'SV10: planner agent in system prompt')
      assert(capturedSystemMsg.includes('계획을 수립합니다'), 'SV10: agent description in system prompt')
      assert(capturedSystemMsg.includes('Available agents'), 'SV10: agents section header in prompt')
      assert(capturedSystemMsg.includes('DELEGATE'), 'SV10: DELEGATE op in prompt')
    } finally {
      await shutdown()
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  summary()
}

run()
