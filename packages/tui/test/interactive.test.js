import React from 'react'
import { render } from 'ink-testing-library'
import { StatusBar } from '@presence/tui/ui/components/StatusBar.js'
import { ChatArea } from '@presence/tui/ui/components/ChatArea.js'
import { App } from '@presence/tui/ui/App.js'
import { deriveMessages } from '@presence/tui/ui/hooks/useAgentMessages.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { ERROR_KIND, TurnState, TurnOutcome, TurnError } from '@presence/core/core/policies.js'
import { initI18n } from '@presence/infra/i18n'
import { assert, summary } from '../../../test/lib/assert.js'

await initI18n('ko')

const h = React.createElement

async function run() {
  console.log('Interactive UI tests')

  // ===========================================
  // StatusBar — 상태별 렌더링
  // ===========================================

  // idle 상태 (with visibleItems for turn/mem)
  {
    const { lastFrame, unmount } = render(
      h(StatusBar, { status: 'idle', turn: 5, memoryCount: 3, agentName: 'Test', visibleItems: ['status', 'turn', 'mem'] })
    )
    const frame = lastFrame()
    assert(frame.includes('idle'), 'StatusBar idle: shows idle')
    assert(frame.includes('turn: 5'), 'StatusBar idle: shows turn')
    assert(frame.includes('mem: 3'), 'StatusBar idle: shows memory')
    assert(!frame.includes('[Test]'), 'StatusBar idle: agent name not shown')
    unmount()
  }

  // working 상태 + activity
  {
    const { lastFrame, unmount } = render(
      h(StatusBar, { status: 'working', activity: 'thinking...', turn: 1 })
    )
    const frame = lastFrame()
    assert(frame.includes('thinking...'), 'StatusBar working: shows activity')
    assert(!frame.includes('idle'), 'StatusBar working: not idle')
    unmount()
  }

  // working + retry activity
  {
    const { lastFrame, unmount } = render(
      h(StatusBar, { status: 'working', activity: 'retry 1/2...', turn: 3 })
    )
    const frame = lastFrame()
    assert(frame.includes('retry 1/2'), 'StatusBar retry: shows retry count')
    unmount()
  }

  // error 상태
  {
    const { lastFrame, unmount } = render(
      h(StatusBar, { status: 'error', turn: 2 })
    )
    const frame = lastFrame()
    assert(frame.includes('error'), 'StatusBar error: shows error')
    unmount()
  }

  // default visibleItems (status, dir, branch)
  {
    const { lastFrame, unmount } = render(
      h(StatusBar, { status: 'idle', cwd: '/home/user/project', gitBranch: 'main' })
    )
    const frame = lastFrame()
    assert(frame.includes('project'), 'StatusBar defaults: shows dir basename')
    assert(frame.includes('branch: main'), 'StatusBar defaults: shows branch')
    assert(!frame.includes('turn:'), 'StatusBar defaults: turn not shown by default')
    unmount()
  }

  // ===========================================
  // App — 상태 변화에 반응
  // ===========================================

  // idle → working → idle 전이
  {
    const state = createOriginState({
      turnState: TurnState.idle(),
      lastTurn: null,
      turn: 0,
      context: { memories: [] },
    })

    const { lastFrame, unmount } = render(
      h(App, { state, agentName: 'TestAgent' })
    )

    // 초기: idle
    await new Promise(r => setTimeout(r, 50))
    let frame = lastFrame()
    assert(frame.includes('idle'), 'App initial: shows idle')
    assert(!frame.includes('[TestAgent]'), 'App initial: agent name not shown')

    // working 전이
    state.set('turnState', TurnState.working('test input'))
    await new Promise(r => setTimeout(r, 50))
    frame = lastFrame()
    assert(frame.includes('thinking'), 'App working: shows thinking')

    // retry 이벤트
    state.set('_retry', { attempt: 1, maxRetries: 2, error: 'parse error' })
    await new Promise(r => setTimeout(r, 50))
    frame = lastFrame()
    assert(frame.includes('1/2'), 'App retry: shows retry status')

    // idle 복귀
    state.set('lastTurn', TurnOutcome.success('test', 'result'))
    state.set('turnState', TurnState.idle())
    await new Promise(r => setTimeout(r, 50))
    frame = lastFrame()
    assert(frame.includes('idle'), 'App idle again: back to idle')
    assert(!frame.includes('retry'), 'App idle again: retry cleared')

    unmount()
  }

  // failure 상태 표시
  {
    const state = createOriginState({
      turnState: TurnState.idle(),
      lastTurn: TurnOutcome.failure('q', TurnError('parse error', ERROR_KIND.PLANNER_PARSE), 'err'),
      turn: 1,
      context: { memories: [] },
    })

    const { lastFrame, unmount } = render(
      h(App, { state })
    )
    await new Promise(r => setTimeout(r, 50))
    const frame = lastFrame()
    assert(frame.includes('error'), 'App failure: shows error status')
    unmount()
  }

  // App에서 model prop이 StatusBar까지 전달되는지 확인
  {
    const state = createOriginState({
      turnState: TurnState.idle(),
      lastTurn: null,
      turn: 0,
      context: { memories: [] },
    })

    const { lastFrame, unmount } = render(
      h(App, { state, model: 'gpt-4o' })
    )
    await new Promise(r => setTimeout(r, 50))
    let frame = lastFrame()
    // 기본 visibleItems에 model 포함
    assert(frame.includes('gpt-4o'), 'App model: shown by default')
    unmount()
  }

  // 채팅 메시지 표시 (직접 ChatArea 테스트)
  {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'agent', content: 'world' },
      { role: 'system', content: 'Error occurred', tag: '에러' },
    ]

    const { lastFrame, unmount } = render(
      h(ChatArea, { messages })
    )
    const frame = lastFrame()
    assert(frame.includes('hello'), 'ChatArea: shows user message')
    assert(frame.includes('world'), 'ChatArea: shows agent response')
    assert(frame.includes('에러'), 'ChatArea: shows system tag')
    unmount()
  }

  // _toolTranscript 상태 변경 → App이 tool 메시지로 변환 (SSoT 전환)
  {
    const state = createOriginState({
      turnState: TurnState.idle(),
      lastTurn: null,
      turn: 0,
      context: { memories: [] },
    })

    const { lastFrame, unmount } = render(
      h(App, { state, agentName: 'ToolTest' })
    )
    await new Promise(r => setTimeout(r, 50))

    // 인터프리터가 tool result를 emit하는 상황 시뮬레이션 → _toolTranscript 에 append
    state.set('_toolTranscript', [
      { tool: 'file_list', args: { path: '.' }, result: '[dir] src\n[file] index.js', ts: 1000 },
    ])
    await new Promise(r => setTimeout(r, 100))

    let frame = lastFrame()
    // 기본은 collapsed: 요약만 표시
    assert(frame.includes('file_list'), 'App toolResult: tool name shown')
    assert(frame.includes('1 dirs, 1 files'), 'App toolResult: summary shown')
    assert(!frame.includes('[dir]'), 'App toolResult: no raw [dir] tag')

    // 두 번째 tool result 추가 — 기존 것 위에 누적
    state.set('_toolTranscript', [
      { tool: 'file_list', args: { path: '.' }, result: '[dir] src\n[file] index.js', ts: 1000 },
      { tool: 'calculate', args: { expression: '2+3' }, result: '5', ts: 2000 },
    ])
    await new Promise(r => setTimeout(r, 100))

    frame = lastFrame()
    assert(frame.includes('= 5'), 'App toolResult: calculate always shown')
    assert(frame.includes('1 dirs'), 'App toolResult: first summary still visible')

    unmount()
  }

  // 턴 넘어가도 _toolTranscript 는 유지 (SSoT, /clear 까지)
  {
    const state = createOriginState({
      turnState: TurnState.idle(),
      lastTurn: null,
      turn: 0,
      context: { memories: [] },
    })

    const { lastFrame, unmount } = render(
      h(App, { state, agentName: 'PersistTest' })
    )
    await new Promise(r => setTimeout(r, 50))

    state.set('_toolTranscript', [
      { tool: 'calculate', args: { expression: '1+1' }, result: '2', ts: 1000 },
    ])
    await new Promise(r => setTimeout(r, 100))
    assert(lastFrame().includes('= 2'), 'toolTranscript: first turn result shown')

    // 새 턴 시작 → _toolTranscript 유지됨
    state.set('turnState', TurnState.working('new turn'))
    await new Promise(r => setTimeout(r, 100))

    const transcript = state.get('_toolTranscript')
    assert(Array.isArray(transcript) && transcript.length === 1,
      'toolTranscript: preserved across turns (INV-CLR-1 에서만 초기화)')
    assert(lastFrame().includes('= 2'), 'toolTranscript: still rendered in new turn')

    unmount()
  }

  // cancelled history entry → output 이 화면에 표시되지 않음
  {
    const state = createOriginState({
      turnState: TurnState.idle(),
      lastTurn: TurnOutcome.success('취소 질문', '취소 응답'),
      turn: 2,
      context: {
        memories: [],
        conversationHistory: [
          { id: 'h-1', input: '일반 질문', output: '일반 응답', ts: 1 },
          { id: 'h-2', input: '취소 질문', output: '취소 응답', ts: 2, cancelled: true },
        ],
      },
    })

    const { lastFrame, unmount } = render(h(App, { state }))
    await new Promise(r => setTimeout(r, 100))
    const frame = lastFrame()

    // 일반 응답은 표시됨
    assert(frame.includes('일반 응답'), 'cancel filter: normal response shown')
    // cancelled entry 의 output 은 표시되지 않음
    assert(!frame.includes('취소 응답'), 'cancel filter: cancelled response hidden')
    // cancelled entry 의 input 은 표시됨 (유저가 입력한 건 보여줘야 함)
    assert(frame.includes('취소 질문'), 'cancel filter: cancelled input still shown')

    unmount()
  }

  // deriveMessages: pendingInput 이 lastTurn 이후 persisted → dedup (finish WS race)
  {
    // pendingInput.ts=50, 그 후 finish 가 history entry를 ts=150 으로 기록 → lastTurn.ts >= pending.ts
    const history = [{ id: 'h-1', input: '안녕', output: '반갑습니다', ts: 150 }]
    const msgs = deriveMessages({
      history, toolTranscript: [],
      pendingInput: { input: '안녕', ts: 50 },
      budgetWarning: null, transient: [], optimisticClearTs: 0,
    })
    const userMsgs = msgs.filter(m => m.role === 'user' && m.content === '안녕')
    assert(userMsgs.length === 1, 'pending dedup: shown only once when finish persisted this pending')
    assert(userMsgs[0].pending === undefined, 'pending dedup: renders persisted history entry (not pending)')
  }

  // deriveMessages: 같은 input 의 "과거 턴" 은 dedup 하지 않음 (정상 시나리오)
  // 사용자가 "안녕" 을 보내고 응답 후 다시 "안녕" 을 보낸 상황 → 새 pending 은 보여야 함
  {
    const history = [{ id: 'h-1', input: '안녕', output: '반갑습니다', ts: 100 }]
    const msgs = deriveMessages({
      history, toolTranscript: [],
      pendingInput: { input: '안녕', ts: 500 },  // 이전 turn 이후 시작된 새 pending
      budgetWarning: null, transient: [], optimisticClearTs: 0,
    })
    const pendings = msgs.filter(m => m.pending === true && m.content === '안녕')
    assert(pendings.length === 1, 'pending render: 같은 input 연속 질문 — 새 pending 렌더')
  }

  // deriveMessages: pendingInput 이 다른 값이면 별도 렌더
  {
    const history = [{ id: 'h-1', input: '이전 질문', output: '이전 응답', ts: 100 }]
    const msgs = deriveMessages({
      history, toolTranscript: [],
      pendingInput: { input: '새 질문', ts: 200 },
      budgetWarning: null, transient: [], optimisticClearTs: 0,
    })
    const pending = msgs.find(m => m.pending === true)
    assert(pending?.content === '새 질문', 'pending render: 다른 input 은 pending 으로 표시')
  }

  // deriveMessages: history 가 비어있으면 pending 그대로 렌더
  {
    const msgs = deriveMessages({
      history: [], toolTranscript: [],
      pendingInput: { input: '첫 질문', ts: 100 },
      budgetWarning: null, transient: [], optimisticClearTs: 0,
    })
    const pending = msgs.find(m => m.pending === true)
    assert(pending?.content === '첫 질문', 'pending render: empty history → pending shown')
  }

  summary()
}

run()
