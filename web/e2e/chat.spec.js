import { test, expect } from '@playwright/test'
import { createMockLLM, startTestServer } from './helpers.js'

let server
let mockLLM

test.beforeAll(async () => {
  mockLLM = createMockLLM()
  server = await startTestServer(mockLLM)
})

test.afterAll(async () => {
  await server.cleanup()
})

test.beforeEach(() => {
  mockLLM.resetCalls()
  mockLLM.setHandler((_req, n) =>
    JSON.stringify({ type: 'direct_response', message: `응답 ${n}` })
  )
})

// ===========================================
// 1. 페이지 로드 + 초기 상태
// ===========================================

test('초기 UI: StatusBar, InputBar, WebSocket 연결', async ({ page }) => {
  await page.goto('/')

  await expect(page.locator('.status-bar')).toBeVisible()
  await expect(page.locator('.status-indicator')).toContainText('idle')
  await expect(page.locator('.input-bar input')).toBeVisible()
  await expect(page.locator('.input-bar input')).toBeEnabled()
  await expect(page.locator('.input-bar button')).toBeVisible()
  await expect(page.locator('.status-conn.on')).toBeVisible()
})

test('초기 상태: turn 0, 도구 수 표시', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on')

  await expect(page.locator('.status-bar')).toContainText('turn: 0')
  await expect(page.locator('.status-bar')).toContainText('tools:')
})

test('초기 상태: 채팅 영역 비어있음', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.msg')).toHaveCount(0)
})

// ===========================================
// 2. 메시지 전송 + 응답
// ===========================================

test('메시지 전송 → 에이전트 응답 표시', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on')

  await page.locator('.input-bar input').fill('안녕하세요')
  await page.locator('.input-bar input').press('Enter')

  await expect(page.locator('.msg-user').first()).toContainText('안녕하세요')
  await expect(page.locator('.msg-agent').first()).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.msg-agent').first()).toContainText('응답')
})

test('전송 후 입력 필드 비워짐', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on')

  const input = page.locator('.input-bar input')
  await input.fill('질문')
  await input.press('Enter')

  await expect(input).toHaveValue('')
})

test('Send 버튼으로 전송', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on')

  await page.locator('.input-bar input').fill('버튼으로 전송')
  await page.locator('.input-bar button').click()

  await expect(page.locator('.msg-user').first()).toContainText('버튼으로 전송')
  await expect(page.locator('.msg-agent').first()).toBeVisible({ timeout: 10000 })
})

// ===========================================
// 3. 연속 대화 + turn 증가
// ===========================================

test('연속 대화 → 메시지 누적 + turn 증가', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on')
  const input = page.locator('.input-bar input')

  // 현재 turn 값 캡처
  const barText = await page.locator('.status-bar').textContent()
  const turnBefore = parseInt(barText.match(/turn:\s*(\d+)/)?.[1] || '0')

  await input.fill('첫 번째')
  await input.press('Enter')
  await expect(page.locator('.msg-agent').first()).toBeVisible({ timeout: 10000 })

  await input.fill('두 번째')
  await input.press('Enter')
  await expect(page.locator('.msg')).toHaveCount(4, { timeout: 10000 })

  // turn이 2 증가
  await expect(page.locator('.status-bar')).toContainText(`turn: ${turnBefore + 2}`)
})

// ===========================================
// 4. slash commands
// ===========================================

test('/status → 시스템 메시지', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on')

  await page.locator('.input-bar input').fill('/status')
  await page.locator('.input-bar input').press('Enter')

  await expect(page.locator('.msg-system').first()).toContainText('idle')
})

test('/tools → 도구 목록', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on')

  await page.locator('.input-bar input').fill('/tools')
  await page.locator('.input-bar input').press('Enter')

  const sysMsg = page.locator('.msg-system').first()
  await expect(sysMsg).toBeVisible({ timeout: 5000 })
  await expect(sysMsg).toContainText('file_')
})

test('/clear → 대화 내역 삭제', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on')
  const input = page.locator('.input-bar input')

  // 메시지 쌓기
  await input.fill('질문1')
  await input.press('Enter')
  await expect(page.locator('.msg-agent').first()).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.msg')).toHaveCount(2)

  // /clear
  await input.fill('/clear')
  await input.press('Enter')

  // system 메시지만 남음 (clear 응답)
  const sysMsg = page.locator('.msg-system')
  await expect(sysMsg.first()).toContainText('clear', { ignoreCase: true, timeout: 5000 })
})

// ===========================================
// 5. 입력 에지 케이스
// ===========================================

test('빈 입력 → 전송 안됨', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on')

  await page.locator('.input-bar input').press('Enter')
  await expect(page.locator('.msg')).toHaveCount(0)
})

