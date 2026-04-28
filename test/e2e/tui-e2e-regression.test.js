/**
 * TUI E2E — UI/regression (TE22-24, TE26, TE29-30).
 *  TE22. 트랜스크립트 — Ctrl+T + 4 탭 + ESC
 *  TE23. POST /sessions invalid type → 400 (KG-03)
 *  TE24. ESC cancel → 취소 응답 무시 + 새 채팅 순서 보존
 *  TE26. /clear optimistic
 *  TE29. _toolTranscript SNAPSHOT_PATHS 포함
 *  TE30. Phase 5 — MirrorState stateVersion 기록
 *
 * (TE27 은 인프라 단위 테스트 turn-controller TC6/TC7 가 대신 — 원본 파일에서 skip).
 */

import { createTestServer, request, delay, waitFor } from '../lib/mock-server.js'
import { assert, summary } from '../lib/assert.js'
import { setupTuiE2E, typeInput } from './tui-e2e-helpers.js'

async function run() {
  console.log('TUI E2E — UI/regression (TE22-24, TE26, TE29-30)')

  // TE22. 트랜스크립트 — Ctrl+T 열기 + 4개 탭 전환 + ESC 닫기
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '트랜스크립트 테스트' })
    )
    try {
      await delay(100)
      await typeInput(stdin, '안녕')
      await waitFor(() => lastFrame().includes('트랜스크립트 테스트'), { timeout: 10000 })
      await waitFor(() => lastFrame().includes('idle') && !lastFrame().includes('thinking'), { timeout: 5000 })

      stdin.write('\x14') // Ctrl+T
      await waitFor(() => lastFrame().includes('트랜스크립트'), { timeout: 3000 })
      assert(lastFrame().includes('트랜스크립트'), 'TE22: Ctrl+T → 트랜스크립트 열림')

      await waitFor(
        () => lastFrame().includes('연산 흐름') || lastFrame().includes('op'),
        { timeout: 3000 }
      )
      assert(
        lastFrame().includes('연산 흐름') || lastFrame().includes('op'),
        'TE22: 탭1 연산 흐름 표시'
      )

      stdin.write('\x1B[C')
      await delay(100)
      assert(lastFrame().includes('턴 정보'), 'TE22: 탭2 턴 정보 활성')

      stdin.write('\x1B[C')
      await delay(100)
      assert(lastFrame().includes('프롬프트'), 'TE22: 탭3 프롬프트 활성')

      stdin.write('\x1B[C')
      await delay(100)
      assert(lastFrame().includes('응답'), 'TE22: 탭4 응답 활성')

      stdin.write('\x14')
      await delay(500)
      const closeFrame = lastFrame() || ''
      assert(!closeFrame.includes('트랜스크립트') || closeFrame.includes('idle'), 'TE22: 트랜스크립트 닫힘')
    } finally {
      await cleanup()
    }
  }

  // TE23. POST /session invalid type → 400 (KG-03)
  {
    const ctx = await createTestServer(
      () => JSON.stringify({ type: 'direct_response', message: 'ok' })
    )
    try {
      const { port, token } = ctx
      const badRes = await request(port, 'POST', '/api/sessions', { type: 'invalid_type' }, { token })
      assert(badRes.status === 400, 'TE23: invalid session type → 400')
      assert(badRes.body?.error?.includes('invalid_type'), 'TE23: error message includes invalid type')
      const goodRes = await request(port, 'POST', '/api/sessions', { type: 'user' }, { token })
      assert(goodRes.status === 201, 'TE23: valid session type → 201')
    } finally {
      await ctx.shutdown()
    }
  }

  // TE24. ESC cancel → 취소 응답 무시 + 새 채팅 순서 보존
  {
    let callCount = 0
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(() => {
      callCount++
      if (callCount === 1) {
        return new Promise(resolve =>
          setTimeout(() => resolve(JSON.stringify({ type: 'direct_response', message: '취소될응답' })), 500)
        )
      }
      return JSON.stringify({ type: 'direct_response', message: '새응답' })
    })
    try {
      await delay(100)
      await typeInput(stdin, '첫질문')
      await waitFor(() => lastFrame().includes('thinking'), { timeout: 5000 })

      stdin.write('\x1B')
      await delay(200)

      await waitFor(() => lastFrame().includes('취소'), { timeout: 3000 })
      assert(lastFrame().includes('취소'), 'TE24: cancel message shown')

      await delay(1000)
      assert(!lastFrame().includes('취소될응답'), 'TE24: cancelled response not shown')

      await typeInput(stdin, '새질문')
      await waitFor(() => lastFrame().includes('새응답'), { timeout: 10000 })

      const frame = lastFrame()
      assert(frame.includes('새응답'), 'TE24: new response shown')

      const cancelPos = frame.indexOf('취소')
      const newQPos = frame.indexOf('새질문')
      const newAPos = frame.indexOf('새응답')
      assert(cancelPos < newQPos, 'TE24: cancel message before new question')
      assert(newQPos < newAPos, 'TE24: new question before new answer')
    } finally {
      await cleanup()
    }
  }

  // TE26. /clear optimistic — 즉시 빈 화면 + 서버 reset 후 안정
  {
    const { lastFrame, stdin, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '초기응답' })
    )
    try {
      await delay(100)
      await typeInput(stdin, '첫입력')
      await waitFor(() => lastFrame().includes('초기응답'), { timeout: 10000 })
      assert(lastFrame().includes('초기응답'), 'TE26: 첫 턴 응답 표시')

      await typeInput(stdin, '/clear')
      await delay(200)
      const afterClear = lastFrame()
      assert(!afterClear.includes('첫입력'), 'TE26: /clear 후 유저 입력 사라짐')
      assert(!afterClear.includes('초기응답'), 'TE26: /clear 후 에이전트 응답 사라짐')

      await delay(500)
      const afterServerReset = lastFrame()
      assert(!afterServerReset.includes('첫입력'), 'TE26: 서버 reset 후에도 유저 입력 없음')
      assert(!afterServerReset.includes('초기응답'), 'TE26: 서버 reset 후에도 응답 없음')
    } finally {
      await cleanup()
    }
  }

  // TE29. _toolTranscript SNAPSHOT_PATHS 포함
  {
    const { remoteState, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: 'ok' })
    )
    try {
      await delay(200)
      const cache = remoteState.cache
      assert('_toolTranscript' in cache, 'TE29: _toolTranscript SNAPSHOT_PATHS 포함')
      assert('_pendingInput' in cache, 'TE29: _pendingInput SNAPSHOT_PATHS 포함')
    } finally {
      await cleanup()
    }
  }

  // TE30. Phase 5 — MirrorState 가 init/state 메시지의 stateVersion 을 기록
  {
    const { stdin, remoteState, cleanup } = await setupTuiE2E(
      () => JSON.stringify({ type: 'direct_response', message: '응답' })
    )
    try {
      await delay(100)
      const initVersion = remoteState.lastStateVersion
      await typeInput(stdin, '안녕')
      await delay(500)
      const afterChatVersion = remoteState.lastStateVersion
      assert(afterChatVersion !== null && afterChatVersion !== undefined,
        'TE30: chat 후 lastStateVersion 기록됨')
      if (initVersion) {
        assert(afterChatVersion >= initVersion,
          'TE30: lastStateVersion 이 후진하지 않음 (lex 비교)')
      }
    } finally {
      await cleanup()
    }
  }

  summary()
}

run()
