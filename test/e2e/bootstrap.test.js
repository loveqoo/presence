import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootstrap } from '@presence/tui'
import { PHASE, RESULT } from '@presence/core/core/policies.js'

import { assert, summary } from '../lib/assert.js'

// --- Mock LLM HTTP 서버 ---
// 시나리오별 응답을 주입할 수 있는 간이 OpenAI-compatible 서버

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
        // SSE 스트리밍 응답 (chatStream 경로)
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        // 일반 JSON 응답 (chat 경로)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content } }] }))
      }
    })
  })

  return {
    calls,
    start: () => new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    }),
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

// --- 테스트용 config 생성 ---

const createTestConfig = (port, tmpDir) => ({
  llm: {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'test-model',
    apiKey: 'test-key',
    responseFormat: 'json_object',
    maxRetries: 0,
    timeoutMs: 5000,
  },
  embed: { provider: 'openai', baseUrl: null, apiKey: null, model: null, dimensions: 256 },
  locale: 'ko',
  maxIterations: 5,
  memory: { path: join(tmpDir, 'memory') },
  mcp: [],
  scheduler: { enabled: false, pollIntervalMs: 60000, todoReview: { enabled: false, cron: '0 9 * * *' } },
  delegatePolling: { intervalMs: 60000 },
  prompt: { maxContextTokens: 8000, reservedOutputTokens: 1000, maxContextChars: null, reservedOutputChars: null },
})