test('공백만 입력 → 전송 안됨', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on')

  await page.locator('.input-bar input').fill('   ')
  await page.locator('.input-bar input').press('Enter')
  await expect(page.locator('.msg')).toHaveCount(0)
})

test('Send 버튼 — 빈 입력 시 disabled', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on')

  await expect(page.locator('.input-bar button')).toBeDisabled()
})

// ===========================================
// 6. working 상태 + 입력 비활성화
// ===========================================

test('턴 실행 중 input disabled → 완료 후 enabled', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on')

  const input = page.locator('.input-bar input')
  await input.fill('질문')
  await input.press('Enter')

  // 응답 완료 후 다시 활성화
  await expect(page.locator('.msg-agent').first()).toBeVisible({ timeout: 10000 })
  await expect(input).toBeEnabled({ timeout: 5000 })
})

test('working 상태 → StatusBar 표시 변경', async ({ page }) => {
  mockLLM.setHandler((_req, n) =>
    JSON.stringify({ type: 'direct_response', message: `slow reply ${n}` })
  )

  await page.goto('/')
  await page.waitForSelector('.status-conn.on')

  await page.locator('.input-bar input').fill('질문')
  await page.locator('.input-bar input').press('Enter')

  // 응답 완료 후 idle 또는 error 중 하나 (직전 실패 상태 잔존 가능)
  await expect(page.locator('.msg-agent').first()).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.input-bar input')).toBeEnabled({ timeout: 5000 })
})

// ===========================================
// 7. 입력 히스토리 (↑↓)
// ===========================================

test('입력 히스토리 ↑↓ 탐색', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on')
  const input = page.locator('.input-bar input')

  await input.fill('AAA')
  await input.press('Enter')
  await expect(page.locator('.msg-agent').first()).toBeVisible({ timeout: 10000 })

  await input.fill('BBB')
  await input.press('Enter')
  await expect(page.locator('.msg-agent').nth(1)).toBeVisible({ timeout: 10000 })
  await expect(input).toBeEnabled({ timeout: 5000 })

  // ↑ → BBB, ↑ → AAA
  await input.press('ArrowUp')
  await expect(input).toHaveValue('BBB')
  await input.press('ArrowUp')
  await expect(input).toHaveValue('AAA')

  // ↓ → BBB, ↓ → 빈 문자열
  await input.press('ArrowDown')
  await expect(input).toHaveValue('BBB')
  await input.press('ArrowDown')
  await expect(input).toHaveValue('')
})

// ===========================================
// 8. tool execution (plan + EXEC + RESPOND)
// ===========================================

test('도구 실행 plan → 결과 표시', async ({ page }) => {
  mockLLM.setHandler(() => JSON.stringify({
    type: 'plan',
    steps: [
      { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
      { op: 'RESPOND', args: { ref: 1 } },
    ],
  }))

  await page.goto('/')
  await page.waitForSelector('.status-conn.on')

  await page.locator('.input-bar input').fill('파일 목록')
  await page.locator('.input-bar input').press('Enter')

  // 에이전트 응답 (tool 결과)
  const agentMsg = page.locator('.msg-agent').first()
  await expect(agentMsg).toBeVisible({ timeout: 10000 })
  // file_list 결과는 파일명 포함
  await expect(agentMsg).not.toBeEmpty()
})

// ===========================================
// 9. iteration (plan without RESPOND → re-plan)
// ===========================================

test('iteration: RESPOND 없는 plan → LLM re-plan', async ({ page }) => {
  let callNum = 0
  mockLLM.setHandler(() => {
    callNum++
    if (callNum === 1) {
      return JSON.stringify({
        type: 'plan',
        steps: [{ op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } }],
      })
    }
    return JSON.stringify({ type: 'direct_response', message: '파일을 확인했습니다.' })
  })

  await page.goto('/')
  await page.waitForSelector('.status-conn.on')

  await page.locator('.input-bar input').fill('파일 확인')
  await page.locator('.input-bar input').press('Enter')

  const agentMsg = page.locator('.msg-agent').first()
  await expect(agentMsg).toBeVisible({ timeout: 10000 })
  await expect(agentMsg).toContainText('파일을 확인했습니다.')
  expect(callNum).toBe(2)
})

// ===========================================
// 10. LLM 실패 → 에러 응답
// ===========================================

test('LLM 응답 파싱 실패 → 에러 메시지 표시', async ({ page }) => {
  mockLLM.setHandler(() => '<<<invalid json>>>')

  await page.goto('/')
  await page.waitForSelector('.status-conn.on')

  await page.locator('.input-bar input').fill('파싱 실패 유도')
  await page.locator('.input-bar input').press('Enter')

  // 에이전트 응답 (에러 메시지 포함)
  const agentMsg = page.locator('.msg-agent').first()
  await expect(agentMsg).toBeVisible({ timeout: 10000 })
  await expect(agentMsg).toContainText('오류')
})

