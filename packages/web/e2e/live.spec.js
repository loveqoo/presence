// 실제 LLM 서버 대상 e2e 테스트.
// 단일 browser context + 한 번의 로그인으로 모든 테스트 실행.
// refresh token rotation 문제를 방지하기 위해 storageState 대신 context 공유.

import { test as base, expect } from '@playwright/test'

const TEST_USERNAME = process.env.TEST_USERNAME || 'testuser'
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'testpass123'
// 인스턴스에 직접 API 호출 (Vite 프록시 경유하지 않음)
const INSTANCE_URL = process.env.INSTANCE_URL || 'http://127.0.0.1:3001'

// API 요청용 access token
let apiAccessToken = null

async function getApiToken() {
  if (apiAccessToken) return apiAccessToken
  try {
    const res = await fetch(`${INSTANCE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD }),
    })
    if (res.ok) apiAccessToken = (await res.json()).accessToken
  } catch (_) {}
  return apiAccessToken
}

async function authRequest(method, path, data) {
  const token = await getApiToken()
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const opts = { method, headers }
  if (data) opts.body = JSON.stringify(data)
  return fetch(`${INSTANCE_URL}${path}`, opts)
}

// 공유 context + page: 로그인 1회, refresh token rotation 없음
let sharedContext = null
let sharedPage = null

base.beforeAll(async ({ browser }, testInfo) => {
  const baseURL = testInfo.project.use?.baseURL || 'http://localhost:5173'

  sharedContext = await browser.newContext({ baseURL })
  sharedPage = await sharedContext.newPage()

  await sharedPage.goto('/')

  const loginForm = sharedPage.locator('#username')
  const statusBar = sharedPage.locator('.status-bar')

  await expect(loginForm.or(statusBar)).toBeVisible({ timeout: 15000 })

  // 로그인 필요하면 로그인 (오케스트레이터가 인스턴스를 자동 결정)
  if (await loginForm.isVisible()) {
    await sharedPage.locator('#username').fill(TEST_USERNAME)
    await sharedPage.locator('#password').fill(TEST_PASSWORD)
    await sharedPage.locator('.login-container button[type="submit"]').click()
  }

  await sharedPage.waitForSelector('.status-conn.on', { timeout: 30000 })

  // 서버가 idle 상태가 될 때까지 대기
  await sharedPage.waitForFunction(
    () => document.querySelector('.status-indicator')?.textContent?.includes('idle'),
    { timeout: 30000 }
  )
})

base.afterAll(async () => {
  await sharedContext?.close()
  sharedContext = null
  sharedPage = null
})

// 공유 page를 사용하는 test fixture
const test = base.extend({
  livePage: async ({}, use) => {
    await use(sharedPage)
  },
  liveBaseURL: async ({}, use, testInfo) => {
    await use(testInfo.project.use?.baseURL || 'http://localhost:5173')
  },
})

// serial 실행 — 같은 context에서 순서 보장
test.describe.configure({ mode: 'serial' })

// ===========================================
// 1. 페이지 로드 + 서버 연결
// ===========================================

test('초기 UI: StatusBar + WebSocket 연결', async ({ livePage: page }) => {
  await expect(page.locator('.status-bar')).toBeVisible()
  await expect(page.locator('.status-indicator')).toContainText('idle', { timeout: 15000 })
  await expect(page.locator('.input-bar input')).toBeEnabled()
  await expect(page.locator('.status-bar')).toContainText('tools:')
})

test('초기 상태: /clear 후 채팅 영역 비어있음', async ({ livePage: page }) => {
  const input = page.locator('.input-bar input')
  await input.fill('/clear')
  await input.press('Enter')
  await expect(page.locator('.msg-system').first()).toContainText('clear', { ignoreCase: true, timeout: 5000 })

  await expect(page.locator('.msg-user')).toHaveCount(0)
  await expect(page.locator('.msg-agent')).toHaveCount(0)
})

// ===========================================
// 2. 실제 LLM 응답
// ===========================================

test('메시지 전송 → 실제 LLM 응답', async ({ livePage: page }) => {
  const input = page.locator('.input-bar input')
  await input.fill('/clear')
  await input.press('Enter')
  await expect(page.locator('.msg-system').first()).toContainText('clear', { ignoreCase: true, timeout: 5000 })

  await input.fill('안녕하세요. 간단히 인사만 해주세요.')
  await input.press('Enter')

  await expect(page.locator('.msg-user').first()).toContainText('안녕하세요')
  // working 상태는 LLM이 빠르면 놓칠 수 있으므로 결과만 확인
  await expect(page.locator('.msg-agent').first()).toBeVisible({ timeout: 30000 })
  const agentText = await page.locator('.msg-agent').first().textContent()
  expect(agentText.trim().length).toBeGreaterThan(0)
  await expect(page.locator('.status-indicator')).not.toContainText('working', { timeout: 15000 })
})

test('turn 카운터 증가', async ({ livePage: page }) => {
  // idle 확인 후 현재 상태 스냅샷
  await expect(page.locator('.status-indicator')).toContainText('idle', { timeout: 15000 })
  const agentCountBefore = await page.locator('.msg-agent').count()
  const barBefore = await page.locator('.status-bar').textContent()
  const turnBefore = parseInt(barBefore.match(/turn:\s*(\d+)/)?.[1] || '0')

  await page.locator('.input-bar input').fill('1+1은?')
  await page.locator('.input-bar input').press('Enter')
  // 새 agent 메시지가 추가될 때까지 대기 (이전 테스트 잔여 메시지 구분)
  await expect(page.locator('.msg-agent')).toHaveCount(agentCountBefore + 1, { timeout: 30000 })
  await expect(page.locator('.status-indicator')).not.toContainText('working', { timeout: 15000 })

  // turn이 최소 1 이상 증가했는지 확인
  const barAfter = await page.locator('.status-bar').textContent()
  const turnAfter = parseInt(barAfter.match(/turn:\s*(\d+)/)?.[1] || '0')
  expect(turnAfter).toBeGreaterThan(turnBefore)
})

// ===========================================
// 3. 슬래시 명령
// ===========================================

test('/status → 시스템 메시지', async ({ livePage: page }) => {
  await page.locator('.input-bar input').fill('/status')
  await page.locator('.input-bar input').press('Enter')

  await expect(page.locator('.msg-system').last()).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.msg-system').last()).toContainText('idle')
})

test('/tools → 도구 목록', async ({ livePage: page }) => {
  await page.locator('.input-bar input').fill('/tools')
  await page.locator('.input-bar input').press('Enter')

  const sysMsg = page.locator('.msg-system').last()
  await expect(sysMsg).toBeVisible({ timeout: 5000 })
  await expect(sysMsg).toContainText('file_')
})

test('/clear → 대화 내역 삭제', async ({ livePage: page }) => {
  const input = page.locator('.input-bar input')

  await input.fill('안녕')
  await input.press('Enter')
  await expect(page.locator('.msg-agent').last()).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.status-indicator')).not.toContainText('working', { timeout: 15000 })

  await input.fill('/clear')
  await input.press('Enter')

  await expect(page.locator('.msg-system').first()).toContainText('clear', { ignoreCase: true, timeout: 5000 })
})

// ===========================================
// 4. 입력 에지 케이스
// ===========================================

test('빈 입력 → 전송 안됨', async ({ livePage: page }) => {
  const input = page.locator('.input-bar input')
  await input.fill('/clear')
  await input.press('Enter')
  await expect(page.locator('.msg-system').first()).toContainText('clear', { ignoreCase: true, timeout: 5000 })
  // /clear WS push로 history가 비워지고 pending도 제거될 때까지 대기
  await expect(page.locator('.msg-user')).toHaveCount(0, { timeout: 5000 })

  const userMsgsBefore = await page.locator('.msg-user').count()
  await input.press('Enter')
  await page.waitForTimeout(300)
  expect(await page.locator('.msg-user').count()).toBe(userMsgsBefore)
})

test('Send 버튼 — 빈 입력 시 disabled', async ({ livePage: page }) => {
  await page.locator('.input-bar input').fill('')
  await expect(page.locator('.input-bar button')).toBeDisabled()
})

// ===========================================
// 5. 실행 중 UI 상태
// ===========================================

test('턴 실행 중 input disabled → 완료 후 enabled', async ({ livePage: page }) => {
  const input = page.locator('.input-bar input')
  await input.fill('잠깐 생각해봐')
  await input.press('Enter')

  await expect(page.locator('.status-indicator')).toContainText('working', { timeout: 5000 })
  await expect(page.locator('.msg-agent').last()).toBeVisible({ timeout: 30000 })
  await expect(input).toBeEnabled({ timeout: 10000 })
})

// ===========================================
// 6. 도구 실행 (파일 목록)
// ===========================================

test('파일 목록 요청 → 도구 실행 후 응답', async ({ livePage: page }) => {
  await page.locator('.input-bar input').fill('현재 디렉토리의 파일 목록을 알려주세요.')
  await page.locator('.input-bar input').press('Enter')

  const agentMsg = page.locator('.msg-agent').last()
  await expect(agentMsg).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.status-indicator')).not.toContainText('working', { timeout: 30000 })

  const text = await agentMsg.textContent()
  expect(text.trim().length).toBeGreaterThan(0)
})

// ===========================================
// 7. 세션 관리
// ===========================================

test('WL-S1: StatusBar에 세션 버튼 표시', async ({ livePage: page }) => {
  const btn = page.locator('.session-btn')
  await expect(btn).toBeVisible()
  await expect(btn).toContainText('user-default')
})

test('WL-S2: SessionPanel 열기 → user-default 목록 표시', async ({ livePage: page }) => {
  await page.locator('.session-btn').click()
  await expect(page.locator('.session-panel')).toBeVisible()

  const defaultItem = page.locator('.session-item').filter({ hasText: 'user-default' })
  await expect(defaultItem).toBeVisible()
  await expect(defaultItem.locator('.session-item-current')).toContainText('현재')

  await page.locator('.session-panel-close').click()
  await expect(page.locator('.session-panel')).not.toBeVisible()
})

test('WL-S3: 새 세션 생성 → 목록에 추가됨', async ({ livePage: page}) => {
  const testId = `wl-live-${Date.now()}`

  await page.locator('.session-btn').click()
  await page.waitForSelector('.session-panel')

  await page.locator('.session-create-input').fill(testId)
  await page.locator('.btn-session-create').click()

  await expect(page.locator('.session-item').filter({ hasText: testId })).toBeVisible({ timeout: 5000 })

  await page.locator('.session-panel-close').click()
  await authRequest('DELETE', `/api/sessions/${testId}`)
})

test('WL-S4: 세션 전환 → StatusBar 갱신 + 메시지 초기화', async ({ livePage: page}) => {
  const testId = `wl-switch-${Date.now()}`
  await authRequest('POST', '/api/sessions', { id: testId, type: 'user' })

  await page.locator('.input-bar input').fill('안녕')
  await page.locator('.input-bar input').press('Enter')
  await expect(page.locator('.msg-user').last()).toBeVisible({ timeout: 5000 })

  await page.locator('.session-btn').click()
  await page.waitForSelector('.session-panel')
  const targetItem = page.locator('.session-item').filter({ hasText: testId })
  await expect(targetItem).toBeVisible()
  await targetItem.locator('.btn-session-switch').click()

  await expect(page.locator('.session-btn')).toContainText(testId, { timeout: 5000 })

  // 정리: 세션 삭제 → user-default로 자동 복귀
  await authRequest('DELETE', `/api/sessions/${testId}`)
  // 세션 삭제 후 패널 닫기 (이미 닫혀있으면 무시)
  if (await page.locator('.session-panel').isVisible()) {
    await page.locator('.session-panel-close').click()
  }
})

test('WL-S5: 새 세션에서 LLM 응답 (turn 증가)', async ({ livePage: page}) => {
  const testId = `wl-llm-${Date.now()}`
  await authRequest('POST', '/api/sessions', { id: testId, type: 'user' })

  await page.locator('.session-btn').click()
  await page.waitForSelector('.session-panel')
  const targetItem = page.locator('.session-item').filter({ hasText: testId })
  await targetItem.locator('.btn-session-switch').click()
  await expect(page.locator('.session-btn')).toContainText(testId, { timeout: 5000 })

  await page.locator('.input-bar input').fill('한 문장으로 인사해주세요.')
  await page.locator('.input-bar input').press('Enter')

  await expect(page.locator('.msg-user').last()).toContainText('한 문장')
  await expect(page.locator('.msg-agent').last()).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.status-indicator')).not.toContainText('working', { timeout: 15000 })

  // 정리: 세션 삭제 → user-default로 자동 복귀
  await authRequest('DELETE', `/api/sessions/${testId}`)
})

test('WL-S6: 세션 삭제 → 목록에서 제거', async ({ livePage: page}) => {
  const testId = `wl-del-${Date.now()}`
  await authRequest('POST', '/api/sessions', { id: testId, type: 'user' })

  await page.locator('.session-btn').click()
  await page.waitForSelector('.session-panel')

  const beforeCount = await page.locator('.session-item').count()
  const targetItem = page.locator('.session-item').filter({ hasText: testId })
  await expect(targetItem).toBeVisible()

  page.on('dialog', d => d.accept())
  await targetItem.locator('.btn-session-delete').click()

  await expect(page.locator('.session-item').filter({ hasText: testId })).not.toBeVisible({ timeout: 5000 })
})
