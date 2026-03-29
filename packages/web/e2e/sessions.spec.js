/**
 * Web E2E: 세션 관리 UI 테스트 (Playwright + mock LLM 서버)
 *
 * WS1. StatusBar에 세션 버튼 표시
 * WS2. 세션 버튼 클릭 → SessionPanel 오픈
 * WS3. SessionPanel에 user-default 표시 + "현재" 배지
 * WS4. 새 세션 생성 → 목록에 추가
 * WS5. 세션 전환 → StatusBar 세션 ID 변경
 * WS6. 전환 후 이전 세션으로 복귀
 * WS7. 세션 삭제 → 목록에서 제거
 * WS8. ✕ 버튼으로 패널 닫기
 */

import { test, expect } from '@playwright/test'
import { createMockLLM, startTestServer } from './helpers.js'

const PORT = 3201

let server
let mockLLM

test.beforeAll(async () => {
  mockLLM = createMockLLM()
  server = await startTestServer(mockLLM, { port: PORT })
})

test.afterAll(async () => {
  await server.cleanup()
})

test.beforeEach(() => {
  mockLLM.resetCalls()
  mockLLM.setHandler(() =>
    JSON.stringify({ type: 'direct_response', message: '응답' })
  )
})

// ---------------------------------------------------------------------------
// WS1. StatusBar에 세션 버튼 표시
// ---------------------------------------------------------------------------

test('WS1: StatusBar에 세션 버튼 표시', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}`)
  await page.waitForSelector('.status-conn.on')

  const btn = page.locator('.session-btn')
  await expect(btn).toBeVisible()
  await expect(btn).toContainText('user-default')
})

// ---------------------------------------------------------------------------
// WS2. 세션 버튼 클릭 → SessionPanel 오픈
// ---------------------------------------------------------------------------

test('WS2: 세션 버튼 클릭 → SessionPanel 오픈', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}`)
  await page.waitForSelector('.status-conn.on')

  await page.locator('.session-btn').click()
  await expect(page.locator('.session-panel')).toBeVisible()
  await expect(page.locator('.session-panel-title')).toContainText('세션 관리')
})

// ---------------------------------------------------------------------------
// WS3. SessionPanel에 user-default + "현재" 배지
// ---------------------------------------------------------------------------

test('WS3: SessionPanel - user-default "현재" 배지', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}`)
  await page.waitForSelector('.status-conn.on')

  await page.locator('.session-btn').click()
  await page.waitForSelector('.session-panel')

  // session list에 user-default 표시
  await expect(page.locator('.session-item').first()).toBeVisible()
  const defaultItem = page.locator('.session-item').filter({ hasText: 'user-default' })
  await expect(defaultItem).toBeVisible()
  await expect(defaultItem.locator('.session-item-current')).toContainText('현재')

  // user-default는 삭제 버튼 없음
  await expect(defaultItem.locator('.btn-session-delete')).not.toBeVisible()
})

// ---------------------------------------------------------------------------
// WS4. 새 세션 생성 → 목록에 추가
// ---------------------------------------------------------------------------

test('WS4: 새 세션 생성 → 목록 갱신', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}`)
  await page.waitForSelector('.status-conn.on')

  await page.locator('.session-btn').click()
  await page.waitForSelector('.session-panel')

  const initialCount = await page.locator('.session-item').count()

  // ID 입력 후 생성
  await page.locator('.session-create-input').fill('test-sess-1')
  await page.locator('.btn-session-create').click()

  // 목록 갱신 후 새 세션 등장
  await expect(page.locator('.session-item')).toHaveCount(initialCount + 1, { timeout: 5000 })
  await expect(page.locator('.session-item').filter({ hasText: 'test-sess-1' })).toBeVisible()

  // 생성 후 입력 필드 비워짐
  await expect(page.locator('.session-create-input')).toHaveValue('')
})

// ---------------------------------------------------------------------------
// WS5. 세션 전환 → StatusBar 세션 ID 변경
// ---------------------------------------------------------------------------

test('WS5: 세션 전환 → StatusBar 갱신', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}`)
  await page.waitForSelector('.status-conn.on')

  // 세션 생성
  const res = await page.request.post(`http://127.0.0.1:${PORT}/api/sessions`, {
    data: { id: 'switch-target', type: 'user' },
  })
  expect(res.status()).toBe(201)

  await page.locator('.session-btn').click()
  await page.waitForSelector('.session-panel')

  // switch-target 세션의 전환 버튼 클릭
  const targetItem = page.locator('.session-item').filter({ hasText: 'switch-target' })
  await expect(targetItem).toBeVisible()
  await targetItem.locator('.btn-session-switch').click()

  // 패널이 닫히고 StatusBar에 새 sessionId 표시
  await expect(page.locator('.session-panel')).not.toBeVisible()
  await expect(page.locator('.session-btn')).toContainText('switch-target', { timeout: 5000 })
})

// ---------------------------------------------------------------------------
// WS6. 전환 후 user-default로 복귀
// ---------------------------------------------------------------------------

test('WS6: 전환 후 user-default로 복귀', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}`)
  await page.waitForSelector('.status-conn.on')

  // 세션 생성 및 전환
  await page.request.post(`http://127.0.0.1:${PORT}/api/sessions`, {
    data: { id: 'switch-back-test', type: 'user' },
  })

  await page.locator('.session-btn').click()
  await page.waitForSelector('.session-panel')
  const targetItem = page.locator('.session-item').filter({ hasText: 'switch-back-test' })
  await expect(targetItem).toBeVisible()
  await targetItem.locator('.btn-session-switch').click()

  await expect(page.locator('.session-btn')).toContainText('switch-back-test', { timeout: 5000 })

  // user-default로 복귀
  await page.locator('.session-btn').click()
  await page.waitForSelector('.session-panel')
  const defaultItem = page.locator('.session-item').filter({ hasText: 'user-default' })
  await defaultItem.locator('.btn-session-switch').click()

  await expect(page.locator('.session-btn')).toContainText('user-default', { timeout: 5000 })
})

// ---------------------------------------------------------------------------
// WS7. 세션 삭제 → 목록에서 제거
// ---------------------------------------------------------------------------

test('WS7: 세션 삭제 → 목록 갱신', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}`)
  await page.waitForSelector('.status-conn.on')

  // 삭제할 세션 생성
  await page.request.post(`http://127.0.0.1:${PORT}/api/sessions`, {
    data: { id: 'delete-me', type: 'user' },
  })

  await page.locator('.session-btn').click()
  await page.waitForSelector('.session-panel')

  const beforeCount = await page.locator('.session-item').count()
  const targetItem = page.locator('.session-item').filter({ hasText: 'delete-me' })
  await expect(targetItem).toBeVisible()

  // confirm 다이얼로그 자동 수락
  page.on('dialog', d => d.accept())
  await targetItem.locator('.btn-session-delete').click()

  // 목록에서 제거됨
  await expect(page.locator('.session-item')).toHaveCount(beforeCount - 1, { timeout: 5000 })
  await expect(page.locator('.session-item').filter({ hasText: 'delete-me' })).not.toBeVisible()
})

// ---------------------------------------------------------------------------
// WS8. ✕ 버튼으로 패널 닫기
// ---------------------------------------------------------------------------

test('WS8: ✕ 버튼으로 SessionPanel 닫기', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}`)
  await page.waitForSelector('.status-conn.on')

  await page.locator('.session-btn').click()
  await expect(page.locator('.session-panel')).toBeVisible()

  await page.locator('.session-panel-close').click()
  await expect(page.locator('.session-panel')).not.toBeVisible()
})
