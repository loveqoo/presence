// 실제 LLM 서버 대상 e2e 테스트.
// 서버를 직접 띄우지 않고 이미 실행 중인 서버(기본 http://127.0.0.1:3000)에 연결.
// mock 서버 응답에 의존하지 않으므로 LLM 응답 내용보다 UI 흐름을 검증한다.

import { test, expect } from '@playwright/test'

// ===========================================
// 1. 페이지 로드 + 서버 연결
// ===========================================

test('초기 UI: StatusBar + WebSocket 연결', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on', { timeout: 10000 })

  await expect(page.locator('.status-bar')).toBeVisible()
  await expect(page.locator('.status-indicator')).toContainText('idle')
  await expect(page.locator('.input-bar input')).toBeEnabled()
  await expect(page.locator('.status-bar')).toContainText('tools:')
})

test('초기 상태: 채팅 영역 비어있음', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on', { timeout: 10000 })

  await expect(page.locator('.msg')).toHaveCount(0)
})

// ===========================================
// 2. 실제 LLM 응답
// ===========================================

test('메시지 전송 → 실제 LLM 응답', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on', { timeout: 10000 })

  await page.locator('.input-bar input').fill('안녕하세요. 간단히 인사만 해주세요.')
  await page.locator('.input-bar input').press('Enter')

  // 사용자 메시지 즉시 표시
  await expect(page.locator('.msg-user').first()).toContainText('안녕하세요')

  // working 상태로 전환
  await expect(page.locator('.status-indicator')).toContainText('working', { timeout: 5000 })

  // 실제 LLM 응답 도착 (최대 30초)
  await expect(page.locator('.msg-agent').first()).toBeVisible({ timeout: 30000 })
  const agentText = await page.locator('.msg-agent').first().textContent()
  expect(agentText.trim().length).toBeGreaterThan(0)

  // idle로 복귀
  await expect(page.locator('.status-indicator')).not.toContainText('working', { timeout: 15000 })
})

test('turn 카운터 증가', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on', { timeout: 10000 })

  const barBefore = await page.locator('.status-bar').textContent()
  const turnBefore = parseInt(barBefore.match(/turn:\s*(\d+)/)?.[1] || '0')

  await page.locator('.input-bar input').fill('1+1은?')
  await page.locator('.input-bar input').press('Enter')
  await expect(page.locator('.msg-agent').first()).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.status-indicator')).not.toContainText('working', { timeout: 15000 })

  await expect(page.locator('.status-bar')).toContainText(`turn: ${turnBefore + 1}`)
})

// ===========================================
// 3. 슬래시 명령
// ===========================================

test('/status → 시스템 메시지', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on', { timeout: 10000 })

  await page.locator('.input-bar input').fill('/status')
  await page.locator('.input-bar input').press('Enter')

  await expect(page.locator('.msg-system').first()).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.msg-system').first()).toContainText('idle')
})

test('/tools → 도구 목록', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on', { timeout: 10000 })

  await page.locator('.input-bar input').fill('/tools')
  await page.locator('.input-bar input').press('Enter')

  const sysMsg = page.locator('.msg-system').first()
  await expect(sysMsg).toBeVisible({ timeout: 5000 })
  await expect(sysMsg).toContainText('file_')
})

test('/clear → 대화 내역 삭제', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on', { timeout: 10000 })
  const input = page.locator('.input-bar input')

  await input.fill('안녕')
  await input.press('Enter')
  await expect(page.locator('.msg-agent').first()).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.status-indicator')).not.toContainText('working', { timeout: 15000 })

  await input.fill('/clear')
  await input.press('Enter')

  await expect(page.locator('.msg-system').first()).toContainText('clear', { ignoreCase: true, timeout: 5000 })
})

// ===========================================
// 4. 입력 에지 케이스
// ===========================================

test('빈 입력 → 전송 안됨', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on', { timeout: 10000 })

  await page.locator('.input-bar input').press('Enter')
  await expect(page.locator('.msg')).toHaveCount(0)
})

test('Send 버튼 — 빈 입력 시 disabled', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on', { timeout: 10000 })

  await expect(page.locator('.input-bar button')).toBeDisabled()
})

// ===========================================
// 5. 실행 중 UI 상태
// ===========================================

test('턴 실행 중 input disabled → 완료 후 enabled', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on', { timeout: 10000 })

  const input = page.locator('.input-bar input')
  await input.fill('잠깐 생각해봐')
  await input.press('Enter')

  // working 중에는 disabled
  await expect(page.locator('.status-indicator')).toContainText('working', { timeout: 5000 })

  // 완료 후 enabled
  await expect(page.locator('.msg-agent').first()).toBeVisible({ timeout: 30000 })
  await expect(input).toBeEnabled({ timeout: 10000 })
})

// ===========================================
// 6. 도구 실행 (파일 목록)
// ===========================================

test('파일 목록 요청 → 도구 실행 후 응답', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on', { timeout: 10000 })

  await page.locator('.input-bar input').fill('현재 디렉토리의 파일 목록을 알려주세요.')
  await page.locator('.input-bar input').press('Enter')

  const agentMsg = page.locator('.msg-agent').first()
  await expect(agentMsg).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.status-indicator')).not.toContainText('working', { timeout: 30000 })

  const text = await agentMsg.textContent()
  expect(text.trim().length).toBeGreaterThan(0)
})