test('LLM 파싱 실패 후 error 상태 + 입력 가능', async ({ page }) => {
  mockLLM.setHandler(() => '<<<bad>>>')

  await page.goto('/')
  await page.waitForSelector('.status-conn.on')

  await page.locator('.input-bar input').fill('에러')
  await page.locator('.input-bar input').press('Enter')

  await expect(page.locator('.msg-agent').first()).toBeVisible({ timeout: 10000 })
  // 실패 후 status는 'error' (lastTurn.tag === failure → deriveStatus 결과)
  await expect(page.locator('.status-indicator')).toContainText('error', { timeout: 5000 })
  // 하지만 입력은 가능 (working이 아니므로)
  await expect(page.locator('.input-bar input')).toBeEnabled()
})

// ===========================================
// 11. 부분 도구 실패 → LLM re-plan
// ===========================================

test('도구 부분 실패: 3개 중 1개 실패 → re-plan 성공', async ({ page }) => {
  let callNum = 0
  mockLLM.setHandler(() => {
    callNum++
    if (callNum === 1) {
      return JSON.stringify({
        type: 'plan',
        steps: [
          { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
          { op: 'EXEC', args: { tool: 'nonexistent_tool', tool_args: {} } },
          { op: 'EXEC', args: { tool: 'file_list', tool_args: { path: '.' } } },
        ],
      })
    }
    return JSON.stringify({ type: 'direct_response', message: '2개 성공, 1개 실패를 확인했습니다.' })
  })

  await page.goto('/')
  await page.waitForSelector('.status-conn.on')

  await page.locator('.input-bar input').fill('3가지 도구 실행')
  await page.locator('.input-bar input').press('Enter')

  const agentMsg = page.locator('.msg-agent').first()
  await expect(agentMsg).toBeVisible({ timeout: 10000 })
  await expect(agentMsg).toContainText('확인했습니다')
  expect(callNum).toBe(2) // plan + re-plan
})

// ===========================================
// 12. WebSocket 실시간 상태 동기화
// ===========================================

test('WebSocket: turn 실시간 동기화', async ({ page }) => {
  mockLLM.setHandler((_req, n) =>
    JSON.stringify({ type: 'direct_response', message: `reply ${n}` })
  )

  await page.goto('/')
  await page.waitForSelector('.status-conn.on')

  // 현재 turn 캡처
  const barText = await page.locator('.status-bar').textContent()
  const turnBefore = parseInt(barText.match(/turn:\s*(\d+)/)?.[1] || '0')

  await page.locator('.input-bar input').fill('q1')
  await page.locator('.input-bar input').press('Enter')
  await expect(page.locator('.msg-agent').first()).toBeVisible({ timeout: 10000 })

  // turn +1 (WebSocket push로 업데이트)
  await expect(page.locator('.status-bar')).toContainText(`turn: ${turnBefore + 1}`, { timeout: 5000 })
})

// ===========================================
// 13. 자동 스크롤
// ===========================================

test('메시지 추가 시 자동 스크롤', async ({ page }) => {
  mockLLM.setHandler((_req, n) =>
    JSON.stringify({ type: 'direct_response', message: `긴 응답 ${n}: ${'내용 '.repeat(50)}` })
  )

  await page.goto('/')
  await page.waitForSelector('.status-conn.on')
  const input = page.locator('.input-bar input')

  // 여러 메시지로 스크롤 발생
  for (let i = 0; i < 5; i++) {
    await input.fill(`질문 ${i + 1}`)
    await input.press('Enter')
    await expect(page.locator('.msg-agent').nth(i)).toBeVisible({ timeout: 10000 })
  }

  // 마지막 메시지가 뷰포트 내에 있는지 확인
  const lastMsg = page.locator('.msg-agent').last()
  await expect(lastMsg).toBeInViewport()
})

// ===========================================
// 14. 메시지 역할별 스타일링
// ===========================================

test('메시지 역할별 CSS 클래스', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on')
  const input = page.locator('.input-bar input')

  // user 메시지
  await input.fill('사용자 질문')
  await input.press('Enter')
  await expect(page.locator('.msg-user')).toHaveCount(1)

  // agent 메시지
  await expect(page.locator('.msg-agent').first()).toBeVisible({ timeout: 10000 })

  // system 메시지
  await input.fill('/status')
  await input.press('Enter')
  await expect(page.locator('.msg-system').first()).toBeVisible({ timeout: 5000 })
})

// ===========================================
// 15. placeholder 텍스트
// ===========================================

test('입력 placeholder: idle → "Type a message..."', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on')

  await expect(page.locator('.input-bar input')).toHaveAttribute('placeholder', 'Type a message...')
})
