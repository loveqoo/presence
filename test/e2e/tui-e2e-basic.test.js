/**
 * TUI E2E — basic flow (TE1-7).
 *  TE1.  초기 UI 렌더링
 *  TE2.  메시지 전송 → 에이전트 응답
 *  TE3.  working 상태 (thinking)
 *  TE4.  도구 실행 plan
 *  TE5.  LLM 파싱 실패 → error
 *  TE6.  turn 카운터 증가
 *  TE7.  /status
 *
 * 분할 이력: tui-e2e.test.js 가 TE1-30 단일 파일이라 35.8s 단일 wall —
 * 병렬 풀이 흡수하지 못했다. 4 파일로 분할하면 각 파일이 독립 Node 프로세스
 * 로 병렬 실행. setupTuiE2E 는 tui-e2e-helpers.js 가 export.
 */

import { delay, waitFor } from '../lib/mock-server.js'
import { assert, summary } from '../lib/assert.js'
import { setupTuiE2E, typeInput } from './tui-e2e-helpers.js'

async function run() {
  console.log('TUI E2E — basic flow (TE1-7)')

  // TE1. 초기 UI 렌더링
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

  // TE2. 메시지 전송 → 에이전트 응답
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

  // TE3. working 상태 (thinking)
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

  // TE4. 도구 실행 plan
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

  // TE5. LLM 파싱 실패 → error
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

  // TE6. turn 카운터 증가
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

  // TE7. /status
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

  summary()
}

run()
