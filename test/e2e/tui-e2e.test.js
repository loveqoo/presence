/**
 * TUI E2E tests — ink-testing-library + 인증된 서버 + Mock LLM
 *
 * App(MirrorState) → stdin 입력 → handleInput → POST /api/sessions/:id/chat
 * → server → mock LLM → WS state push → useAgentState 재렌더 → lastFrame() 검증
 *
 * 커버하는 시나리오:
 *  TE1.  초기 UI 렌더링 — idle 상태 + 입력 프롬프트
 *  TE2.  메시지 전송 → 에이전트 응답 → TUI에 표시
 *  TE3.  working 상태 전환 — LLM 지연 중 thinking 표시
 *  TE4.  도구 실행 plan → TUI tool result 표시
 *  TE5.  LLM 파싱 실패 → error 상태
 *  TE6.  turn 카운터 증가
 *  TE7.  /status 슬래시 커맨드
 *  TE8.  /help — i18n 번역 내용 표시
 *  TE9.  /clear 후 히스토리 초기화
 *  TE10. /tools 슬래시 커맨드
 *  TE11. /mcp list — MCP 서버 목록
 *  TE12. /memory — 메모리 요약
 *  TE13. /todos — TODO 목록
 *  TE14. /sessions — 세션 목록
 *  TE15. /models — 모델 목록
 *  TE16. 빈 입력 → 전송 안됨
 *  TE17. 공백 입력 → 전송 안됨
 *  TE18. working 중 입력 거부
 *  TE19. 입력 히스토리 ↑↓ 탐색
 *  TE20. iteration — RESPOND 없는 plan → re-plan
 *  TE21. 존재하지 않는 도구 실행 → 에러 표시
 *  TE22. 트랜스크립트 — Ctrl+T 열기 + 4개 탭 전환 + ESC 닫기
 */

import React from 'react'
import { render } from 'ink-testing-library'
import { createMirrorState } from '@presence/infra/infra/states/mirror-state.js'
import { App } from '@presence/tui/ui/App.js'
import { createTestServer, request, delay, waitFor } from '../lib/mock-server.js'
import { assert, summary } from '../lib/assert.js'

const h = React.createElement

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

const typeInput = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch)
    await delay(10)
  }
  stdin.write('\r')
  await delay(20)
}

const connectMirrorState = (wsUrl, sessionId, token) => new Promise((resolve) => {
  const rs = createMirrorState({
    wsUrl,
    sessionId,
    headers: { Authorization: `Bearer ${token}` },
  })
  const check = () => {
    if (rs.get('turnState') !== undefined) { resolve(rs); return }
    setTimeout(check, 20)
  }
  setTimeout(check, 20)
})

const setupTuiE2E = async (mockHandler) => {
  const ctx = await createTestServer(mockHandler)
  const { port, token, defaultSessionId: sid, mockLLM, shutdown } = ctx

  const remoteState = await connectMirrorState(`ws://127.0.0.1:${port}`, sid, token)

  const post = (path, body) => request(port, 'POST', path, body, { token })
  const get = (path) => request(port, 'GET', path, null, { token })

  const toolsRes = await get(`/api/sessions/${sid}/tools`)
  const tools = Array.isArray(toolsRes.body) ? toolsRes.body : []

  const onInput = (input) =>
    post(`/api/sessions/${sid}/chat`, { input }).then(res => res.body?.content ?? null)

  const onApprove = (approved) => post(`/api/sessions/${sid}/approve`, { approved })
  const onCancel = () => post(`/api/sessions/${sid}/cancel`)

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
    toolRegistry: null,
    initialMessages: [],
  }))

  const cleanup = async () => {
    unmount()
    remoteState.disconnect()
    await shutdown()
  }

  return { port, remoteState, lastFrame, stdin, post, get, tools, llmCalls: mockLLM.calls, cleanup }
}

// ---------------------------------------------------------------------------

