/**
 * TUI live e2e — 실제 실행 중인 서버(실제 LLM)를 대상으로 TUI 흐름 검증.
 * 서버를 직접 띄우지 않음. 먼저 `node src/server/index.js`를 실행해야 한다.
 *
 * 사용법:
 *   node src/server/index.js &
 *   node test/e2e/tui-live.test.js [--url http://127.0.0.1:3000]
 */

import React from 'react'
import { render } from 'ink-testing-library'
import http from 'node:http'
import { createRemoteState } from '../../src/infra/remote-state.js'
import { App } from '../../src/ui/App.js'
import { assert, summary } from '../lib/assert.js'

const h = React.createElement

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------

const baseUrl = (() => {
  const idx = process.argv.indexOf('--url')
  return idx !== -1 ? process.argv[idx + 1] : 'http://127.0.0.1:3000'
})()
const wsUrl = baseUrl.replace(/^http/, 'ws')

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise(r => setTimeout(r, ms))

const waitFor = (fn, { timeout = 30000, interval = 100 } = {}) =>
  new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      try { const r = fn(); if (r) { resolve(r); return } } catch (_) {}
      if (Date.now() - start > timeout) {
        reject(new Error(`waitFor timeout: ${fn.toString().slice(0, 80)}`))
        return
      }
      setTimeout(check, interval)
    }
    check()
  })

const request = (method, path, body) =>
  new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl)
    const data = body ? JSON.stringify(body) : null
    const opts = {
      hostname: url.hostname, port: url.port, method, path: url.pathname,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }
    const req = http.request(opts, (res) => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }) }
        catch { resolve({ status: res.statusCode, body: buf }) }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })

const connectRemoteState = () => new Promise((resolve) => {
  const rs = createRemoteState({ wsUrl, sessionId: 'user-default' })
  const check = () => {
    if (rs.get('turnState') !== undefined) { resolve(rs); return }
    setTimeout(check, 20)
  }
  setTimeout(check, 20)
})

const typeInput = async (stdin, text) => {
  for (const ch of text) { stdin.write(ch); await delay(10) }
  stdin.write('\r')
  await delay(20)
}

// ---------------------------------------------------------------------------
// 서버 연결 확인
// ---------------------------------------------------------------------------

try {
  await request('GET', '/api/tools')
} catch {
  console.error(`서버에 연결할 수 없습니다: ${baseUrl}`)
  console.error('먼저 node src/server/index.js 를 실행하세요.')
  process.exit(1)
}

const toolsRes = await request('GET', '/api/tools')
const agentsRes = await request('GET', '/api/agents')
const configRes = await request('GET', '/api/config')
const tools = Array.isArray(toolsRes.body) ? toolsRes.body : []
const agents = Array.isArray(agentsRes.body) ? agentsRes.body : []
const config = configRes.body || {}

console.log(`TUI live e2e tests (서버: ${baseUrl}, 모델: ${config.llm?.model || '?'})`)

// ---------------------------------------------------------------------------
// 공통 setup — RemoteState + App 렌더
// ---------------------------------------------------------------------------

const setupLive = async () => {
  // /clear로 이전 대화 초기화
  await request('POST', '/api/chat', { input: '/clear' }).catch(() => {})
  await delay(200)

  const remoteState = await connectRemoteState()

  const onInput = (input) =>
    request('POST', '/api/chat', { input }).then(r => r.body?.content ?? null)
  const onApprove = (approved) => request('POST', '/api/approve', { approved })
  const onCancel = () => request('POST', '/api/cancel')

  const { lastFrame, stdin, unmount } = render(h(App, {
    state: remoteState,
    onInput, onApprove, onCancel,
    tools, agents,
    cwd: process.cwd(),
    gitBranch: '',
    model: config.llm?.model || '',
    config,
    memory: null, llm: null, mcpControl: null,
    initialMessages: [],
  }))

  const cleanup = () => { unmount(); remoteState.disconnect() }
  return { remoteState, lastFrame, stdin, cleanup }
}

// ---------------------------------------------------------------------------
// 테스트
// ---------------------------------------------------------------------------

// TL1. 초기 UI — idle + 입력 프롬프트
{
  const { lastFrame, cleanup } = await setupLive()
  try {
    await delay(200)
    assert(lastFrame().includes('idle'), 'TL1: 초기 상태 idle')
    assert(lastFrame().includes('>'), 'TL1: 입력 프롬프트 표시')
    assert(lastFrame().includes(config.llm?.model || ''), 'TL1: 모델명 StatusBar 표시')
  } finally { cleanup() }
}

