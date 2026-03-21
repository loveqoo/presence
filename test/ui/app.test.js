import React from 'react'
import { renderToString, Box, Text } from 'ink'
import { StatusBar } from '../../src/ui/components/StatusBar.js'
import { ChatArea } from '../../src/ui/components/ChatArea.js'
import { SidePanel } from '../../src/ui/components/SidePanel.js'
import { deriveStatus, deriveMemoryCount } from '../../src/ui/App.js'
import { createReactiveState } from '../../src/infra/state.js'
import { Phase, TurnResult, ErrorInfo, ERROR_KIND } from '../../src/core/agent.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

console.log('UI component tests (renderToString)')

// 1. StatusBar renders status and turn
{
  const output = renderToString(
    React.createElement(StatusBar, { status: 'idle', turn: 5, memoryCount: 12 })
  )
  assert(output.includes('idle'), 'StatusBar: shows status')
  assert(output.includes('5'), 'StatusBar: shows turn')
  assert(output.includes('12'), 'StatusBar: shows memory count')
  assert(output.includes('Presence'), 'StatusBar: shows default agent name')
}

// 2. StatusBar with custom agent name
{
  const output = renderToString(
    React.createElement(StatusBar, { status: 'working', turn: 1, memoryCount: 0, agentName: 'TestBot' })
  )
  assert(output.includes('TestBot'), 'StatusBar: custom agent name')
  assert(output.includes('thinking'), 'StatusBar: shows working activity')
}

// 3. ChatArea renders messages
{
  const messages = [
    { role: 'user', content: 'Hello' },
    { role: 'agent', content: 'Hi there!' },
  ]
  const output = renderToString(
    React.createElement(ChatArea, { messages })
  )
  assert(output.includes('User'), 'ChatArea: shows user label')
  assert(output.includes('Hello'), 'ChatArea: shows user message')
  assert(output.includes('Agent'), 'ChatArea: shows agent label')
  assert(output.includes('Hi there'), 'ChatArea: shows agent message')
}

// 4. ChatArea with tag
{
  const messages = [
    { role: 'system', content: 'executing...', tag: '실행중' },
  ]
  const output = renderToString(
    React.createElement(ChatArea, { messages })
  )
  assert(output.includes('실행중'), 'ChatArea: shows tag')
}

// 5. Empty ChatArea
{
  const output = renderToString(
    React.createElement(ChatArea, { messages: [] })
  )
  assert(typeof output === 'string', 'ChatArea: empty renders without error')
}

// 6. StatusBar default props
{
  const output = renderToString(
    React.createElement(StatusBar, {})
  )
  assert(output.includes('idle'), 'StatusBar defaults: idle')
  assert(output.includes('0'), 'StatusBar defaults: turn 0')
}

// --- deriveStatus selector ---

// 7. turnState=working → 'working'
{
  const state = createReactiveState({ turnState: Phase.working('test'), lastTurn: null })
  assert(deriveStatus(state) === 'working', 'deriveStatus: working when turnState=working')
}

// 8. turnState=idle, lastTurn=failure → 'error'
{
  const state = createReactiveState({
    turnState: Phase.idle(),
    lastTurn: TurnResult.failure('q', ErrorInfo('err', ERROR_KIND.PLANNER_PARSE), 'msg'),
  })
  assert(deriveStatus(state) === 'error', 'deriveStatus: error when lastTurn=failure')
}

// 9. turnState=idle, lastTurn=success → 'idle'
{
  const state = createReactiveState({
    turnState: Phase.idle(),
    lastTurn: TurnResult.success('q', 'ok'),
  })
  assert(deriveStatus(state) === 'idle', 'deriveStatus: idle when lastTurn=success')
}

// 10. turnState=idle, lastTurn=null → 'idle'
{
  const state = createReactiveState({ turnState: Phase.idle(), lastTurn: null })
  assert(deriveStatus(state) === 'idle', 'deriveStatus: idle when lastTurn=null')
}

// --- deriveMemoryCount selector ---

// 11. context.memories가 배열이면 길이 반환
{
  const state = createReactiveState({ context: { memories: ['a', 'b', 'c'] } })
  assert(deriveMemoryCount(state) === 3, 'deriveMemoryCount: returns array length')
}

// 12. context.memories가 없으면 0
{
  const state = createReactiveState({ context: {} })
  assert(deriveMemoryCount(state) === 0, 'deriveMemoryCount: 0 when no memories')
}

// 13. context.memories가 배열이 아니면 0
{
  const state = createReactiveState({ context: { memories: 'not-array' } })
  assert(deriveMemoryCount(state) === 0, 'deriveMemoryCount: 0 when not array')
}

// --- StatusBar error rendering ---

// 14. StatusBar renders error status in red
{
  const output = renderToString(
    React.createElement(StatusBar, { status: 'error', turn: 3, memoryCount: 0 })
  )
  assert(output.includes('error'), 'StatusBar: shows error status')
}

// --- SidePanel ---

// 15. SidePanel with agents
{
  const agents = [
    { name: 'backend', status: 'idle' },
    { name: 'heartbeat', status: 'working' },
  ]
  const output = renderToString(
    React.createElement(SidePanel, { agents, stateSnapshot: { turnState: { tag: 'working', input: 'test' }, turn: 3 } })
  )
  assert(output.includes('backend'), 'SidePanel: shows agent name')
  assert(output.includes('idle'), 'SidePanel: shows agent status')
  assert(output.includes('heartbeat'), 'SidePanel: shows second agent')
  assert(output.includes('State'), 'SidePanel: shows State header')
  assert(output.includes('turn'), 'SidePanel: shows state key')
}

// 8. SidePanel empty agents
{
  const output = renderToString(
    React.createElement(SidePanel, { agents: [], stateSnapshot: {} })
  )
  assert(output.includes('none'), 'SidePanel: shows (none) when empty')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
