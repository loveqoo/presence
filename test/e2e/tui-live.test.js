/**
 * TUI live e2e — 실제 서버 + 실제 LLM으로 TUI 흐름 검증.
 *
 * 사전 조건: 서버가 실행 중이어야 한다 (npm start).
 *
 * 실행:
 *   node test/e2e/tui-live.test.js [--url http://127.0.0.1:3000]
 *
 * 옵션:
 *   --url         서버 URL
 *   --username    특정 유저로 로그인 (생략 시 임시 유저 자동 생성/삭제)
 *   --password    --username 필수 동반
 *   --keep-user   실패 시 임시 유저 유지 (디버깅용)
 */

import { assert, summary } from '../lib/assert.js'
import {
  connect, setup, delay, waitFor, waitIdle, typeInput,
  httpRequest, LLM_TIMEOUT,
} from './live-helpers.js'

const serverInfo = await connect()
const { sessionId, config } = serverInfo

console.log(`TUI live e2e (세션: ${sessionId}, 모델: ${config.llm?.model || '?'})`)

// =============================================================================
// 테스트
// =============================================================================

// TL1. 초기 UI 렌더링 — idle + 모델명
{
  const { lastFrame, cleanup } = await setup(serverInfo)
  try {
    await waitFor(() => lastFrame().includes('idle'), { timeout: 10000 })
    const frame = lastFrame()
    assert(frame.includes('idle'), 'TL1: 초기 상태 idle')
    assert(frame.includes('>'), 'TL1: 입력 프롬프트')
    assert(frame.includes(config.llm?.model || ''), 'TL1: 모델명 표시')
  } finally { cleanup() }
}

// TL2. 실제 LLM 응답 — 인사 요청 → thinking → 응답 → idle
{
  const { lastFrame, stdin, remoteState, cleanup } = await setup(serverInfo)
  try {
    const turnBefore = remoteState.get('turn') ?? 0

    await typeInput(stdin, '안녕하세요. 한 문장으로만 답해주세요.')

    await waitFor(
      () => (remoteState.get('turn') ?? 0) !== turnBefore,
      { timeout: LLM_TIMEOUT },
    )
    await waitIdle(lastFrame)

    assert((remoteState.get('turn') ?? 0) !== turnBefore, 'TL2: turn 변경')
    assert(lastFrame().includes('idle'), 'TL2: 응답 후 idle 복귀')

    const frame = lastFrame()
    const hasAgentResponse = frame.split('\n').some(line => {
      const trimmed = line.trim()
      return trimmed.length > 5 && !trimmed.startsWith('>') && !trimmed.includes('idle') && !trimmed.startsWith('─')
    })
    assert(hasAgentResponse, 'TL2: 에이전트 응답 표시')
  } finally { cleanup() }
}

// TL3. 도구 실행 — 파일 목록 요청
{
  const { lastFrame, stdin, cleanup } = await setup(serverInfo)
  try {
    await typeInput(stdin, '현재 디렉토리의 파일 목록을 알려줘.')
    await waitIdle(lastFrame)

    const frame = lastFrame()
    const hasToolOrText = frame.includes('file_list') || frame.includes('package.json') || frame.includes('파일')
    assert(hasToolOrText, 'TL3: 파일 목록 요청 → 응답 표시')
  } finally { cleanup() }
}

// TL4. /status 슬래시 커맨드 (i18n ko: "상태:")
{
  const { lastFrame, stdin, cleanup } = await setup(serverInfo)
  try {
    await typeInput(stdin, '/status')
    await waitFor(() => lastFrame().includes('상태:'), { timeout: 5000 })
    assert(lastFrame().includes('상태:'), 'TL4: /status 시스템 메시지')
  } finally { cleanup() }
}

// TL5. /tools 슬래시 커맨드
{
  const { lastFrame, stdin, cleanup } = await setup(serverInfo)
  try {
    await typeInput(stdin, '/tools')
    await waitFor(() => lastFrame().includes('file_'), { timeout: 5000 })
    assert(lastFrame().includes('file_'), 'TL5: /tools 도구 목록')
  } finally { cleanup() }
}

// TL6. 빈 입력 → 전송 안 됨
{
  const { remoteState, stdin, cleanup } = await setup(serverInfo)
  try {
    const turnBefore = remoteState.get('turn') ?? 0
    stdin.write('\r')
    await delay(500)
    assert((remoteState.get('turn') ?? 0) === turnBefore, 'TL6: 빈 입력 → turn 불변')
  } finally { cleanup() }
}

// TL7. 입력 히스토리 ↑↓
{
  const { lastFrame, stdin, cleanup } = await setup(serverInfo)
  try {
    await typeInput(stdin, 'ALPHA')
    await waitIdle(lastFrame)

    await typeInput(stdin, 'BRAVO')
    await waitIdle(lastFrame)
    await delay(300)

    // ↑ → BRAVO
    stdin.write('\x1B[A')
    await waitFor(() => lastFrame().includes('BRAVO'), { timeout: 3000 })
    assert(lastFrame().includes('BRAVO'), 'TL7: ↑ 마지막 입력 복원')

    // ↑↑ → ALPHA
    stdin.write('\x1B[A')
    await waitFor(() => lastFrame().includes('ALPHA'), { timeout: 3000 })
    assert(lastFrame().includes('ALPHA'), 'TL7: ↑↑ 이전 입력 복원')

    // ↓ → BRAVO
    stdin.write('\x1B[B')
    await waitFor(() => lastFrame().includes('BRAVO'), { timeout: 3000 })
    assert(lastFrame().includes('BRAVO'), 'TL7: ↓ 복원')
  } finally { cleanup() }
}

// TL8. 세션 목록 — /sessions
{
  const { lastFrame, stdin, cleanup } = await setup(serverInfo)
  try {
    await typeInput(stdin, '/sessions')
    await waitFor(() => lastFrame().includes(sessionId), { timeout: 5000 })
    assert(lastFrame().includes(sessionId), 'TL8: /sessions에 현재 세션 표시')
  } finally { cleanup() }
}

// TL9. 세션 생성 (TUI 슬래시 커맨드 + REST 검증)
{
  const testSessionId = `live-test-${Date.now()}`
  const { lastFrame, stdin, cleanup } = await setup(serverInfo)
  try {
    await typeInput(stdin, `/sessions new ${testSessionId}`)
    await waitFor(
      () => lastFrame().includes('생성됨') || lastFrame().includes(testSessionId),
      { timeout: 5000 },
    )
    const listRes = await httpRequest('GET', '/api/sessions')
    const sessions = Array.isArray(listRes.body) ? listRes.body : []
    assert(sessions.some(entry => entry.id === testSessionId), 'TL9: 세션 생성 확인 (REST)')
  } finally { cleanup() }
}

summary()
await serverInfo.teardown()
