/**
 * TUI 시나리오 테스트 — 실제 서버 + 실제 LLM으로 사용자 시나리오 검증.
 *
 * 개별 기능이 아닌, 연속된 대화 흐름을 테스트한다.
 *
 * 사전 조건: 서버가 실행 중이어야 한다.
 *   npm start
 *
 * 실행:
 *   node test/e2e/tui-scenario.test.js [--url http://...] [--username X] [--password X]
 */

import { connect, setup, sendAndWait, typeInput, waitIdle, delay, waitFor } from './live-helpers.js'
import { assert, summary } from '../lib/assert.js'

const serverInfo = await connect()
console.log(`TUI scenario tests (세션: ${serverInfo.sessionId}, 모델: ${serverInfo.config.llm?.model || '?'})`)

// =============================================================================
// S1. 멀티턴 대화 — 맥락 유지 확인
//     1) 이름을 알려준다
//     2) 이름을 기억하는지 확인한다
// =============================================================================
{
  const { lastFrame, stdin, remoteState, cleanup } = await setup(serverInfo)
  try {
    // 첫 턴: 이름 알려주기
    await sendAndWait(stdin, remoteState, lastFrame, '내 이름은 테스트봇이야. 기억해줘.')
    assert(lastFrame().includes('idle'), 'S1-1: 첫 턴 완료')

    // 두 번째 턴: 이름 기억 확인
    await sendAndWait(stdin, remoteState, lastFrame, '내 이름이 뭐라고 했지?')
    const frame = lastFrame()
    assert(frame.includes('테스트봇'), 'S1-2: 두 번째 턴에서 이름(테스트봇) 기억')
  } finally { cleanup() }
}

// =============================================================================
// S2. 도구 연쇄 — 파일 읽기 → 내용 기반 질문
//     1) package.json을 읽어달라고 요청
//     2) 응답에서 프로젝트 이름을 물어본다
// =============================================================================
{
  const { lastFrame, stdin, remoteState, cleanup } = await setup(serverInfo)
  try {
    // 첫 턴: 파일 읽기 요청
    await sendAndWait(stdin, remoteState, lastFrame, 'package.json 파일을 읽어줘.')
    const frame1 = lastFrame()
    const hasFileContent = frame1.includes('package.json') || frame1.includes('name') || frame1.includes('presence')
    assert(hasFileContent, 'S2-1: package.json 내용 표시')

    // 두 번째 턴: 내용 기반 후속 질문
    await sendAndWait(stdin, remoteState, lastFrame, '방금 읽은 파일에서 프로젝트 이름(name 필드)이 뭐야? 이름만 답해.')
    const frame2 = lastFrame()
    assert(frame2.includes('presence'), 'S2-2: package.json의 name 필드(presence) 기반 답변')
  } finally { cleanup() }
}

// =============================================================================
// S3. 대화 초기화 — /clear 후 UI 상태 확인
//     1) 메시지를 보낸다
//     2) /clear로 초기화
//     3) 이전 메시지가 UI에서 사라진다
//     4) 새 대화가 정상 동작한다
// =============================================================================
{
  const { lastFrame, stdin, remoteState, cleanup } = await setup(serverInfo)
  try {
    // 첫 턴: 고유한 문자열 포함 메시지
    await sendAndWait(stdin, remoteState, lastFrame, '"XYZ-MARKER-789"라는 문자열을 그대로 출력해줘.')
    assert(lastFrame().includes('XYZ-MARKER-789'), 'S3-1: 마커 문자열 응답 표시')

    // /clear — 대화 초기화
    await typeInput(stdin, '/clear')
    await delay(500)
    assert(!lastFrame().includes('XYZ-MARKER-789'), 'S3-2: /clear 후 이전 메시지 사라짐')

    // 새 대화 정상 동작
    await sendAndWait(stdin, remoteState, lastFrame, '1 + 1은? 숫자만 답해.')
    assert(lastFrame().includes('2'), 'S3-3: /clear 후 새 대화 정상')
  } finally { cleanup() }
}

// =============================================================================
// S4. 도구 실행 + 판단 — 디렉토리 구조 파악 후 요약
//     1) 프로젝트 구조를 파악해달라고 요청
//     2) 어떤 패키지들이 있는지 답변에 포함되어야 함
// =============================================================================
{
  const { lastFrame, stdin, remoteState, cleanup } = await setup(serverInfo)
  try {
    await sendAndWait(stdin, remoteState, lastFrame, 'packages/ 폴더 안에 있는 하위 폴더 이름만 나열해줘.')
    const frame = lastFrame()
    // 프로젝트에는 core, infra, server, tui 패키지가 존재
    const hasCore = frame.includes('core')
    const hasInfra = frame.includes('infra')
    const hasServer = frame.includes('server')
    const hasTui = frame.includes('tui')
    const packageCount = [hasCore, hasInfra, hasServer, hasTui].filter(Boolean).length
    assert(packageCount >= 2, `S4: 패키지 구조 요약 (${packageCount}/4 패키지 언급)`)
  } finally { cleanup() }
}

// =============================================================================
// S5. 연속 대화 — 계산 요청 연쇄
//     1) 첫 번째 계산 요청
//     2) 그 결과를 기반으로 후속 계산 요청 → 맥락 연계
// =============================================================================
{
  const { lastFrame, stdin, remoteState, cleanup } = await setup(serverInfo)
  try {
    await sendAndWait(stdin, remoteState, lastFrame, '123 * 456을 계산해줘. 결과만 숫자로.')
    const frame1 = lastFrame()
    assert(frame1.includes('56088'), 'S5-1: 첫 번째 계산 결과')

    await sendAndWait(stdin, remoteState, lastFrame, '방금 결과에 2를 더하면? 숫자만.')
    const frame2 = lastFrame()
    assert(frame2.includes('56090'), 'S5-2: 후속 계산 (맥락 연계)')
  } finally { cleanup() }
}

summary()
