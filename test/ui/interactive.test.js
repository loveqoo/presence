import React from 'react'
import { render } from 'ink-testing-library'
import { StatusBar } from '@presence/tui/ui/components/StatusBar.js'
import { ChatArea } from '@presence/tui/ui/components/ChatArea.js'
import { App } from '@presence/tui/ui/App.js'
import { createReactiveState } from '@presence/infra/infra/state.js'
import { ERROR_KIND } from '@presence/core/core/policies.js'
import { Phase, TurnResult, ErrorInfo } from '@presence/core/core/turn.js'
import { assert, summary } from '../lib/assert.js'

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
    const state = createReactiveState({
      turnState: Phase.idle(),
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
    state.set('turnState', Phase.working('test input'))
    await new Promise(r => setTimeout(r, 50))
    frame = lastFrame()
    assert(frame.includes('thinking'), 'App working: shows thinking')

    // retry 이벤트
    state.set('_retry', { attempt: 1, maxRetries: 2, error: 'parse error' })
    await new Promise(r => setTimeout(r, 50))
    frame = lastFrame()
    assert(frame.includes('retry 1/2'), 'App retry: shows retry status')

    // idle 복귀
    state.set('lastTurn', TurnResult.success('test', 'result'))
    state.set('turnState', Phase.idle())
    await new Promise(r => setTimeout(r, 50))
    frame = lastFrame()
    assert(frame.includes('idle'), 'App idle again: back to idle')
    assert(!frame.includes('retry'), 'App idle again: retry cleared')

    unmount()
  }

  // failure 상태 표시
  {
    const state = createReactiveState({
      turnState: Phase.idle(),
      lastTurn: TurnResult.failure('q', ErrorInfo('parse error', ERROR_KIND.PLANNER_PARSE), 'err'),
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
    const state = createReactiveState({
      turnState: Phase.idle(),
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

  // _toolResults 상태 변경 → App이 tool 메시지로 변환
  {
    const state = createReactiveState({
      turnState: Phase.idle(),
      lastTurn: null,
      turn: 0,
      context: { memories: [] },
    })

    const { lastFrame, unmount } = render(
      h(App, { state, agentName: 'ToolTest' })
    )
    await new Promise(r => setTimeout(r, 50))

    // 인터프리터가 tool result를 emit하는 상황 시뮬레이션
    state.set('_toolResults', [
      { tool: 'file_list', args: { path: '.' }, result: '[dir] src\n[file] index.js' },
    ])
    await new Promise(r => setTimeout(r, 100))

    let frame = lastFrame()
    // 기본은 collapsed: 요약만 표시
    assert(frame.includes('file_list'), 'App toolResult: tool name shown')
    assert(frame.includes('1 dirs, 1 files'), 'App toolResult: summary shown')
    assert(!frame.includes('[dir]'), 'App toolResult: no raw [dir] tag')

    // 두 번째 tool result 추가 — 기존 것 위에 누적
    state.set('_toolResults', [
      { tool: 'file_list', args: { path: '.' }, result: '[dir] src\n[file] index.js' },
      { tool: 'calculate', args: { expression: '2+3' }, result: '5' },
    ])
    await new Promise(r => setTimeout(r, 100))

    frame = lastFrame()
    assert(frame.includes('= 5'), 'App toolResult: calculate always shown')
    assert(frame.includes('1 dirs'), 'App toolResult: first summary still visible')

    unmount()
  }

  // 턴 시작 시 _toolResults 초기화 확인
  {
    const state = createReactiveState({
      turnState: Phase.idle(),
      lastTurn: null,
      turn: 0,
      context: { memories: [] },
    })

    const { lastFrame, unmount } = render(
      h(App, { state, agentName: 'ResetTest' })
    )
    await new Promise(r => setTimeout(r, 50))

    // 이전 턴의 tool result
    state.set('_toolResults', [
      { tool: 'calculate', args: { expression: '1+1' }, result: '2' },
    ])
    await new Promise(r => setTimeout(r, 100))
    assert(lastFrame().includes('= 2'), 'toolResult reset: first turn result shown')

    // 새 턴 시작 → _toolResults 초기화됨
    state.set('turnState', Phase.working('new turn'))
    await new Promise(r => setTimeout(r, 100))

    const toolResults = state.get('_toolResults')
    assert(Array.isArray(toolResults) && toolResults.length === 0,
      'toolResult reset: _toolResults cleared on turn start')

    unmount()
  }

  summary()
}

run()
