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

// ===========================================
// 7. 세션 관리
// ===========================================

test('WL-S1: StatusBar에 세션 버튼 표시', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on', { timeout: 10000 })

  const btn = page.locator('.session-btn')
  await expect(btn).toBeVisible()
  await expect(btn).toContainText('user-default')
})

test('WL-S2: SessionPanel 열기 → user-default 목록 표시', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on', { timeout: 10000 })

  await page.locator('.session-btn').click()
  await expect(page.locator('.session-panel')).toBeVisible()

  const defaultItem = page.locator('.session-item').filter({ hasText: 'user-default' })
  await expect(defaultItem).toBeVisible()
  await expect(defaultItem.locator('.session-item-current')).toContainText('현재')

  await page.locator('.session-panel-close').click()
  await expect(page.locator('.session-panel')).not.toBeVisible()
})

test('WL-S3: 새 세션 생성 → 목록에 추가됨', async ({ page, request: req }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on', { timeout: 10000 })

  const testId = `wl-live-${Date.now()}`

  await page.locator('.session-btn').click()
  await page.waitForSelector('.session-panel')

  const initialCount = await page.locator('.session-item').count()
  await page.locator('.session-create-input').fill(testId)
  await page.locator('.btn-session-create').click()

  await expect(page.locator('.session-item')).toHaveCount(initialCount + 1, { timeout: 5000 })
  await expect(page.locator('.session-item').filter({ hasText: testId })).toBeVisible()

  // 정리
  await req.delete(`/api/sessions/${testId}`)
})

test('WL-S4: 세션 전환 → StatusBar 갱신 + 메시지 초기화', async ({ page, request: req }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on', { timeout: 10000 })

  const testId = `wl-switch-${Date.now()}`
  await req.post('/api/sessions', { data: { id: testId, type: 'user' } })

  // 먼저 user-default에 메시지 전송
  await page.locator('.input-bar input').fill('안녕')
  await page.locator('.input-bar input').press('Enter')
  await expect(page.locator('.msg-user').first()).toBeVisible({ timeout: 5000 })

  // 세션 전환
  await page.locator('.session-btn').click()
  await page.waitForSelector('.session-panel')
  const targetItem = page.locator('.session-item').filter({ hasText: testId })
  await expect(targetItem).toBeVisible()
  await targetItem.locator('.btn-session-switch').click()

  // StatusBar 갱신
  await expect(page.locator('.session-btn')).toContainText(testId, { timeout: 5000 })

  // 새 세션은 메시지 없음
  await expect(page.locator('.msg')).toHaveCount(0)

  // 정리
  await req.delete(`/api/sessions/${testId}`)
})

test('WL-S5: 새 세션에서 LLM 응답 (turn 증가)', async ({ page, request: req }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on', { timeout: 10000 })

  const testId = `wl-llm-${Date.now()}`
  await req.post('/api/sessions', { data: { id: testId, type: 'user' } })

  // 세션 전환
  await page.locator('.session-btn').click()
  await page.waitForSelector('.session-panel')
  const targetItem = page.locator('.session-item').filter({ hasText: testId })
  await targetItem.locator('.btn-session-switch').click()
  await expect(page.locator('.session-btn')).toContainText(testId, { timeout: 5000 })

  // 새 세션에서 메시지 전송
  await page.locator('.input-bar input').fill('한 문장으로 인사해주세요.')
  await page.locator('.input-bar input').press('Enter')

  await expect(page.locator('.msg-user').first()).toContainText('한 문장')
  await expect(page.locator('.msg-agent').first()).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.status-indicator')).not.toContainText('working', { timeout: 15000 })

  const text = await page.locator('.msg-agent').first().textContent()
  expect(text.trim().length).toBeGreaterThan(0)

  // 정리
  await req.delete(`/api/sessions/${testId}`)
})

test('WL-S6: 세션 삭제 → 목록에서 제거', async ({ page, request: req }) => {
  await page.goto('/')
  await page.waitForSelector('.status-conn.on', { timeout: 10000 })

  const testId = `wl-del-${Date.now()}`
  await req.post('/api/sessions', { data: { id: testId, type: 'user' } })

  await page.locator('.session-btn').click()
  await page.waitForSelector('.session-panel')

  const beforeCount = await page.locator('.session-item').count()
  const targetItem = page.locator('.session-item').filter({ hasText: testId })
  await expect(targetItem).toBeVisible()

  page.on('dialog', d => d.accept())
  await targetItem.locator('.btn-session-delete').click()

  await expect(page.locator('.session-item')).toHaveCount(beforeCount - 1, { timeout: 5000 })
  await expect(page.locator('.session-item').filter({ hasText: testId })).not.toBeVisible()
})
