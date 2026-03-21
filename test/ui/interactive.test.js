import React from 'react'
import { render } from 'ink-testing-library'
import { StatusBar } from '../../src/ui/components/StatusBar.js'
import { ChatArea } from '../../src/ui/components/ChatArea.js'
import { App } from '../../src/ui/App.js'
import { createReactiveState } from '../../src/infra/state.js'
import { Phase, TurnResult, ErrorInfo, ERROR_KIND } from '../../src/core/agent.js'

const h = React.createElement

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

async function run() {
  console.log('Interactive UI tests')

  // ===========================================
  // StatusBar — 상태별 렌더링
  // ===========================================

  // idle 상태
  {
    const { lastFrame, unmount } = render(
      h(StatusBar, { status: 'idle', turn: 5, memoryCount: 3, agentName: 'Test' })
    )
    const frame = lastFrame()
    assert(frame.includes('idle'), 'StatusBar idle: shows idle')
    assert(frame.includes('turn: 5'), 'StatusBar idle: shows turn')
    assert(frame.includes('mem: 3'), 'StatusBar idle: shows memory')
    assert(frame.includes('[Test]'), 'StatusBar idle: shows agent name')
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
    assert(frame.includes('[TestAgent]'), 'App initial: shows agent name')

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

  // 메모리 카운트 초기화
  {
    const state = createReactiveState({
      turnState: Phase.idle(),
      lastTurn: null,
      turn: 0,
      context: { memories: ['a', 'b', 'c'] },
    })

    const { lastFrame, unmount } = render(
      h(App, { state })
    )
    await new Promise(r => setTimeout(r, 50))
    const frame = lastFrame()
    assert(frame.includes('mem: 3'), 'App memory init: shows initial count')
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
    assert(frame.includes('User'), 'ChatArea: shows user label')
    assert(frame.includes('hello'), 'ChatArea: shows user message')
    assert(frame.includes('Agent'), 'ChatArea: shows agent label')
    assert(frame.includes('world'), 'ChatArea: shows agent response')
    assert(frame.includes('에러'), 'ChatArea: shows system tag')
    unmount()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