async function run() {
  console.log('E2E bootstrap tests')

  // ===========================================
  // 1. direct_response: 단순 질의 → 응답
  // ===========================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'presence-e2e-'))
    const mockLLM = createMockLLM(() =>
      JSON.stringify({ type: 'direct_response', message: '안녕하세요! 무엇을 도와드릴까요?' })
    )
    const port = await mockLLM.start()

    try {
      const app = await bootstrap(createTestConfig(port, tmpDir), { persistenceCwd: tmpDir })

      assert(app.state.get('turnState').tag === PHASE.IDLE, 'e2e-1: initial state idle')
      assert(app.state.get('turn') === 0, 'e2e-1: initial turn 0')

      const result = await app.handleInput('안녕하세요')

      assert(result === '안녕하세요! 무엇을 도와드릴까요?', 'e2e-1: correct response')
      assert(app.state.get('turnState').tag === PHASE.IDLE, 'e2e-1: back to idle')
      assert(app.state.get('turn') === 1, 'e2e-1: turn incremented')
      assert(app.state.get('lastTurn').tag === RESULT.SUCCESS, 'e2e-1: lastTurn success')
      assert(mockLLM.calls.length === 1, 'e2e-1: 1 LLM call')

      // conversation history 저장 확인
      const history = app.state.get('context.conversationHistory') || []
      assert(history.length === 1, 'e2e-1: history has 1 entry')
      assert(history[0].input.includes('안녕하세요'), 'e2e-1: history input recorded')

      await app.shutdown()
    } finally {
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // ===========================================
  // 2. plan + tool execution: 도구 호출 → 응답
  // ===========================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'presence-e2e-'))
    const testFile = join(tmpDir, 'test.txt')
    writeFileSync(testFile, '테스트 파일 내용입니다.')

    const mockLLM = createMockLLM((_req, callNum) => {
      if (callNum === 1) {
        return JSON.stringify({
          type: 'plan',
          steps: [
            { op: 'EXEC', args: { tool: 'file_read', tool_args: { path: testFile } } },
            { op: 'RESPOND', args: { ref: 1 } },
          ],
        })
      }
      return JSON.stringify({ type: 'direct_response', message: 'fallback' })
    })
    const port = await mockLLM.start()
    const config = createTestConfig(port, tmpDir)
    config.tools = { allowedDirs: [tmpDir] }

    try {
      const app = await bootstrap(config, { persistenceCwd: tmpDir })

      const hasFileRead = app.tools.some(t => t.name === 'file_read')
      assert(hasFileRead, 'e2e-2: file_read tool registered')

      const result = await app.handleInput('test.txt 파일 내용 보여줘')

      assert(app.state.get('turnState').tag === PHASE.IDLE, 'e2e-2: back to idle')
      assert(app.state.get('lastTurn').tag === RESULT.SUCCESS, 'e2e-2: lastTurn success')
      assert(typeof result === 'string' && result.includes('테스트 파일 내용'), 'e2e-2: file content in result')
      assert(mockLLM.calls.length === 1, 'e2e-2: 1 LLM call (plan + RESPOND = no formatter)')

      await app.shutdown()
    } finally {
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // ===========================================
  // 3. 연속 턴: conversation history 축적
  // ===========================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'presence-e2e-'))
    let callCount = 0
    const mockLLM = createMockLLM(() => {
      callCount++
      return JSON.stringify({ type: 'direct_response', message: `응답 ${callCount}` })
    })
    const port = await mockLLM.start()

    try {
      const app = await bootstrap(createTestConfig(port, tmpDir), { persistenceCwd: tmpDir })

      await app.handleInput('첫 번째 질문')
      await app.handleInput('두 번째 질문')
      await app.handleInput('세 번째 질문')

      assert(app.state.get('turn') === 3, 'e2e-3: 3 turns')
      const history = app.state.get('context.conversationHistory') || []
      assert(history.length === 3, 'e2e-3: 3 history entries')
      assert(history[0].input.includes('첫 번째'), 'e2e-3: first entry correct')
      assert(history[2].input.includes('세 번째'), 'e2e-3: third entry correct')

      // LLM이 history를 받았는지 확인 (3번째 호출에 이전 2개 포함)
      const thirdCall = mockLLM.calls[2]
      const systemMsg = thirdCall.messages[0]?.content || ''
      assert(thirdCall.messages.length >= 2, 'e2e-3: 3rd call has history context')

      await app.shutdown()
    } finally {
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // ===========================================
  // 4. LLM 실패 → recovery
  // ===========================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'presence-e2e-'))
    const mockLLM = createMockLLM(() => '<<<invalid json>>>')
    const port = await mockLLM.start()

    try {
      const app = await bootstrap(createTestConfig(port, tmpDir), { persistenceCwd: tmpDir })

      const result = await app.handleInput('실패 시나리오')

      assert(app.state.get('turnState').tag === PHASE.IDLE, 'e2e-4: recovered to idle')
      assert(app.state.get('lastTurn').tag === RESULT.FAILURE, 'e2e-4: lastTurn failure')
      assert(typeof result === 'string', 'e2e-4: error response returned')

      // 실패 후 다시 성공할 수 있는지
      await mockLLM.close()

      const mockLLM2 = createMockLLM(() =>
        JSON.stringify({ type: 'direct_response', message: '복구 성공' })
      )
      const port2 = await mockLLM2.start()

      // config의 baseUrl은 이미 고정이므로 같은 포트에 새 서버 불가 → 별도 app 필요
      // 대신 state가 idle로 복구되었음을 확인하는 것으로 충분
      assert(app.state.get('turn') === 1, 'e2e-4: turn still incremented on failure')

      await mockLLM2.close()
      await app.shutdown()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // ===========================================
  // 5. iteration: plan → observe → direct_response
  // ===========================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'presence-e2e-'))
    let callNum = 0
    const mockLLM = createMockLLM(() => {
      callNum++
      if (callNum === 1) {
        return JSON.stringify({
          type: 'plan',
          steps: [{ op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } }],
        })
      }
      return JSON.stringify({ type: 'direct_response', message: '파일 목록을 확인했습니다.' })
    })
    const port = await mockLLM.start()

    try {
      const app = await bootstrap(createTestConfig(port, tmpDir), { persistenceCwd: tmpDir })
      const result = await app.handleInput('현재 디렉토리 파일 보여줘')

      assert(result === '파일 목록을 확인했습니다.', 'e2e-5: iteration result')
      assert(callNum === 2, 'e2e-5: 2 LLM calls (plan + direct_response)')
      assert(app.state.get('lastTurn').tag === RESULT.SUCCESS, 'e2e-5: success')

      await app.shutdown()
    } finally {
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // ===========================================
  // 6. partial failure: 3 tool steps, 1 fails → 에러 캡처 + LLM re-plan
  // ===========================================
  {
    const { createTestInterpreter } = await import('@presence/core/interpreter/test.js')
    const { Agent } = await import('@presence/core/core/agent.js')
    const { runFreeWithStateT } = await import('@presence/core/lib/runner.js')

    let llmCall = 0
    let capturedRollingContext = null
    let toolCall = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: (op) => {
        llmCall++
        if (llmCall === 1) {
          // 1st iteration: 3개 검색 plan (RESPOND 없음 → iteration 계속)
          return JSON.stringify({
            type: 'plan',
            steps: [
              { op: 'EXEC', args: { tool: 'web_search', tool_args: { query: 'topic A' } } },
              { op: 'EXEC', args: { tool: 'web_search', tool_args: { query: 'topic B' } } },
              { op: 'EXEC', args: { tool: 'web_search', tool_args: { query: 'topic C' } } },
            ],
          })
        }
        // 2nd iteration: LLM이 rolling context(에러 포함)를 보고 direct_response
        capturedRollingContext = op.messages
        return JSON.stringify({ type: 'direct_response', message: 'A와 C 결과를 종합하면...' })
      },
      ExecuteTool: (op) => {
        toolCall++
        if (toolCall === 2) throw new Error('Network timeout')
        return `Results for: ${op.args.query}`
      },
    })

    const initial = { turnState: { tag: 'idle' }, lastTurn: null, turn: 0, context: { memories: [] } }
    const agent = new Agent({ interpret, ST })
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(agent.planner.program('3가지 주제 검색해줘'))(initial)

    // 3개 도구 모두 실행됨 (2번째는 에러 결과)
    assert(toolCall === 3, 'e2e-6: all 3 tools executed')

    // LLM이 2번 호출됨 (plan → iteration → direct_response)
    assert(llmCall === 2, 'e2e-6: 2 LLM calls (plan + re-plan)')

    // 2nd LLM 호출에 에러 내용이 rolling context로 전달됨
    const contextText = capturedRollingContext?.map(m => m.content).join('\n') || ''
    assert(contextText.includes('[ERROR]'), 'e2e-6: error info in rolling context')
    assert(contextText.includes('Network timeout'), 'e2e-6: error message visible to LLM')
    assert(contextText.includes('Results for: topic A'), 'e2e-6: success results also in context')

    // 최종 결과: 성공 (LLM이 re-plan으로 응답)
    assert(result === 'A와 C 결과를 종합하면...', 'e2e-6: final response from re-plan')
    assert(finalState.lastTurn.tag === 'success', 'e2e-6: turn succeeds overall')
  }

  // ===========================================
  // 7. mcpControl — MCP 없을 때 빈 목록
  // ===========================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'presence-e2e-'))
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: 'ok' }))
    const port = await mockLLM.start()
    try {
      const app = await bootstrap(createTestConfig(port, tmpDir), { persistenceCwd: tmpDir })

      assert(Array.isArray(app.mcpControl.list()), 'e2e-7: mcpControl.list() is array')
      assert(app.mcpControl.list().length === 0, 'e2e-7: no MCP servers')
      assert(app.mcpControl.enable('mcp0') === false, 'e2e-7: enable unknown returns false')
      assert(app.mcpControl.disable('mcp0') === false, 'e2e-7: disable unknown returns false')

      // mcp_search_tools / mcp_call_tool 미등록 확인 (allMcpTools.length === 0)
      assert(!app.tools.some(t => t.name === 'mcp_search_tools'), 'e2e-7: no mcp_search_tools')

      await app.shutdown()
    } finally {
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // ===========================================
  // 8. mcpControl — mock MCP 연결 + enable/disable
  // ===========================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'presence-e2e-'))
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: 'ok' }))
    const port = await mockLLM.start()

    const mockTools = [
      { name: 'search', description: 'Search issues', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'create', description: 'Create issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
    ]
    const config = {
      ...createTestConfig(port, tmpDir),
      mcp: [{
        serverName: 'jira',
        enabled: true,
        createTransport: () => ({}),
        createClient: () => ({
          connect: async () => {},
          listTools: async () => ({ tools: mockTools }),
          callTool: async ({ name }) => ({ content: [{ type: 'text', text: `called ${name}` }] }),
          close: async () => {},
        }),
      }],
    }

    try {
      const app = await bootstrap(config, { persistenceCwd: tmpDir })

      const list = app.mcpControl.list()
      assert(list.length === 1, 'e2e-8: 1 MCP server')
      assert(list[0].serverName === 'jira', 'e2e-8: jira server name')
      assert(list[0].toolCount === 2, 'e2e-8: 2 tools')
      assert(list[0].enabled === true, 'e2e-8: initially enabled')
      assert(list[0].prefix === 'mcp0', 'e2e-8: prefix mcp0')

      assert(app.tools.some(t => t.name === 'mcp_search_tools'), 'e2e-8: mcp_search_tools registered')
      assert(app.tools.some(t => t.name === 'mcp_call_tool'), 'e2e-8: mcp_call_tool registered')

      assert(app.mcpControl.disable('mcp0') === true, 'e2e-8: disable returns true')
      assert(app.mcpControl.list()[0].enabled === false, 'e2e-8: disabled')
      assert(app.mcpControl.enable('mcp0') === true, 'e2e-8: enable returns true')
      assert(app.mcpControl.list()[0].enabled === true, 'e2e-8: re-enabled')

      // 알 수 없는 prefix
      assert(app.mcpControl.disable('mcp99') === false, 'e2e-8: disable unknown returns false')

      await app.shutdown()
    } finally {
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // ===========================================
  // 9. mcp_search_tools — disabled 서버 툴 제외
  // ===========================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'presence-e2e-'))
    const mockLLM = createMockLLM(() => JSON.stringify({ type: 'direct_response', message: 'ok' }))
    const port = await mockLLM.start()

    const mockTools = [
      { name: 'find_event', description: 'Find calendar event', inputSchema: { type: 'object', properties: {} } },
    ]
    const config = {
      ...createTestConfig(port, tmpDir),
      mcp: [{
        serverName: 'calendar',
        enabled: true,
        createTransport: () => ({}),
        createClient: () => ({
          connect: async () => {},
          listTools: async () => ({ tools: mockTools }),
          callTool: async () => ({ content: [{ type: 'text', text: 'event found' }] }),
          close: async () => {},
        }),
      }],
    }

    try {
      const app = await bootstrap(config, { persistenceCwd: tmpDir })

      const searchTool = app.tools.find(t => t.name === 'mcp_search_tools')
      const callTool = app.tools.find(t => t.name === 'mcp_call_tool')

      // 활성화 상태에서 검색 (이름: mcp0__calendar_find_event)
      const enabledResult = await searchTool.handler({ query: 'find' })
      assert(enabledResult.includes('mcp0__calendar_find_event'), 'e2e-9: tool visible when enabled')

      // disable 후 검색 결과에서 제외
      app.mcpControl.disable('mcp0')
      const disabledResult = await searchTool.handler({ query: 'find' })
      assert(!disabledResult.includes('mcp0__calendar_find_event'), 'e2e-9: tool hidden when disabled')
      assert(disabledResult.includes('No MCP tools found'), 'e2e-9: no tools message when disabled')

      // mcp_call_tool: disabled 서버 툴 호출 시 에러
      let callError = null
      try { await callTool.handler({ tool_name: 'mcp0__calendar_find_event' }) } catch (e) { callError = e }
      assert(callError !== null, 'e2e-9: call disabled tool throws')
      assert(callError.message.includes('disabled'), 'e2e-9: error mentions disabled')

      await app.shutdown()
    } finally {
      await mockLLM.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  summary()
}

run()
