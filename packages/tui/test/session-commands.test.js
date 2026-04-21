/**
 * TUI /session 슬래시 커맨드 테스트
 *
 * ink-testing-library + mock callbacks로 세션 관리 커맨드를 검증합니다.
 * 실제 서버 불필요 (네트워크 없음).
 *
 * SC1.  /session        → onListSessions 호출, 목록 표시
 * SC2.  /session        → 현재 세션에 ● 마커 + (현재) 표시
 * SC3.  /session new <id>  → onCreateSession('id') 호출
 * SC4.  /session new       → onCreateSession(null) 호출 (ID 자동 생성)
 * SC5.  /session switch <id> → onSwitchSession('id') 호출
 * SC6.  /session switch     → usage 힌트 출력
 * SC7.  /session delete <other-id> → onDeleteSession('other-id') 호출
 * SC8.  /session delete <current>  → 현재 세션 삭제 거부 메시지
 * SC9.  /session delete             → usage 힌트 출력
 * SC10. 콜백 없음         → not_available 메시지
 */

import React from 'react'
import { render } from 'ink-testing-library'
import { App } from '@presence/tui/ui/App.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { initI18n } from '@presence/infra/i18n'
import { assert, summary } from '../../../test/lib/assert.js'

initI18n('ko')

const h = React.createElement

console.log('Session commands tests')

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise(r => setTimeout(r, ms))

const waitFor = (fn, { timeout = 3000, interval = 30 } = {}) =>
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

const typeInput = async (stdin, text) => {
  for (const ch of text) { stdin.write(ch); await delay(5) }
  stdin.write('\r')
  await delay(30)
}

const makeState = () => {
  const state = createOriginState()
  state.set('turnState', { tag: 'idle' })
  state.set('turn', 0)
  state.set('todos', [])
  state.set('events', [])
  state.set('_toolResults', [])
  return state
}

const MOCK_SESSIONS = [
  { id: 'user-default', type: 'user' },
  { id: 'user-abc', type: 'user' },
  { id: 'agent-writer', type: 'agent' },
]

// ---------------------------------------------------------------------------
// SC1. /session → onListSessions 호출, 세션 목록 표시
// ---------------------------------------------------------------------------
{
  let listCalled = false
  const state = makeState()
  const { lastFrame, stdin, unmount } = render(h(App, {
    state,
    sessionId: 'user-default',
    onListSessions: async () => { listCalled = true; return MOCK_SESSIONS },
    tools: [], agents: [], initialMessages: [],
  }))
  try {
    await typeInput(stdin, '/session')
    await waitFor(() => lastFrame().includes('user-abc'))
    assert(listCalled, 'SC1: onListSessions 호출됨')
    assert(lastFrame().includes('user-default'), 'SC1: user-default 표시')
    assert(lastFrame().includes('user-abc'), 'SC1: user-abc 표시')
    assert(lastFrame().includes('agent-writer'), 'SC1: agent-writer 표시')
  } finally { unmount() }
}

// ---------------------------------------------------------------------------
// SC2. /session → 현재 세션(●) 및 (현재) 마커
// ---------------------------------------------------------------------------
{
  const state = makeState()
  const { lastFrame, stdin, unmount } = render(h(App, {
    state,
    sessionId: 'user-default',
    onListSessions: async () => MOCK_SESSIONS,
    tools: [], agents: [], initialMessages: [],
  }))
  try {
    await typeInput(stdin, '/session')
    await waitFor(() => lastFrame().includes('현재'))
    const frame = lastFrame()
    // 현재 세션 줄에 ● 마커
    const lines = frame.split('\n')
    const currentLine = lines.find(l => l.includes('user-default') && l.includes('현재'))
    assert(!!currentLine, 'SC2: 현재 세션 줄에 (현재) 표시')
    const markerLine = lines.find(l => l.includes('●') && l.includes('user-default'))
    assert(!!markerLine, 'SC2: 현재 세션 줄에 ● 마커')
  } finally { unmount() }
}

// ---------------------------------------------------------------------------
// SC3. /session new myid → onCreateSession('myid') 호출
// ---------------------------------------------------------------------------
{
  let createArg = undefined
  const state = makeState()
  const { lastFrame, stdin, unmount } = render(h(App, {
    state,
    sessionId: 'user-default',
    onCreateSession: async (id) => { createArg = id; return { id: id || 'user-xyz', type: 'user' } },
    tools: [], agents: [], initialMessages: [],
  }))
  try {
    await typeInput(stdin, '/session new myid')
    await waitFor(() => lastFrame().includes('myid') || lastFrame().includes('생성됨'))
    assert(createArg === 'myid', `SC3: onCreateSession('myid') 호출됨 (got: ${createArg})`)
  } finally { unmount() }
}

// ---------------------------------------------------------------------------
// SC4. /session new (인자 없음) → onCreateSession(null) 호출
// ---------------------------------------------------------------------------
{
  let createArg = 'sentinel'
  const state = makeState()
  const { lastFrame, stdin, unmount } = render(h(App, {
    state,
    sessionId: 'user-default',
    onCreateSession: async (id) => { createArg = id; return { id: 'user-auto', type: 'user' } },
    tools: [], agents: [], initialMessages: [],
  }))
  try {
    await typeInput(stdin, '/session new')
    await waitFor(() => lastFrame().includes('생성됨') || createArg !== 'sentinel')
    assert(createArg === null, `SC4: onCreateSession(null) 호출됨 (got: ${JSON.stringify(createArg)})`)
  } finally { unmount() }
}