// TL2. 실제 LLM 응답 — 짧은 인사 요청
{
  const { lastFrame, stdin, remoteState, cleanup } = await setupLive()
  try {
    const turnBefore = remoteState.get('turn') ?? 0
    await typeInput(stdin, '안녕하세요. 한 문장으로만 답해주세요.')

    await waitFor(() => lastFrame().includes('thinking'), { timeout: 5000 })
    assert(lastFrame().includes('thinking'), 'TL2: working 상태 전환')

    await waitFor(
      () => !lastFrame().includes('thinking') && lastFrame().includes('idle'),
      { timeout: 30000 }
    )
    assert(lastFrame().includes('idle'), 'TL2: 응답 후 idle 복귀')
    assert((remoteState.get('turn') ?? 0) > turnBefore, 'TL2: turn 증가')

    const frame = lastFrame()
    const hasResponse = frame.split('\n').some(l => l.trim().length > 5 && !l.includes('idle') && !l.includes('turn:') && !l.includes('>'))
    assert(hasResponse, 'TL2: 에이전트 응답 TUI에 표시')
  } finally { cleanup() }
}

// TL3. 파일 목록 요청 — 도구 실행 후 응답
{
  const { lastFrame, stdin, cleanup } = await setupLive()
  try {
    await typeInput(stdin, '현재 디렉토리 파일 목록을 알려줘.')

    await waitFor(() => lastFrame().includes('thinking'), { timeout: 5000 })
    await waitFor(
      () => !lastFrame().includes('thinking') && lastFrame().includes('idle'),
      { timeout: 30000 }
    )

    const frame = lastFrame()
    // tool 결과(file_list summary) 또는 에이전트 텍스트 응답 중 하나
    const hasTool = frame.includes('file_list') || frame.includes('dirs') || frame.includes('files')
    const hasText = frame.split('\n').some(l => l.trim().length > 10 && !l.includes('idle') && !l.includes('turn:') && !l.includes('>'))
    assert(hasTool || hasText, 'TL3: 파일 목록 요청 → 응답 표시')
  } finally { cleanup() }
}

// TL4. /status 슬래시 커맨드
{
  const { lastFrame, stdin, cleanup } = await setupLive()
  try {
    await typeInput(stdin, '/status')
    await waitFor(() => lastFrame().includes('status:'), { timeout: 5000 })
    assert(lastFrame().includes('status:'), 'TL4: /status system 메시지')
    assert(lastFrame().includes('idle'), 'TL4: /status 응답에 idle 포함')
  } finally { cleanup() }
}

// TL5. /tools 슬래시 커맨드
{
  const { lastFrame, stdin, cleanup } = await setupLive()
  try {
    await typeInput(stdin, '/tools')
    await waitFor(() => lastFrame().includes('file_'), { timeout: 5000 })
    assert(lastFrame().includes('file_'), 'TL5: /tools 도구 목록 표시')
  } finally { cleanup() }
}

// TL6. 빈 입력 → 전송 안됨
{
  const { lastFrame, remoteState, stdin, cleanup } = await setupLive()
  try {
    const turnBefore = remoteState.get('turn') ?? 0
    stdin.write('\r')
    await delay(300)
    assert((remoteState.get('turn') ?? 0) === turnBefore, 'TL6: 빈 입력 → turn 증가 없음')
  } finally { cleanup() }
}

// TL7. 입력 히스토리 ↑↓
{
  const { lastFrame, stdin, cleanup } = await setupLive()
  try {
    // 두 메시지 전송
    await typeInput(stdin, 'FIRST')
    await waitFor(() => lastFrame().includes('thinking'), { timeout: 5000 })
    await waitFor(() => !lastFrame().includes('thinking'), { timeout: 30000 })

    await typeInput(stdin, 'SECOND')
    await waitFor(() => lastFrame().includes('thinking'), { timeout: 5000 })
    await waitFor(() => !lastFrame().includes('thinking'), { timeout: 30000 })

    // ↑ → SECOND
    stdin.write('\x1B[A')
    await waitFor(() => lastFrame().includes('SECOND'), { timeout: 2000 })
    assert(lastFrame().includes('SECOND'), 'TL7: ↑ → 마지막 입력 복원')

    // ↑ → FIRST
    stdin.write('\x1B[A')
    await waitFor(() => lastFrame().includes('FIRST'), { timeout: 2000 })
    assert(lastFrame().includes('FIRST'), 'TL7: ↑↑ → 이전 입력 복원')
  } finally { cleanup() }
}

summary()
