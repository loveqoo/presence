/**
 * TUI E2E tests — ink-testing-library + 실제 서버 + Mock LLM
 *
 * App(RemoteState) → stdin 입력 → handleInput → POST /api/chat → server → mock LLM
 * → WS state push → useAgentState 재렌더 → lastFrame() 검증
 *
 * 커버하는 시나리오:
 *  TE1.  초기 UI 렌더링 — idle 상태 + 입력 프롬프트
 *  TE2.  메시지 전송 → 에이전트 응답 → TUI에 표시
 *  TE3.  working 상태 전환 — LLM 지연 중 thinking 표시
 *  TE4.  도구 실행 plan → TUI tool result 표시
 *  TE5.  LLM 파싱 실패 → error 상태
 *  TE6.  turn 카운터 증가
 *  TE7.  /status 슬래시 커맨드
 *  TE8.  /clear 후 히스토리 초기화
 *  TE9.  /tools 슬래시 커맨드 — 도구 목록 system 메시지
 *  TE10. 빈 입력 → 전송 안됨 (LLM 호출 없음)
 *  TE11. 공백 입력 → 전송 안됨
 *  TE12. working 중 입력 거부 — 두 번째 메시지 무시
 *  TE13. 입력 히스토리 ↑↓ 탐색
 *  TE14. iteration — RESPOND 없는 plan → re-plan → 응답
 *  TE15. 도구 부분 실패 → re-plan → 최종 응답
 */

import React from 'react'
import { render } from 'ink-testing-library'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRemoteState } from '../../src/infra/remote-state.js'
import { App } from '../../src/ui/App.js'
import { startServer } from '../../src/server/index.js'
import { assert, summary } from '../lib/assert.js'

const h = React.createElement

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * poll fn()이 truthy를 반환할 때까지 대기.
 */
const waitFor = (fn, { timeout = 5000, interval = 50 } = {}) =>
  new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      try {
        const result = fn()
        if (result) { resolve(result); return }
      } catch (_) {}
      if (Date.now() - start > timeout) {
        reject(new Error(`waitFor timeout: ${fn.toString().slice(0, 80)}`))
        return
      }
      setTimeout(check, interval)
    }
    check()
  })

/**
 * Mock LLM HTTP 서버. handler(parsedBody, callN) → string|object 반환.
 */
const createMockLLM = (handler) => {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', async () => {
      let parsed
      try { parsed = JSON.parse(body) } catch { parsed = {} }
      calls.push(parsed)
      const response = await Promise.resolve(handler(parsed, calls.length))
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
    start: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise(r => server.close(r)),
  }
}

/**
 * 기본 서버 설정 빌더.
 */
const createBaseConfig = (llmPort, memPath) => ({
  llm: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: 'test', apiKey: 'k', responseFormat: 'json_object', maxRetries: 0, timeoutMs: 5000 },
  embed: { provider: 'openai', baseUrl: null, apiKey: null, model: null, dimensions: 256 },
  locale: 'ko', maxIterations: 5,
  memory: memPath ? { path: memPath } : undefined,
  mcp: [],
  scheduler: { enabled: false, pollIntervalMs: 60000, todoReview: { enabled: false, cron: '0 9 * * *' } },
  delegatePolling: { intervalMs: 60000 },
  prompt: { maxContextTokens: 8000, reservedOutputTokens: 1000, maxContextChars: null, reservedOutputChars: null },
})

/**
 * HTTP 요청 헬퍼.
 */
const request = (port, method, path, body) =>
  new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const opts = {
      hostname: '127.0.0.1', port, method, path,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }
    const req = http.request(opts, (res) => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }) }
        catch { resolve({ status: res.statusCode, body: buf }) }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })

/**
 * RemoteState 생성 후 WS init 수신을 기다림.
 * turnState가 cache에 들어올 때까지 폴링.
 */
const connectRemoteState = (wsUrl) => new Promise((resolve) => {
  const rs = createRemoteState({ wsUrl, sessionId: 'user-default' })
  const check = () => {
    if (rs.get('turnState') !== undefined) { resolve(rs); return }
    setTimeout(check, 20)
  }
  setTimeout(check, 20)
})