// ---------------------------------------------------------------------------
// SC4b. FP-64: /session new 가 서버 400 응답을 받으면 code 기반 한국어 메시지 표시
// ---------------------------------------------------------------------------
{
  const state = makeState()
  const { lastFrame, stdin, unmount } = render(h(App, {
    state,
    sessionId: 'user-default',
    // 서버가 400 응답을 resolve 로 돌려준 것처럼 { error, code } 반환
    onCreateSession: async () => ({
      error: 'Session: workingDir "/etc" outside allowedDirs [/Users/x]',
      code: 'WORKING_DIR_OUT_OF_BOUNDS',
    }),
    tools: [], agents: [], initialMessages: [],
  }))
  try {
    await typeInput(stdin, '/session new oops')
    await waitFor(() => lastFrame().includes('허용 범위를 벗어났습니다'), { timeout: 2000 })
    const frame = lastFrame()
    assert(frame.includes('허용 범위를 벗어났습니다'),
      'SC4b: FP-64 한국어 에러 메시지')
    assert(!frame.includes('outside allowedDirs'),
      'SC4b: 영어 원문이 노출되지 않음')
  } finally { unmount() }
}

// ---------------------------------------------------------------------------
// SC5. /session switch target-id → onSwitchSession('target-id') 호출
// ---------------------------------------------------------------------------
{
  let switchArg = undefined
  const state = makeState()
  const { lastFrame, stdin, unmount } = render(h(App, {
    state,
    sessionId: 'user-default',
    onSwitchSession: async (id) => { switchArg = id },
    tools: [], agents: [], initialMessages: [],
  }))
  try {
    await typeInput(stdin, '/session switch target-id')
    await waitFor(() => lastFrame().includes('전환 중'))
    assert(switchArg === 'target-id', `SC5: onSwitchSession('target-id') 호출됨 (got: ${switchArg})`)
    assert(lastFrame().includes('target-id'), 'SC5: 전환 메시지에 세션 ID 포함')
  } finally { unmount() }
}

// ---------------------------------------------------------------------------
// SC6. /session switch (ID 없음) → usage 힌트
// ---------------------------------------------------------------------------
{
  let switchCalled = false
  const state = makeState()
  const { lastFrame, stdin, unmount } = render(h(App, {
    state,
    sessionId: 'user-default',
    onSwitchSession: async () => { switchCalled = true },
    tools: [], agents: [], initialMessages: [],
  }))
  try {
    await typeInput(stdin, '/session switch')
    await waitFor(() => lastFrame().includes('switch'))
    assert(!switchCalled, 'SC6: ID 없으면 onSwitchSession 호출 안됨')
    assert(lastFrame().includes('switch'), 'SC6: usage 힌트에 switch 포함')
  } finally { unmount() }
}

// ---------------------------------------------------------------------------
// SC7. /session delete other-id → onDeleteSession('other-id') 호출
// ---------------------------------------------------------------------------
{
  let deleteArg = undefined
  const state = makeState()
  const { lastFrame, stdin, unmount } = render(h(App, {
    state,
    sessionId: 'user-default',
    onDeleteSession: async (id) => { deleteArg = id },
    tools: [], agents: [], initialMessages: [],
  }))
  try {
    await typeInput(stdin, '/session delete other-id')
    await waitFor(() => lastFrame().includes('삭제됨') || deleteArg !== undefined)
    assert(deleteArg === 'other-id', `SC7: onDeleteSession('other-id') 호출됨 (got: ${deleteArg})`)
  } finally { unmount() }
}

// ---------------------------------------------------------------------------
// SC8. /session delete <현재 세션> → 삭제 거부
// ---------------------------------------------------------------------------
{
  let deleteCalled = false
  const state = makeState()
  const { lastFrame, stdin, unmount } = render(h(App, {
    state,
    sessionId: 'user-default',
    onDeleteSession: async () => { deleteCalled = true },
    tools: [], agents: [], initialMessages: [],
  }))
  try {
    await typeInput(stdin, '/session delete user-default')
    await waitFor(() => lastFrame().includes('현재 세션'))
    assert(!deleteCalled, 'SC8: 현재 세션 삭제 시 onDeleteSession 호출 안됨')
    assert(lastFrame().includes('현재 세션'), 'SC8: 거부 메시지 표시')
  } finally { unmount() }
}

// ---------------------------------------------------------------------------
// SC9. /session delete (ID 없음) → usage 힌트
// ---------------------------------------------------------------------------
{
  let deleteCalled = false
  const state = makeState()
  const { lastFrame, stdin, unmount } = render(h(App, {
    state,
    sessionId: 'user-default',
    onDeleteSession: async () => { deleteCalled = true },
    tools: [], agents: [], initialMessages: [],
  }))
  try {
    await typeInput(stdin, '/session delete')
    await waitFor(() => lastFrame().includes('delete'))
    assert(!deleteCalled, 'SC9: ID 없으면 onDeleteSession 호출 안됨')
    assert(lastFrame().includes('delete'), 'SC9: usage 힌트에 delete 포함')
  } finally { unmount() }
}

// ---------------------------------------------------------------------------
// SC10. 콜백 없음 → not_available 메시지
// ---------------------------------------------------------------------------
{
  const state = makeState()
  const { lastFrame, stdin, unmount } = render(h(App, {
    state,
    sessionId: 'user-default',
    // onListSessions 등 콜백 미전달
    tools: [], agents: [], initialMessages: [],
  }))
  try {
    await typeInput(stdin, '/session')
    await waitFor(() => lastFrame().includes('사용할 수 없'))
    assert(lastFrame().includes('사용할 수 없'), 'SC10: 콜백 없으면 not_available 표시')
  } finally { unmount() }
}

summary()
