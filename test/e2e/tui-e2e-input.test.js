/**
 * TUI E2E — input edge cases (TE16-21, TE25, TE28).
 *  TE16. 빈 입력 → 전송 안됨
 *  TE17. 공백 입력 → 전송 안됨
 *  TE18. working 중 입력 거부
 *  TE19. 입력 히스토리 ↑↓
 *  TE20. iteration — re-plan
 *  TE21. 존재하지 않는 도구 → 에러
 *  TE25. pendingInput 즉시 표시
 *  TE28. 같은 input 연속 질문
 */

import { delay, waitFor } from '../lib/mock-server.js'
import { assert, summary } from '../lib/assert.js'
import { setupTuiE2E, typeInput } from './tui-e2e-helpers.js'

async function run() {
  console.log('TUI E2E — input edge cases (TE16-21, TE25, TE28)')

  // TE16. 빈 입력
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

  // TE17. 공백 입력
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

  // TE18. working 중 입력 거부
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

  // TE19. 입력 히스토리 ↑↓
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

      stdin.write('\x1B[A')
      await waitFor(() => lastFrame().includes('BBB'), { timeout: 2000 })
      assert(lastFrame().includes('BBB'), 'TE19: ↑ → BBB 복원')

      stdin.write('\x1B[A')
      await waitFor(() => lastFrame().includes('AAA'), { timeout: 2000 })
      assert(lastFrame().includes('AAA'), 'TE19: ↑↑ → AAA 복원')

      stdin.write('\x1B[B')
      await waitFor(() => lastFrame().includes('BBB'), { timeout: 2000 })
      assert(lastFrame().includes('BBB'), 'TE19: ↓ → BBB 복원')

      stdin.write('\x1B[B')
      await delay(100)
      assert(!lastFrame().match(/>\s*[A-Z]{3}/), 'TE19: ↓↓ → 입력창 비워짐')
    } finally {
      await cleanup()
    }
  }

  // TE20. iteration — RESPOND 없는 plan → re-plan
  {
    let callN = 0
    const { lastFrame, stdin, cleanup } = await setupTuiE2E((_req, n) => {
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

  // TE21. 존재하지 않는 도구 실행 → 에러 메시지 표시
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

  // TE25. pendingInput 즉시 표시 — LLM 지연 중에도 유저 입력 즉시 렌더
  {
    let resolver = null
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(() =>
      new Promise(resolve => { resolver = resolve })
    )
    try {
      await delay(100)
      await typeInput(stdin, '즉시표시테스트')
      await waitFor(() => lastFrame().includes('즉시표시테스트'), { timeout: 3000 })
      assert(lastFrame().includes('즉시표시테스트'), 'TE25: pendingInput 즉시 렌더')
      assert(lastFrame().includes('thinking'), 'TE25: LLM 대기 중 thinking 표시')
      resolver(JSON.stringify({ type: 'direct_response', message: '응답완료' }))
      await waitFor(() => lastFrame().includes('응답완료'), { timeout: 5000 })
      const frame = lastFrame()
      const firstIdx = frame.indexOf('즉시표시테스트')
      const lastIdx = frame.lastIndexOf('즉시표시테스트')
      assert(firstIdx === lastIdx, 'TE25: 유저 입력 중복 없음 (pending → persisted 전환)')
    } finally {
      await cleanup()
    }
  }

  // TE28. 같은 input 연속 질문 — 각 pending 이 별도 렌더 (regression guard)
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '같은질문응답' })
    )
    try {
      await delay(100)
      await typeInput(stdin, '반복질문')
      await waitFor(() => lastFrame().includes('같은질문응답'), { timeout: 10000 })
      await delay(200)
      await typeInput(stdin, '반복질문')
      await delay(200)
      const frame = lastFrame()
      const firstIdx = frame.indexOf('반복질문')
      const secondIdx = frame.indexOf('반복질문', firstIdx + 1)
      assert(firstIdx !== -1 && secondIdx !== -1, 'TE28: 같은 input 연속 질문 — 두 번 모두 렌더 (ts 기반 dedup)')
    } finally {
      await cleanup()
    }
  }

  summary()
}

run()