/**
 * stdin으로 텍스트 입력 + Enter 전송.
 * ink-testing-library의 stdin.write()를 사용.
 */
const typeInput = async (stdin, text) => {
  // 각 문자를 순차 입력
  for (const ch of text) {
    stdin.write(ch)
    await delay(10)
  }
  // Enter 키 (InputBar는 key.return 감지)
  stdin.write('\r')
  await delay(20)
}

/**
 * 테스트별 서버 + RemoteState + App 렌더링 조립.
 * Returns { port, remoteState, lastFrame, stdin, post, cleanup }
 */
const setupTuiE2E = async (mockHandler) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'tui-e2e-'))
  const mockLLM = createMockLLM(mockHandler)
  const llmPort = await mockLLM.start()
  const config = createBaseConfig(llmPort, join(tmpDir, 'memory'))

  const { server, shutdown } = await startServer(config, { port: 0, persistenceCwd: tmpDir })
  const port = server.address().port

  const remoteState = await connectRemoteState(`ws://127.0.0.1:${port}`)

  const post = (path, body) => request(port, 'POST', path, body)
  const get = (path) => request(port, 'GET', path)

  const toolsRes = await get('/api/tools')
  const tools = Array.isArray(toolsRes.body) ? toolsRes.body : []

  const onInput = (input) =>
    post('/api/chat', { input }).then(res => res.body?.content ?? null)

  const onApprove = (approved) => post('/api/approve', { approved })
  const onCancel = () => post('/api/cancel')

  const { lastFrame, stdin, unmount } = render(h(App, {
    state: remoteState,
    onInput,
    onApprove,
    onCancel,
    tools,
    agents: [],
    cwd: process.cwd(),
    gitBranch: '',
    model: 'test',
    config: {},
    memory: null,
    llm: null,
    mcpControl: null,
    initialMessages: [],
  }))

  const cleanup = async () => {
    unmount()
    remoteState.disconnect()
    await shutdown()
    await mockLLM.close()
    rmSync(tmpDir, { recursive: true, force: true })
  }

  return { port, remoteState, lastFrame, stdin, post, get, tools, llmCalls: mockLLM.calls, cleanup }
}

// ---------------------------------------------------------------------------