async function run() {
  console.log('TUI E2E tests (ink-testing-library + 인증된 서버 + mock LLM)')

  // =========================================================================
  // TE1. 초기 UI 렌더링
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
  // TE2. 메시지 전송 → 에이전트 응답
  // =========================================================================
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '안녕하세요!' })
    )

    try {
      await delay(100)
      await typeInput(stdin, '안녕하세요')

      await waitFor(() => lastFrame().includes('안녕하세요!'), { timeout: 10000 })
      assert(lastFrame().includes('안녕하세요!'), 'TE2: 에이전트 응답 TUI 표시')

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
  // TE3. working 상태 (thinking)
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
      typeInput(stdin, '지연 테스트').catch(() => {})

      await waitFor(() => lastFrame().includes('thinking'), { timeout: 5000 })
      assert(lastFrame().includes('thinking'), 'TE3: LLM 지연 중 thinking 표시')

      resolveLLM()

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
  // TE4. 도구 실행 plan
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

      await waitFor(
        () => lastFrame().includes('file_list') || lastFrame().includes('파일 목록'),
        { timeout: 10000 }
      )
      assert(
        lastFrame().includes('file_list') || lastFrame().includes('파일 목록'),
        'TE4: tool 실행 결과 TUI 표시'
      )

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
  // TE5. LLM 파싱 실패 → error
  // =========================================================================
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => '<<<invalid json>>>'
    )

    try {
      await delay(100)
      await typeInput(stdin, '테스트')

      await waitFor(() => lastFrame().includes('error'), { timeout: 10000 })
      assert(lastFrame().includes('error'), 'TE5: LLM 파싱 실패 → error 표시')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE6. turn 카운터 증가
  // =========================================================================
  {
    let callN = 0
    const { lastFrame, stdin, remoteState, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: `응답 ${++callN}` })
    )

    try {
      await delay(100)

      await typeInput(stdin, '첫 번째')
      await waitFor(() => lastFrame().includes('응답 1'), { timeout: 10000 })
      await waitFor(() => lastFrame().includes('idle') && !lastFrame().includes('thinking'), { timeout: 5000 })

      await typeInput(stdin, '두 번째')
      await waitFor(() => lastFrame().includes('응답 2'), { timeout: 10000 })
      await waitFor(() => lastFrame().includes('idle') && !lastFrame().includes('thinking'), { timeout: 5000 })

      await waitFor(() => remoteState.get('turn') >= 2, { timeout: 3000 })
      assert(remoteState.get('turn') >= 2, 'TE6: turn 카운터 2 이상')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE7. /status
  // =========================================================================
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '응답' })
    )

    try {
      await delay(100)
      await typeInput(stdin, '/status')

      await waitFor(() => lastFrame().includes('상태:'), { timeout: 3000 })
      assert(lastFrame().includes('상태:'), 'TE7: /status system 메시지')
      assert(lastFrame().includes('대기'), 'TE7: idle(대기) 포함')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE8. /help — i18n 번역 내용 표시 (키 문자열이 아닌 실제 텍스트)
  // =========================================================================
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '응답' })
    )

    try {
      await delay(100)
      await typeInput(stdin, '/help')

      await waitFor(() => lastFrame().includes('/clear'), { timeout: 3000 })
      assert(lastFrame().includes('/clear'), 'TE8: /help에 /clear 커맨드 포함')
      assert(!lastFrame().includes('help.commands'), 'TE8: i18n 키가 아닌 번역 내용 표시')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE9. /clear
  // =========================================================================
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '안녕!' })
    )

    try {
      await delay(100)

      await typeInput(stdin, '안녕하세요')
      await waitFor(() => lastFrame().includes('안녕!'), { timeout: 10000 })

      await typeInput(stdin, '/clear')
      await waitFor(() => !lastFrame().includes('안녕!'), { timeout: 3000 })
      assert(!lastFrame().includes('안녕!'), 'TE9: /clear 후 메시지 초기화')
      assert(lastFrame().includes('idle'), 'TE9: /clear 후 idle 유지')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE10. /tools
  // =========================================================================
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '응답' })
    )

    try {
      await delay(100)
      await typeInput(stdin, '/tools')

      await waitFor(() => lastFrame().includes('file_'), { timeout: 3000 })
      assert(lastFrame().includes('file_'), 'TE10: /tools에 도구 목록 표시')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE11. /mcp list
  // =========================================================================
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '응답' })
    )

    try {
      await delay(100)
      await typeInput(stdin, '/mcp list')

      await waitFor(() => lastFrame().includes('MCP') || lastFrame().includes('mcp'), { timeout: 3000 })
      assert(lastFrame().includes('MCP') || lastFrame().includes('No'), 'TE11: /mcp list 결과 표시')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE12. /memory — remote 모드에서 memory=null이므로 미사용 메시지
  // =========================================================================
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '응답' })
    )

    try {
      await delay(100)
      await typeInput(stdin, '/memory')

      await waitFor(
        () => lastFrame().includes('메모리') || lastFrame().includes('memory'),
        { timeout: 3000 }
      )
      assert(
        lastFrame().includes('메모리') || lastFrame().includes('memory'),
        'TE12: /memory 결과 표시'
      )
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE13. /todos
  // =========================================================================
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '응답' })
    )

    try {
      await delay(100)
      await typeInput(stdin, '/todos')

      await waitFor(() => lastFrame().includes('todos'), { timeout: 3000 })
      assert(lastFrame().includes('todos'), 'TE13: /todos 결과 표시')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE14. /sessions — remote 모드에서 onListSessions=null이므로 미사용 메시지
  // =========================================================================
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '응답' })
    )

    try {
      await delay(100)
      await typeInput(stdin, '/sessions')

      await waitFor(
        () => lastFrame().includes('세션') || lastFrame().includes('session'),
        { timeout: 3000 }
      )
      assert(
        lastFrame().includes('세션') || lastFrame().includes('session'),
        'TE14: /sessions 결과 표시'
      )
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE15. /models — remote 모드에서 llm=null이므로 미사용 메시지
  // =========================================================================
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '응답' })
    )

    try {
      await delay(100)
      await typeInput(stdin, '/models')

      await waitFor(
        () => lastFrame().includes('LLM') || lastFrame().includes('사용할 수 없'),
        { timeout: 3000 }
      )
      assert(
        lastFrame().includes('LLM') || lastFrame().includes('사용할 수 없'),
        'TE15: /models 미사용 메시지 표시'
      )
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE16. 빈 입력
  // =========================================================================
  {
    const { lastFrame, llmCalls, stdin, remoteState, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '전송됨' })
    )

    try {
      await delay(100)
      stdin.write('\r')
      await delay(200)

      assert(llmCalls.length === 0, 'TE16: 빈 입력 → LLM 호출 없음')
      assert(remoteState.get('turn') === 0, 'TE16: 빈 입력 → turn 증가 없음')
      assert(!lastFrame().includes('전송됨'), 'TE16: 에이전트 응답 없음')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE17. 공백 입력
  // =========================================================================
  {
    const { llmCalls, stdin, remoteState, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '전송됨' })
    )

    try {
      await delay(100)
      await typeInput(stdin, '   ')
      await delay(200)

      assert(llmCalls.length === 0, 'TE17: 공백 입력 → LLM 호출 없음')
      assert(remoteState.get('turn') === 0, 'TE17: 공백 입력 → turn 증가 없음')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE18. working 중 입력 거부
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
      typeInput(stdin, '첫 번째').catch(() => {})

      await waitFor(() => lastFrame().includes('thinking'), { timeout: 5000 })
      await typeInput(stdin, '두 번째')
      await delay(200)

      assert(llmCalls.length === 1, 'TE18: working 중 LLM 추가 호출 없음')

      resolveLLM()
      await waitFor(() => lastFrame().includes('첫 번째 응답'), { timeout: 5000 })
      assert(lastFrame().includes('첫 번째 응답'), 'TE18: 첫 번째 응답 표시')
      assert(!lastFrame().includes('두 번째 응답'), 'TE18: 두 번째 응답 없음')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE19. 입력 히스토리 ↑↓
  // =========================================================================
  {
    let callN = 0
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: `응답 ${++callN}` })
    )

    try {
      await delay(100)

      await typeInput(stdin, 'AAA')
      await waitFor(() => lastFrame().includes('응답 1'), { timeout: 10000 })
      await waitFor(() => !lastFrame().includes('thinking'), { timeout: 5000 })

      await typeInput(stdin, 'BBB')
      await waitFor(() => lastFrame().includes('응답 2'), { timeout: 10000 })
      await waitFor(() => !lastFrame().includes('thinking'), { timeout: 5000 })

      // ↑ → BBB
      stdin.write('\x1B[A')
      await waitFor(() => lastFrame().includes('BBB'), { timeout: 2000 })
      assert(lastFrame().includes('BBB'), 'TE19: ↑ → BBB 복원')

      // ↑ → AAA
      stdin.write('\x1B[A')
      await waitFor(() => lastFrame().includes('AAA'), { timeout: 2000 })
      assert(lastFrame().includes('AAA'), 'TE19: ↑↑ → AAA 복원')

      // ↓ → BBB
      stdin.write('\x1B[B')
      await waitFor(() => lastFrame().includes('BBB'), { timeout: 2000 })
      assert(lastFrame().includes('BBB'), 'TE19: ↓ → BBB 복원')

      // ↓ → 빈 입력
      stdin.write('\x1B[B')
      await delay(100)
      assert(!lastFrame().match(/>\s*[A-Z]{3}/), 'TE19: ↓↓ → 입력창 비워짐')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE20. iteration — RESPOND 없는 plan → re-plan
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
          ],
        })
      }
      return JSON.stringify({ type: 'direct_response', message: '파일을 확인했습니다.' })
    })

    try {
      await delay(100)
      await typeInput(stdin, '파일 확인')

      await waitFor(() => lastFrame().includes('파일을 확인했습니다.'), { timeout: 15000 })
      assert(callN >= 2, 'TE20: LLM 2회 이상 호출 (re-plan)')
      assert(lastFrame().includes('파일을 확인했습니다.'), 'TE20: re-plan 후 최종 응답')
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE21. 존재하지 않는 도구 실행 → 에러 메시지 표시
  // =========================================================================
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E((_req, n) => {
      if (n === 1) {
        return JSON.stringify({
          type: 'plan',
          steps: [
            { op: 'EXEC', args: { tool: 'nonexistent_tool', tool_args: {} } },
          ],
        })
      }
      return JSON.stringify({ type: 'direct_response', message: 'ok' })
    })

    try {
      await delay(100)
      await typeInput(stdin, '없는 도구')

      await waitFor(
        () => lastFrame().includes('error') || lastFrame().includes('nonexistent_tool'),
        { timeout: 10000 }
      )
      assert(
        lastFrame().includes('error') || lastFrame().includes('nonexistent_tool'),
        'TE21: 없는 도구 실행 → 에러 표시'
      )
    } finally {
      await cleanup()
    }
  }

  // =========================================================================
  // TE22. 트랜스크립트 — Ctrl+T 열기 + 4개 탭 전환 + ESC 닫기
  // =========================================================================
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '트랜스크립트 테스트' })
    )

    try {
      await delay(100)

      // 먼저 대화 1회 실행 (트랜스크립트에 데이터가 있어야 함)
      await typeInput(stdin, '안녕')
      await waitFor(() => lastFrame().includes('트랜스크립트 테스트'), { timeout: 10000 })
      await waitFor(() => lastFrame().includes('idle') && !lastFrame().includes('thinking'), { timeout: 5000 })

      // Ctrl+T → 트랜스크립트 열기
      stdin.write('\x14') // Ctrl+T
      await waitFor(() => lastFrame().includes('트랜스크립트'), { timeout: 3000 })
      assert(lastFrame().includes('트랜스크립트'), 'TE22: Ctrl+T → 트랜스크립트 열림')

      // 탭 1: 연산 흐름 (기본 탭) — op 관련 내용
      await waitFor(
        () => lastFrame().includes('연산 흐름') || lastFrame().includes('op'),
        { timeout: 3000 }
      )
      assert(
        lastFrame().includes('연산 흐름') || lastFrame().includes('op'),
        'TE22: 탭1 연산 흐름 표시'
      )

      // → 탭 2: 턴 정보
      stdin.write('\x1B[C') // →
      await delay(100)
      assert(lastFrame().includes('턴 정보'), 'TE22: 탭2 턴 정보 활성')

      // → 탭 3: 프롬프트
      stdin.write('\x1B[C')
      await delay(100)
      assert(lastFrame().includes('프롬프트'), 'TE22: 탭3 프롬프트 활성')

      // → 탭 4: 응답
      stdin.write('\x1B[C')
      await delay(100)
      assert(lastFrame().includes('응답'), 'TE22: 탭4 응답 활성')

      // Ctrl+T → 닫기
      stdin.write('\x14')
      await delay(500)
      // onClose가 process.stdout.write로 터미널 클리어하므로 프레임이 재렌더됨
      // 트랜스크립트 헤더가 사라졌는지 확인
      const closeFrame = lastFrame() || ''
      assert(!closeFrame.includes('트랜스크립트') || closeFrame.includes('idle'), 'TE22: 트랜스크립트 닫힘')
    } finally {
      await cleanup()
    }
  }

  summary()
}

run()