async function run() {
  console.log('TUI E2E tests (ink-testing-library + 실제 서버 + mock LLM)')

  // =========================================================================
  // TE1. 초기 UI 렌더링 — idle + 입력 프롬프트
  // =========================================================================
  {
    const { lastFrame, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: 'fallback' })
    )

    try {
      await delay(100)
      const frame = lastFrame()
      assert(frame.includes('idle'), 'TE1: 초기 상태 idle 표시')
      assert(frame.includes('>'), 'TE1: 입력 프롬프트 > 표시')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE2. 메시지 전송 → 에이전트 응답 → TUI에 표시
  //      stdin으로 텍스트 입력 후 App.handleInput → onInput(POST) → WS push
  // =========================================================================
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '안녕하세요!' })
    )

    try {
      await delay(100)

      // stdin으로 메시지 입력 → handleInput 호출
      await typeInput(stdin, '안녕하세요')

      // 에이전트 응답이 프레임에 나타날 때까지 대기
      await waitFor(() => lastFrame().includes('안녕하세요!'), { timeout: 10000 })
      assert(lastFrame().includes('안녕하세요!'), 'TE2: 에이전트 응답 TUI 표시')

      // idle로 복귀
      await waitFor(
        () => lastFrame().includes('idle') && !lastFrame().includes('thinking'),
        { timeout: 5000 }
      )
      assert(lastFrame().includes('idle'), 'TE2: 응답 후 idle 복귀')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE3. working 상태 전환 — LLM 지연 중 thinking 표시
  // =========================================================================
  {
    let resolveLLM
    const llmGate = new Promise(r => { resolveLLM = r })

    const { lastFrame, stdin, cleanup } = await setupTuiE2E(async () => {
      await llmGate
      return JSON.stringify({ type: 'direct_response', message: '지연 응답' })
    })

    try {
      await delay(100)

      // LLM이 막혀있는 상태에서 메시지 전송 (완료를 기다리지 않음)
      typeInput(stdin, '지연 테스트').catch(() => {})

      // working 상태(thinking) 확인
      await waitFor(() => lastFrame().includes('thinking'), { timeout: 5000 })
      assert(lastFrame().includes('thinking'), 'TE3: LLM 지연 중 thinking 표시')

      // LLM 응답 해제 → 완료
      resolveLLM()

      // idle 복귀 확인
      await waitFor(
        () => lastFrame().includes('idle') && !lastFrame().includes('thinking'),
        { timeout: 5000 }
      )
      assert(lastFrame().includes('idle'), 'TE3: 응답 후 idle 복귀')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE4. 도구 실행 plan → TUI tool result 표시
  // =========================================================================
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E((_req, n) => {
      if (n === 1) {
        return JSON.stringify({
          type: 'plan',
          steps: [
            { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
            { op: 'RESPOND', args: { ref: 1 } },
          ],
        })
      }
      return JSON.stringify({ type: 'direct_response', message: '파일 목록을 조회했습니다.' })
    })

    try {
      await delay(100)

      await typeInput(stdin, '파일 목록')

      // tool 결과(file_list) 또는 에이전트 응답 표시 대기
      await waitFor(
        () => lastFrame().includes('file_list') || lastFrame().includes('파일 목록'),
        { timeout: 10000 }
      )
      assert(
        lastFrame().includes('file_list') || lastFrame().includes('파일 목록'),
        'TE4: tool 실행 결과 TUI 표시'
      )

      // idle 복귀 대기
      await waitFor(
        () => lastFrame().includes('idle') && !lastFrame().includes('thinking'),
        { timeout: 5000 }
      )
      assert(lastFrame().includes('idle'), 'TE4: tool 실행 후 idle 복귀')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE5. LLM 파싱 실패 → error 상태
  // =========================================================================
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => '<<<invalid json>>>'
    )

    try {
      await delay(100)

      await typeInput(stdin, '테스트')

      // error 상태 표시 대기
      await waitFor(() => lastFrame().includes('error'), { timeout: 10000 })
      assert(lastFrame().includes('error'), 'TE5: LLM 파싱 실패 → error 상태 표시')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE6. turn 카운터 증가
  //      두 번 메시지 전송 → 서버 state turn === 2
  // =========================================================================
  {
    let callN = 0
    const { lastFrame, stdin, remoteState, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: `응답 ${++callN}` })
    )

    try {
      await delay(100)

      // 첫 번째 턴
      await typeInput(stdin, '첫 번째')
      await waitFor(
        () => lastFrame().includes('응답 1'),
        { timeout: 10000 }
      )
      await waitFor(
        () => lastFrame().includes('idle') && !lastFrame().includes('thinking'),
        { timeout: 5000 }
      )

      // 두 번째 턴
      await typeInput(stdin, '두 번째')
      await waitFor(
        () => lastFrame().includes('응답 2'),
        { timeout: 10000 }
      )
      await waitFor(
        () => lastFrame().includes('idle') && !lastFrame().includes('thinking'),
        { timeout: 5000 }
      )

      // RemoteState에서 turn 값 확인
      await waitFor(() => remoteState.get('turn') >= 2, { timeout: 3000 })
      assert(remoteState.get('turn') >= 2, 'TE6: turn 카운터 2 이상')
      assert(lastFrame().includes('응답 1') || lastFrame().includes('응답 2'), 'TE6: 응답 누적 표시')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE7. /status 슬래시 커맨드 — 로컬 처리 → system 메시지 표시
  // =========================================================================
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '응답' })
    )

    try {
      await delay(100)

      // /status는 App 내부에서 로컬 처리됨 (서버 전송 없음)
      await typeInput(stdin, '/status')

      // system 메시지에 'status:' 텍스트 포함 확인
      await waitFor(() => lastFrame().includes('status:'), { timeout: 3000 })
      assert(lastFrame().includes('status:'), 'TE7: /status system 메시지 표시')
      assert(lastFrame().includes('idle'), 'TE7: /status 응답에 idle 포함')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE8. /clear 후 메시지 초기화
  //      메시지 전송 후 /clear → 메시지 목록 비워짐
  // =========================================================================
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '안녕!' })
    )

    try {
      await delay(100)

      // 먼저 메시지 전송
      await typeInput(stdin, '안녕하세요')
      await waitFor(() => lastFrame().includes('안녕!'), { timeout: 10000 })

      // /clear 전송 → App 내부에서 messages 배열 초기화
      await typeInput(stdin, '/clear')

      // /clear 후 메시지 사라짐 대기
      // messages가 비워지면 '안녕!' 메시지가 프레임에서 사라짐
      await waitFor(() => !lastFrame().includes('안녕!'), { timeout: 3000 })
      assert(!lastFrame().includes('안녕!'), 'TE8: /clear 후 메시지 초기화')
      // idle 상태는 유지
      assert(lastFrame().includes('idle'), 'TE8: /clear 후 idle 유지')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE9. /tools 슬래시 커맨드 — 도구 목록 system 메시지
  // =========================================================================
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '응답' })
    )

    try {
      await delay(100)
      await typeInput(stdin, '/tools')

      await waitFor(() => lastFrame().includes('file_'), { timeout: 3000 })
      assert(lastFrame().includes('file_'), 'TE9: /tools system 메시지에 도구 목록 표시')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE10. 빈 입력 → 전송 안됨 (LLM 호출 없음)
  // =========================================================================
  {
    const { lastFrame, llmCalls, stdin, remoteState, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '전송됨' })
    )

    try {
      await delay(100)

      // Enter만 누르기 (빈 입력)
      stdin.write('\r')
      await delay(200)

      assert(llmCalls.length === 0, 'TE10: 빈 입력 → LLM 호출 없음')
      assert(remoteState.get('turn') === 0, 'TE10: 빈 입력 → turn 증가 없음')
      assert(!lastFrame().includes('전송됨'), 'TE10: 빈 입력 → 에이전트 응답 없음')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE11. 공백 입력 → 전송 안됨
  // =========================================================================
  {
    const { lastFrame, llmCalls, stdin, remoteState, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '전송됨' })
    )

    try {
      await delay(100)

      // 공백만 입력 후 Enter
      await typeInput(stdin, '   ')

      await delay(200)
      assert(llmCalls.length === 0, 'TE11: 공백 입력 → LLM 호출 없음')
      assert(remoteState.get('turn') === 0, 'TE11: 공백 입력 → turn 증가 없음')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE12. working 중 입력 거부 — 두 번째 메시지 무시
  // =========================================================================
  {
    let resolveLLM
    const llmGate = new Promise(r => { resolveLLM = r })

    const { lastFrame, stdin, llmCalls, cleanup } = await setupTuiE2E(async (_req, n) => {
      if (n === 1) {
        await llmGate
        return JSON.stringify({ type: 'direct_response', message: '첫 번째 응답' })
      }
      return JSON.stringify({ type: 'direct_response', message: '두 번째 응답' })
    })

    try {
      await delay(100)

      // 첫 번째 메시지 전송 (LLM이 막혀있음)
      typeInput(stdin, '첫 번째').catch(() => {})

      // working 상태 대기
      await waitFor(() => lastFrame().includes('thinking'), { timeout: 5000 })

      // working 중 두 번째 메시지 시도 — 무시되어야 함
      await typeInput(stdin, '두 번째')
      await delay(200)

      // LLM 아직 1번만 호출됨 (두 번째 메시지는 서버에 전달 안 됨)
      assert(llmCalls.length === 1, 'TE12: working 중 추가 메시지 → LLM 추가 호출 없음')

      // LLM 해제 → 첫 번째 응답 완료
      resolveLLM()
      await waitFor(() => lastFrame().includes('첫 번째 응답'), { timeout: 5000 })
      assert(lastFrame().includes('첫 번째 응답'), 'TE12: 첫 번째 응답 표시')
      assert(!lastFrame().includes('두 번째 응답'), 'TE12: 두 번째 응답 없음')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE13. 입력 히스토리 ↑↓ 탐색
  //       ArrowUp: \x1B[A  ArrowDown: \x1B[B
  // =========================================================================
  {
    let callN = 0
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: `응답 ${++callN}` })
    )

    try {
      await delay(100)

      // 'AAA' 전송 후 완료 대기
      await typeInput(stdin, 'AAA')
      await waitFor(() => lastFrame().includes('응답 1'), { timeout: 10000 })
      await waitFor(() => !lastFrame().includes('thinking'), { timeout: 5000 })

      // 'BBB' 전송 후 완료 대기
      await typeInput(stdin, 'BBB')
      await waitFor(() => lastFrame().includes('응답 2'), { timeout: 10000 })
      await waitFor(() => !lastFrame().includes('thinking'), { timeout: 5000 })

      // ↑ → 'BBB' 복원
      stdin.write('\x1B[A')
      await waitFor(() => lastFrame().includes('BBB'), { timeout: 2000 })
      assert(lastFrame().includes('BBB'), 'TE13: ↑ → 마지막 입력(BBB) 복원')

      // ↑ → 'AAA' 복원
      stdin.write('\x1B[A')
      await waitFor(() => lastFrame().includes('AAA'), { timeout: 2000 })
      assert(lastFrame().includes('AAA'), 'TE13: ↑↑ → 이전 입력(AAA) 복원')

      // ↓ → 'BBB' 복원
      stdin.write('\x1B[B')
      await waitFor(() => lastFrame().includes('BBB'), { timeout: 2000 })
      assert(lastFrame().includes('BBB'), 'TE13: ↓ → BBB 복원')

      // ↓ → 빈 입력
      stdin.write('\x1B[B')
      await delay(100)
      // 빈 입력 상태: 프레임에 입력 커서(>) 이후 내용 없음
      // InputBar는 입력창에 텍스트가 없으면 > 뒤가 비어있음
      assert(!lastFrame().match(/>\s*[A-Z]{3}/), 'TE13: ↓↓ → 입력창 비워짐')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE14. iteration — RESPOND 없는 plan → LLM re-plan → 최종 응답
  // =========================================================================
  {
    let callN = 0
    const { lastFrame, stdin, llmCalls, cleanup } = await setupTuiE2E((_req, n) => {
      callN = n
      if (n === 1) {
        return JSON.stringify({
          type: 'plan',
          steps: [
            { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
            // RESPOND 없음 → 에이전트가 re-plan 요청
          ],
        })
      }
      return JSON.stringify({ type: 'direct_response', message: '파일을 확인했습니다.' })
    })

    try {
      await delay(100)

      await typeInput(stdin, '파일 확인')

      // 최종 응답 대기 (re-plan 후 direct_response)
      await waitFor(() => lastFrame().includes('파일을 확인했습니다.'), { timeout: 15000 })
      assert(callN >= 2, 'TE14: LLM 2회 이상 호출 (re-plan 발생)')
      assert(lastFrame().includes('파일을 확인했습니다.'), 'TE14: re-plan 후 최종 응답 표시')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE15. 도구 부분 실패 → re-plan → 최종 응답
  //       3개 tool 중 1개(nonexistent_tool) 실패 → LLM에 실패 결과 전달 → re-plan
  // =========================================================================
  {
    let callN = 0
    const { lastFrame, stdin, cleanup } = await setupTuiE2E((_req, n) => {
      callN = n
      if (n === 1) {
        return JSON.stringify({
          type: 'plan',
          steps: [
            { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
            { op: 'EXEC', args: { tool: 'nonexistent_tool', tool_args: {} } },
            { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
          ],
        })
      }
      return JSON.stringify({ type: 'direct_response', message: '2개 성공, 1개 실패 확인.' })
    })

    try {
      await delay(100)

      await typeInput(stdin, '도구 3개 실행')

      await waitFor(() => lastFrame().includes('2개 성공, 1개 실패 확인.'), { timeout: 15000 })
      assert(callN >= 2, 'TE15: 부분 실패 후 re-plan (LLM 2회 이상 호출)')
      assert(lastFrame().includes('2개 성공, 1개 실패 확인.'), 'TE15: re-plan 후 최종 응답 표시')
    } finally {
      await cleanup()
    }
  }

  summary()
}

run()
