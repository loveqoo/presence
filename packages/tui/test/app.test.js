import React from 'react'
import { renderToString, Box, Text } from 'ink'
import { render as inkRender } from 'ink-testing-library'
import { StatusBar } from '@presence/tui/ui/components/StatusBar.js'
import { ChatArea } from '@presence/tui/ui/components/ChatArea.js'
import { SidePanel } from '@presence/tui/ui/components/SidePanel.js'
import { TranscriptOverlay, buildLines } from '@presence/tui/ui/components/TranscriptOverlay.js'
import { buildIterationLines } from '@presence/tui/ui/components/transcript/iterations.js'
import { ToolResultView, parseFileEntries, toGrid, truncateLines, getSummary } from '@presence/tui/ui/components/ToolResultView.js'
import { CodeView, detectLang, highlightJS, highlightJSON } from '@presence/tui/ui/components/CodeView.js'
import { detectWholeCodeLang, parseInline } from '@presence/tui/ui/components/MarkdownText.js'
import { deriveStatus, deriveMemoryCount } from '@presence/tui/ui/hooks/useAgentState.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { ERROR_KIND, TurnState, TurnOutcome, TurnError } from '@presence/core/core/policies.js'
import { ApprovePrompt, classifyRisk } from '@presence/tui/ui/components/ApprovePrompt.js'
import { InputBar } from '@presence/tui/ui/components/InputBar.js'
import { App } from '@presence/tui/ui/App.js'
import { checkServer } from '@presence/tui/http.js'
import { resolveServerUrl, remainingLabel, SERVER_URL_SOURCE_LABEL } from '@presence/tui/main'
import { handleStatusline } from '@presence/tui/ui/slash-commands/statusline.js'
import { handleMemory } from '@presence/tui/ui/slash-commands/memory.js'
import { handleSessions } from '@presence/tui/ui/slash-commands/sessions.js'
import { dispatchSlashCommand } from '@presence/tui/ui/slash-commands.js'
import { formatStepLabel } from '@presence/tui/ui/components/PlanView.js'
import { todoStatusIcon } from '@presence/tui/ui/components/SidePanel.js'
import { initI18n } from '@presence/infra/i18n'
import { assert, summary } from '../../../test/lib/assert.js'

// i18n 을 파일 최상단에서 초기화하여 SidePanel / op-chain 등 i18n 키를
// 사용하는 컴포넌트 테스트가 올바른 한글 라벨을 받도록 한다.
await initI18n('ko')

console.log('UI component tests (renderToString)')

// 1. StatusBar renders status and turn (with visibleItems including turn/mem)
{
  const output = renderToString(
    React.createElement(StatusBar, { status: 'idle', turn: 5, memoryCount: 12, visibleItems: ['status', 'turn', 'mem', 'tools'] })
  )
  assert(output.includes('idle'), 'StatusBar: shows status')
  assert(output.includes('5'), 'StatusBar: shows turn')
  assert(output.includes('12'), 'StatusBar: shows memory count')
  assert(!output.includes('[Presence]'), 'StatusBar: agent name not shown in StatusBar')
}

// 2. StatusBar with custom agent name
{
  const output = renderToString(
    React.createElement(StatusBar, { status: 'working', turn: 1, memoryCount: 0, agentName: 'TestBot' })
  )
  assert(!output.includes('[TestBot]'), 'StatusBar: custom agent name not shown')
  assert(output.includes('thinking'), 'StatusBar: shows working activity')
}

// 3. ChatArea renders messages (배경색으로 역할 구분, 라벨 없음)
{
  const messages = [
    { role: 'user', content: 'Hello' },
    { role: 'agent', content: 'Hi there!' },
  ]
  const output = renderToString(
    React.createElement(ChatArea, { messages })
  )
  assert(output.includes('Hello'), 'ChatArea: shows user message')
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

// 6. StatusBar default props (defaults to status, dir, branch)
{
  const output = renderToString(
    React.createElement(StatusBar, {})
  )
  assert(output.includes('idle'), 'StatusBar defaults: idle')
  assert(!output.includes('[Presence]'), 'StatusBar defaults: agent name not shown')
}

// --- deriveStatus selector ---

// 7. turnState=working → 'working'
{
  const state = createOriginState({ turnState: TurnState.working('test'), lastTurn: null })
  assert(deriveStatus(state) === 'working', 'deriveStatus: working when turnState=working')
}

// 8. turnState=idle, lastTurn=failure → 'error'
{
  const state = createOriginState({
    turnState: TurnState.idle(),
    lastTurn: TurnOutcome.failure('q', TurnError('err', ERROR_KIND.PLANNER_PARSE), 'msg'),
  })
  assert(deriveStatus(state) === 'error', 'deriveStatus: error when lastTurn=failure')
}

// 9. turnState=idle, lastTurn=success → 'idle'
{
  const state = createOriginState({
    turnState: TurnState.idle(),
    lastTurn: TurnOutcome.success('q', 'ok'),
  })
  assert(deriveStatus(state) === 'idle', 'deriveStatus: idle when lastTurn=success')
}

// 10. turnState=idle, lastTurn=null → 'idle'
{
  const state = createOriginState({ turnState: TurnState.idle(), lastTurn: null })
  assert(deriveStatus(state) === 'idle', 'deriveStatus: idle when lastTurn=null')
}

// 10b. lastTurn=failure with kind=aborted → 'idle' (사용자 의도 취소, UX 일관성)
{
  const state = createOriginState({
    turnState: TurnState.idle(),
    lastTurn: TurnOutcome.failure('q', TurnError('aborted', ERROR_KIND.ABORTED), null),
  })
  assert(deriveStatus(state) === 'idle', 'deriveStatus: aborted → idle (not error)')
}

// 10c. lastTurn=failure with kind=interpreter → 'error' (실제 에러는 그대로)
{
  const state = createOriginState({
    turnState: TurnState.idle(),
    lastTurn: TurnOutcome.failure('q', TurnError('boom', ERROR_KIND.INTERPRETER), null),
  })
  assert(deriveStatus(state) === 'error', 'deriveStatus: non-aborted failure remains error')
}

// --- deriveMemoryCount selector ---

// 11. context.memories가 배열이면 길이 반환
{
  const state = createOriginState({ context: { memories: ['a', 'b', 'c'] } })
  assert(deriveMemoryCount(state) === 3, 'deriveMemoryCount: returns array length')
}

// 12. context.memories가 없으면 0
{
  const state = createOriginState({ context: {} })
  assert(deriveMemoryCount(state) === 0, 'deriveMemoryCount: 0 when no memories')
}

// 13. context.memories가 배열이 아니면 0
{
  const state = createOriginState({ context: { memories: 'not-array' } })
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

// 14b. StatusBar error with errorHint (FP-01)
{
  const output = renderToString(
    React.createElement(StatusBar, { status: 'error', errorHint: 'interpreter' })
  )
  assert(output.includes('error: interpreter'), 'StatusBar: shows error hint')
}

// 14c. StatusBar error without errorHint falls back to plain label (FP-01)
{
  const output = renderToString(
    React.createElement(StatusBar, { status: 'error', errorHint: null })
  )
  assert(output.includes('✗ error'), 'StatusBar: plain error label when no hint')
  assert(!output.includes('error:'), 'StatusBar: no colon suffix when no hint')
}

// --- SidePanel ---

// 15. SidePanel with agents
{
  const agents = [
    { name: 'backend' },
    { name: 'heartbeat' },
  ]
  const output = renderToString(
    React.createElement(SidePanel, { agents, tools: [], todos: [], memoryCount: 5 })
  )
  assert(output.includes('backend'), 'SidePanel: shows agent name')
  assert(output.includes('heartbeat'), 'SidePanel: shows second agent')
  assert(output.includes('에이전트'), 'SidePanel: 에이전트 섹션 헤더')
  assert(output.includes('5개 노드'), 'SidePanel: 메모리 노드 수 (한글화)')
}

// 16. SidePanel empty agents
{
  const output = renderToString(
    React.createElement(SidePanel, { agents: [], tools: [], todos: [] })
  )
  assert(output.includes('없음'), 'SidePanel: (없음) when empty')
}

// --- StatusBar visibleItems ---

// 17. StatusBar with custom visibleItems
{
  const output = renderToString(
    React.createElement(StatusBar, {
      status: 'idle', turn: 10, memoryCount: 3, toolCount: 5,
      visibleItems: ['status', 'turn', 'tools'],
    })
  )
  assert(output.includes('turn: 10'), 'StatusBar visibleItems: shows turn')
  assert(output.includes('tools: 5'), 'StatusBar visibleItems: shows tools')
  assert(!output.includes('mem:'), 'StatusBar visibleItems: hides mem when not in list')
}

// 18. StatusBar with model item
{
  const output = renderToString(
    React.createElement(StatusBar, {
      status: 'idle', model: 'gpt-4',
      visibleItems: ['status', 'model'],
    })
  )
  assert(output.includes('gpt-4'), 'StatusBar visibleItems: shows model')
}

// --- TranscriptOverlay buildLines ---

// 19. buildLines with no debug data
{
  const lines = buildLines(null, null, null)
  assert(lines.length > 0, 'buildLines: returns lines even with no data')
  assert(lines.some(l => l.text.includes('no_data') || l.text.includes('no_turn') || l.text.includes('No')), 'buildLines: shows no data message')
}

// 20. buildLines with debug data
{
  const debug = {
    input: 'hello',
    memories: ['mem1', 'mem2'],
    iteration: 0,
    parsedType: 'direct_response',
    error: null,
    prompt: { systemLength: 100, messageCount: 2 },
    llmResponseLength: 500,
  }
  const prompt = [
    { role: 'system', content: 'You are a helper' },
    { role: 'user', content: 'hello' },
  ]
  const response = '{"type":"direct_response","message":"hi"}'
  const lines = buildLines(debug, prompt, response)

  const texts = lines.map(l => l.text).join('\n')
  assert(texts.includes('hello'), 'buildLines: shows input')
  assert(texts.includes('mem1'), 'buildLines: shows memories')
  assert(texts.includes('messages'), 'buildLines: shows prompt section')
  assert(texts.includes('system'), 'buildLines: shows prompt role')
  assert(texts.includes('direct_response'), 'buildLines: shows parsed type')
}

// 20b. buildLines with opTrace
{
  const trace = [
    { tag: 'GetState', detail: 'context.memories', timestamp: 1000, duration: 1 },
    { tag: 'AskLLM', detail: '2 msgs', timestamp: 1001, duration: 1240 },
    { tag: 'ExecuteTool', detail: 'file_read', timestamp: 2241, duration: 3, error: 'file not found' },
    { tag: 'Respond', detail: '안녕!', timestamp: 2244, duration: 1 },
    { tag: 'UpdateState', detail: 'turnState', timestamp: 2245, duration: 1 },
  ]
  const lines = buildLines(null, null, null, trace)
  const texts = lines.map(l => l.text).join('\n')
  assert(texts.includes('5개 op'), 'buildLines opTrace: shows op count (한글화)')
  assert(texts.includes('LLM 호출'), 'buildLines opTrace: shows AskLLM 한글 라벨')
  assert(texts.includes('← 느림'), 'buildLines opTrace: marks slowest op (한글화)')
  assert(texts.includes('file not found'), 'buildLines opTrace: shows error')
  assert(texts.includes('컨텍스트 로드'), 'buildLines opTrace: 컨텍스트 phase 한글화')
  assert(texts.includes('응답 전송'), 'buildLines opTrace: respond phase 한글화')
  const redLines = lines.filter(l => l.color === 'red')
  assert(redLines.length > 0, 'buildLines opTrace: error line is red')
}

// --- buildIterationLines (FP-57: 1 item = 1 terminal row 보장) ---

// 20c. buildIterationLines with empty history
{
  const lines = buildIterationLines([])
  assert(lines.length === 1, 'buildIterationLines empty: returns 1 line')
  assert(lines[0].text.includes('반복 이력'), 'buildIterationLines empty: shows no_iterations message')
}

// 20d. buildIterationLines with null
{
  const lines = buildIterationLines(null)
  assert(lines.length === 1, 'buildIterationLines null: returns 1 line')
}

// 20e. buildIterationLines with 1 iteration — 모든 라인은 단일 행(\n 없음)
{
  const history = [{
    iteration: 0, parsedType: 'tool_use', stepCount: 3,
    assembly: { used: 1500 }, promptMessages: 2, promptChars: 800,
    response: '{"result": "ok"}',
  }]
  const lines = buildIterationLines(history)
  assert(lines.length >= 6, 'buildIterationLines 1 iter: produces multiple lines')
  for (const line of lines) {
    assert(typeof line.text === 'string', 'buildIterationLines: text is string')
    assert(!line.text.includes('\n'), 'buildIterationLines: no embedded newlines (FP-57)')
  }
  const allText = lines.map(l => l.text).join(' ')
  assert(allText.includes('1') && (allText.includes('Iteration') || allText.includes('반복')), 'buildIterationLines 1 iter: shows iteration number')
  assert(allText.includes('tool_use'), 'buildIterationLines 1 iter: shows parsedType')
}

// 20f. buildIterationLines with error iteration
{
  const history = [{
    iteration: 0, parsedType: 'error', stepCount: 0,
    error: 'timeout exceeded', assembly: { used: 0 },
    promptMessages: 0, promptChars: 0, response: null,
  }]
  const lines = buildIterationLines(history)
  const errorLine = lines.find(l => l.color === 'red')
  assert(errorLine, 'buildIterationLines error: has red error line')
  assert(errorLine.text.includes('timeout exceeded'), 'buildIterationLines error: shows error message')
}

// 20g. buildIterationLines with multi-line response — 응답 줄바꿈도 개별 라인으로 분해
{
  const history = [{
    iteration: 0, parsedType: 'direct_response', stepCount: 1,
    assembly: { used: 100 }, promptMessages: 1, promptChars: 50,
    response: 'line1\nline2\nline3',
  }]
  const lines = buildIterationLines(history)
  for (const line of lines) {
    assert(!line.text.includes('\n'), 'buildIterationLines multi-line response: each line is 1 row')
  }
  const bodyLines = lines.filter(l => l.text.trim() === 'line1' || l.text.trim() === 'line2' || l.text.trim() === 'line3')
  assert(bodyLines.length === 3, 'buildIterationLines multi-line response: splits into 3 body lines')
}

// 20h. FP-57 회귀 — TranscriptOverlay Iterations 탭 ↓ 스크롤 후 헤더가 프레임에 1회만 존재
{
  const origRows = process.stdout.rows
  Object.defineProperty(process.stdout, 'rows', { value: 15, configurable: true })
  const iterationHistory = [
    {
      iteration: 0, parsedType: 'direct_response', stepCount: 1, retryAttempt: 0,
      assembly: { used: 100 }, promptMessages: 1, promptChars: 50,
      response: Array.from({ length: 20 }, (_, i) => `response line ${i + 1}`).join('\n'),
    },
    {
      iteration: 1, parsedType: 'plan', stepCount: 2, retryAttempt: 0,
      assembly: { used: 200 }, promptMessages: 2, promptChars: 80,
      response: Array.from({ length: 20 }, (_, i) => `second line ${i + 1}`).join('\n'),
    },
  ]
  const r = inkRender(React.createElement(TranscriptOverlay, {
    debug: null, lastPrompt: null, lastResponse: null,
    opTrace: [], recalledMemories: [], iterationHistory,
    onClose: () => {},
  }))
  await new Promise(res => setTimeout(res, 30))
  // → x4: Op Chain → Iterations
  for (let i = 0; i < 4; i++) r.stdin.write('\u001B[C')
  await new Promise(res => setTimeout(res, 20))
  // ↓ x5: scroll
  for (let i = 0; i < 5; i++) r.stdin.write('\u001B[B')
  await new Promise(res => setTimeout(res, 30))
  const frame = r.lastFrame()
  r.unmount()
  Object.defineProperty(process.stdout, 'rows', { value: origRows, configurable: true })
  const headerCount = (frame.match(/트랜스크립트/g) || []).length
  assert(headerCount === 1, `FP-57: header appears once per frame (got ${headerCount})`)
  const frameLines = frame.split('\n').length
  assert(frameLines <= 18, `FP-57: frame height bounded by rows + small margin (got ${frameLines})`)
  assert(frame.includes('response line') || frame.includes('parsedType') || frame.includes('assembly'), 'FP-57: Iterations tab content visible after scroll')
}

// 20i. FP-57 깜빡임 회귀 — 스크롤 양 끝에서 프레임 총 높이가 일정 (hasMore 토글로 layout 흔들리지 않음)
{
  const origRows = process.stdout.rows
  Object.defineProperty(process.stdout, 'rows', { value: 15, configurable: true })
  const iterationHistory = [{
    iteration: 0, parsedType: 'direct_response', stepCount: 1, retryAttempt: 0,
    assembly: { used: 100 }, promptMessages: 1, promptChars: 50,
    response: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n'),
  }]
  const r = inkRender(React.createElement(TranscriptOverlay, {
    debug: null, lastPrompt: null, lastResponse: null,
    opTrace: [], recalledMemories: [], iterationHistory,
    onClose: () => {},
  }))
  await new Promise(res => setTimeout(res, 30))
  for (let i = 0; i < 4; i++) r.stdin.write('\u001B[C') // reach Iterations tab
  await new Promise(res => setTimeout(res, 20))
  const frameTop = r.lastFrame()
  const topHeight = frameTop.split('\n').length
  // scroll to end — hasMore becomes false, footer text becomes placeholder
  for (let i = 0; i < 50; i++) r.stdin.write('\u001B[B')
  await new Promise(res => setTimeout(res, 30))
  const frameBottom = r.lastFrame()
  const bottomHeight = frameBottom.split('\n').length
  r.unmount()
  Object.defineProperty(process.stdout, 'rows', { value: origRows, configurable: true })
  assert(topHeight === bottomHeight, `FP-57: frame height stable across scroll (top=${topHeight}, bottom=${bottomHeight})`)
}

// --- ToolResultView helpers ---

// 21. parseFileEntries
{
  const entries = parseFileEntries('[dir] src\n[file] package.json\n[?] unknown')
  assert(entries.length === 3, 'parseFileEntries: parses 3 entries')
  assert(entries[0].isDir === true, 'parseFileEntries: src is dir')
  assert(entries[0].name === 'src', 'parseFileEntries: src name')
  assert(entries[1].isDir === false, 'parseFileEntries: package.json is file')
  assert(entries[2].isDir === false, 'parseFileEntries: unknown is not dir')
}

// 21b. parseFileEntries with new tree format
{
  const entries = parseFileEntries('├── src/\n├── package.json\n└── README.md')
  assert(entries.length === 3, 'parseFileEntries tree: parses 3 entries')
  assert(entries[0].isDir === true, 'parseFileEntries tree: src is dir')
  assert(entries[0].name === 'src', 'parseFileEntries tree: src name')
  assert(entries[1].isDir === false, 'parseFileEntries tree: package.json is file')
}

// 22. parseFileEntries with empty input
{
  const entries = parseFileEntries('')
  assert(entries.length === 0, 'parseFileEntries: empty input')
}

// 23. toGrid
{
  const items = [
    { display: 'abc/' },
    { display: 'defgh/' },
    { display: 'ij' },
    { display: 'klmno' },
  ]
  const { rows, colWidth } = toGrid(items, 40)
  assert(colWidth === 8, 'toGrid: colWidth = max(6) + 2 = 8')
  assert(rows.length >= 1, 'toGrid: at least 1 row')
  assert(rows[0].length <= 4, 'toGrid: fits within 40 cols')
}

// 24. truncateLines
{
  const { lines, truncated } = truncateLines('a\nb\nc\nd\ne', 3)
  assert(lines.length === 3, 'truncateLines: returns max lines')
  assert(truncated === 2, 'truncateLines: reports truncated count')
}

// 25. truncateLines no truncation
{
  const { lines, truncated } = truncateLines('a\nb', 5)
  assert(lines.length === 2, 'truncateLines: no truncation when under limit')
  assert(truncated === 0, 'truncateLines: 0 truncated')
}

// --- ToolResultView: collapsed (default) ---

// 26. collapsed file_list shows summary
{
  const result = '[dir] src\n[dir] test\n[file] package.json\n[file] README.md'
  const output = renderToString(
    React.createElement(ToolResultView, { tool: 'file_list', args: { path: '.' }, result })
  )
  assert(output.includes('2 dirs, 2 files'), 'collapsed file_list: shows summary counts')
  assert(!output.includes('src/'), 'collapsed file_list: no detail content')
}

// 27. collapsed file_read shows summary
{
  const output = renderToString(
    React.createElement(ToolResultView, { tool: 'file_read', args: { path: 'test.txt' }, result: 'line1\nline2' })
  )
  assert(output.includes('2 lines'), 'collapsed file_read: shows line count')
  assert(!output.includes('line1'), 'collapsed file_read: no detail content')
}

// 28. calculate always shows result (single-line, no body)
{
  const output = renderToString(
    React.createElement(ToolResultView, { tool: 'calculate', args: { expression: '7 * 13' }, result: '91' })
  )
  assert(output.includes('7 * 13'), 'ToolResultView calculate: shows expression')
  assert(output.includes('= 91'), 'ToolResultView calculate: shows result')
}

// 29. file_write always shows result (single-line, no body)
{
  const output = renderToString(
    React.createElement(ToolResultView, { tool: 'file_write', args: { path: 'out.txt' }, result: 'Written 42 chars to out.txt' })
  )
  assert(output.includes('out.txt'), 'ToolResultView file_write: shows path')
  assert(output.includes('Written'), 'ToolResultView file_write: shows result')
}

// --- ToolResultView: expanded ---

// 30. expanded file_list shows grid detail
{
  const result = '[dir] src\n[dir] test\n[file] package.json\n[file] README.md'
  const output = renderToString(
    React.createElement(ToolResultView, { tool: 'file_list', args: { path: '.' }, result, expanded: true })
  )
  assert(output.includes('src/'), 'expanded file_list: dir has trailing /')
  assert(output.includes('package.json'), 'expanded file_list: shows file name')
  assert(!output.includes('[dir]'), 'expanded file_list: no raw [dir] tag')
}

// 31. expanded file_read shows content
{
  const output = renderToString(
    React.createElement(ToolResultView, { tool: 'file_read', args: { path: 'test.txt' }, result: 'line1\nline2', expanded: true })
  )
  assert(output.includes('line1'), 'expanded file_read: shows content')
  assert(output.includes('test.txt'), 'expanded file_read: shows path')
}

// 32. expanded shell_exec shows command and output
{
  const output = renderToString(
    React.createElement(ToolResultView, { tool: 'shell_exec', args: { command: 'echo hi' }, result: 'hi', expanded: true })
  )
  assert(output.includes('$ echo hi'), 'expanded shell_exec: shows $ command')
  assert(output.includes('hi'), 'expanded shell_exec: shows output')
}

// --- ChatArea tool rendering ---

// 33. ChatArea default (collapsed) shows summary
{
  const messages = [
    { role: 'tool', tool: 'file_list', args: { path: '.' }, result: '[dir] src\n[file] test.js' },
  ]
  const output = renderToString(
    React.createElement(ChatArea, { messages })
  )
  assert(output.includes('1 dirs, 1 files'), 'ChatArea tool collapsed: shows summary')
  assert(!output.includes('[dir]'), 'ChatArea tool collapsed: no raw tags')
}

// 34. ChatArea expanded shows detail
{
  const messages = [
    { role: 'tool', tool: 'file_list', args: { path: '.' }, result: '[dir] src\n[file] test.js' },
  ]
  const output = renderToString(
    React.createElement(ChatArea, { messages, toolExpanded: true })
  )
  assert(output.includes('src/'), 'ChatArea tool expanded: shows dir/')
  assert(output.includes('test.js'), 'ChatArea tool expanded: shows file name')
}

// 35. default renderer for unknown tools (collapsed)
{
  const output = renderToString(
    React.createElement(ToolResultView, { tool: 'custom_tool', args: {}, result: 'some output' })
  )
  assert(output.includes('custom_tool'), 'collapsed default: shows tool name')
  assert(output.includes('1 lines'), 'collapsed default: shows line count')
}

// --- getSummary helper ---

// 36. getSummary for each tool type
{
  assert(getSummary('file_list', { path: '.' }, '[dir] a\n[file] b') === 'file_list . — 1 dirs, 1 files', 'getSummary: file_list')
  assert(getSummary('file_read', { path: 'x.js' }, 'a\nb\nc') === 'file_read x.js — 3 lines', 'getSummary: file_read')
  assert(getSummary('shell_exec', { command: 'ls' }, 'out') === '$ ls — 1 lines', 'getSummary: shell_exec')
  assert(getSummary('unknown', {}, 'a\nb') === 'unknown — 2 lines', 'getSummary: default')
}

// --- CodeView / syntax highlighting ---

// 37. detectLang from filename
{
  assert(detectLang('package.json') === 'json', 'detectLang: json')
  assert(detectLang('index.js') === 'js', 'detectLang: js')
  assert(detectLang('app.ts') === 'js', 'detectLang: ts → js')
  assert(detectLang('run.sh') === 'sh', 'detectLang: sh')
  assert(detectLang('README.md') === 'text', 'detectLang: md → text')
  assert(detectLang(null) === 'text', 'detectLang: null → text')
}

// 38. highlightJSON tokenizes keys and values
{
  const tokens = highlightJSON('  "name": "presence",')
  const colors = tokens.filter(t => t.color).map(t => t.color)
  assert(colors.includes('cyan'), 'highlightJSON: key is cyan')
  assert(colors.includes('green'), 'highlightJSON: string value is green')
}

// 39. highlightJSON numbers and booleans
{
  const tokens = highlightJSON('  "count": 42, "ok": true')
  const colors = tokens.filter(t => t.color).map(t => t.color)
  assert(colors.includes('yellow'), 'highlightJSON: number is yellow')
  assert(colors.includes('magenta'), 'highlightJSON: boolean is magenta')
}

// 40. highlightJS keywords and strings
{
  const tokens = highlightJS('const x = "hello"')
  const kwToken = tokens.find(t => t.text === 'const')
  const strToken = tokens.find(t => t.text === '"hello"')
  assert(kwToken && kwToken.color === 'magenta', 'highlightJS: keyword is magenta')
  assert(strToken && strToken.color === 'green', 'highlightJS: string is green')
}

// 41. highlightJS comments
{
  const tokens = highlightJS('x = 1 // comment')
  const last = tokens[tokens.length - 1]
  assert(last.color === 'gray', 'highlightJS: comment is gray')
  assert(last.text.includes('comment'), 'highlightJS: comment text preserved')
}

// 42. CodeView renders with line numbers
{
  const output = renderToString(
    React.createElement(CodeView, { code: '{"a": 1}', lang: 'json' })
  )
  assert(output.includes('1'), 'CodeView: shows line number')
  assert(output.includes('a'), 'CodeView: shows content')
}

// 43. CodeView truncates long content
{
  const code = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
  const output = renderToString(
    React.createElement(CodeView, { code, lang: 'text', maxLines: 5 })
  )
  assert(output.includes('+25 lines'), 'CodeView: shows truncation count')
}

// 44. expanded file_read uses CodeView (has line numbers)
{
  const output = renderToString(
    React.createElement(ToolResultView, {
      tool: 'file_read',
      args: { path: 'test.json' },
      result: '{"name": "test"}',
      expanded: true,
    })
  )
  assert(output.includes('1'), 'file_read expanded: has line number')
  assert(output.includes('name'), 'file_read expanded: shows content')
}

// --- detectWholeCodeLang (agent 응답 자동 감지) ---

// 45. JSON object 감지
{
  assert(detectWholeCodeLang('{"name": "test"}') === 'json', 'detectWholeCodeLang: JSON object')
}

// 46. JSON array 감지
{
  assert(detectWholeCodeLang('[1, 2, 3]') === 'json', 'detectWholeCodeLang: JSON array')
}

// 47. multiline JSON 감지
{
  const json = '{\n  "name": "presence",\n  "version": "0.1.0"\n}'
  assert(detectWholeCodeLang(json) === 'json', 'detectWholeCodeLang: multiline JSON')
}

// 48. 일반 텍스트는 null
{
  assert(detectWholeCodeLang('Hello world') === null, 'detectWholeCodeLang: plain text → null')
}

// 49. 잘못된 JSON은 null
{
  assert(detectWholeCodeLang('{broken json') === null, 'detectWholeCodeLang: invalid JSON → null')
}

// 50. agent가 raw JSON 응답 → CodeView로 렌더링 (줄번호 포함)
{
  const messages = [
    { role: 'agent', content: '{\n  "name": "presence"\n}' },
  ]
  const output = renderToString(
    React.createElement(ChatArea, { messages })
  )
  // CodeView가 사용되면 줄번호가 표시됨
  assert(output.includes('1'), 'agent JSON response: has line numbers')
  assert(output.includes('name'), 'agent JSON response: shows content')
}

// --- buildReport ---

import { buildReport } from '@presence/tui/ui/report.js'
import { formatDuration } from '@presence/tui/ui/components/transcript/op-chain-format.js'
import { truncate } from '@presence/tui/ui/report-sections.js'

// 51. formatDuration helper
{
  assert(formatDuration(null) === '...', 'formatDuration: null → ...')
  assert(formatDuration(0) === '< 1ms', 'formatDuration: 0 → < 1ms')
  assert(formatDuration(50) === '50ms', 'formatDuration: 50 → 50ms')
  assert(formatDuration(1500) === '1.5s', 'formatDuration: 1500 → 1.5s')
}

// 52. truncate helper
{
  assert(truncate(null) === '(none)', 'truncate: null → (none)')
  assert(truncate('short') === 'short', 'truncate: short string unchanged')
  assert(truncate('a'.repeat(300), 100).includes('... (300 chars total)'), 'truncate: long string truncated')
}

// 53. buildReport with full data
{
  const report = buildReport({
    debug: {
      input: '안녕하세요',
      iteration: 0,
      parsedType: 'direct_response',
      error: null,
      memories: ['mem1', 'mem2'],
      assembly: { budget: 24000, used: 18000, historyUsed: 2, historyDropped: 0, memoriesUsed: 2 },
      timestamp: Date.now(),
    },
    opTrace: [
      { tag: 'UpdateState', timestamp: 1000, duration: 2 },
      { tag: 'AskLLM', timestamp: 1002, duration: 1240 },
      { tag: 'Respond', timestamp: 2242, duration: 1 },
    ],
    lastPrompt: [
      { role: 'system', content: 'You are a helper' },
      { role: 'user', content: '안녕하세요' },
    ],
    lastResponse: '{"type":"direct_response","message":"안녕하세요!"}',
    state: createOriginState({
      turnState: TurnState.idle(),
      lastTurn: TurnOutcome.success('q', 'ok'),
      turn: 5,
      context: { memories: ['m1'], conversationHistory: [{ input: 'a', output: 'b' }] },
    }),
    config: { llm: { model: 'qwen3.5-35b', baseUrl: 'http://127.0.0.1:8045/v1', responseFormat: 'json_object', maxRetries: 2 }, maxIterations: 10, embed: { baseUrl: 'http://127.0.0.1:8045/v1' } },
  })

  assert(report.includes('# Presence Debug Report'), 'buildReport: has title')
  assert(report.includes('안녕하세요'), 'buildReport: has input')
  assert(report.includes('direct_response'), 'buildReport: has result type')
  assert(report.includes('Timeline'), 'buildReport: has timeline')
  assert(report.includes('AskLLM'), 'buildReport: has op tag')
  assert(report.includes('slowest'), 'buildReport: marks slowest op')
  assert(report.includes('Assembly'), 'buildReport: has assembly')
  assert(report.includes('24000'), 'buildReport: has budget')
  assert(report.includes('75%'), 'buildReport: has percentage')
  assert(report.includes('Prompt'), 'buildReport: has prompt section')
  assert(report.includes('system'), 'buildReport: has prompt role')
  assert(report.includes('LLM Response'), 'buildReport: has response section')
  assert(report.includes('direct_response'), 'buildReport: has response content')
  assert(report.includes('Recalled Memories'), 'buildReport: has memories')
  assert(report.includes('mem1'), 'buildReport: has memory content')
  assert(report.includes('State'), 'buildReport: has state section')
  assert(report.includes('Turn:**') && report.includes('5'), 'buildReport: has turn count')
  assert(report.includes('Config'), 'buildReport: has config section')
  assert(report.includes('qwen3.5-35b'), 'buildReport: has model name')
}

// 54. buildReport with minimal data (no debug)
{
  const report = buildReport({ debug: null, opTrace: [], lastPrompt: null, lastResponse: null, state: null, config: null })
  assert(report.includes('# Presence Debug Report'), 'buildReport minimal: has title')
  assert(report.includes('no turn data'), 'buildReport minimal: shows no turn data')
  assert(report.includes('no op trace'), 'buildReport minimal: shows no trace')
}

// 55. buildReport with error in trace
{
  const report = buildReport({
    debug: { input: 'test', iteration: 0, parsedType: null, error: 'parse failed', memories: [], timestamp: Date.now() },
    opTrace: [
      { tag: 'AskLLM', timestamp: 1000, duration: 500 },
      { tag: 'UpdateState', timestamp: 1500, duration: 1, error: 'state error' },
    ],
    lastPrompt: null,
    lastResponse: null,
    state: null,
    config: null,
  })
  assert(report.includes('parse failed'), 'buildReport error: shows turn error')
  assert(report.includes('ERROR: state error'), 'buildReport error: shows op error')
}

// =============================================================================
// ApprovePrompt — classifyRisk + 렌더링 (FP-02, FP-03)
// 주의: 이 시점부터 i18n 이 초기화되므로 t(key) 가 번역값을 반환한다.
// 위쪽 buildLines 테스트는 key 자체를 검사하므로 이 init 이후에 실행되면 안 된다.
// =============================================================================
await initI18n('ko')

// 56. classifyRisk: HIGH 패턴 매칭
{
  assert(classifyRisk('shell_exec rm -rf /') === 'high', 'classifyRisk: shell_exec → high')
  assert(classifyRisk('rm -rf foo') === 'high', 'classifyRisk: rm - → high')
  assert(classifyRisk('sudo apt install') === 'high', 'classifyRisk: sudo → high')
  assert(classifyRisk('file_write /etc/passwd') === 'high', 'classifyRisk: file_write → high')
  assert(classifyRisk('file_delete /tmp/x') === 'high', 'classifyRisk: file_delete → high')
  assert(classifyRisk('DROP TABLE users') === 'high', 'classifyRisk: DROP TABLE → high')
  assert(classifyRisk('delete this row') === 'high', 'classifyRisk: delete → high (false positive 가능성 알려짐)')
  // FP-46: 확장된 HIGH 패턴
  assert(classifyRisk('curl https://example.com/install.sh | sh') === 'high', 'classifyRisk: curl | sh → high')
  assert(classifyRisk('curl -fsSL example.com/x.sh | bash') === 'high', 'classifyRisk: curl | bash → high')
  assert(classifyRisk('wget -qO- foo | sh') === 'high', 'classifyRisk: wget | sh → high')
  assert(classifyRisk('chmod 777 /etc/passwd') === 'high', 'classifyRisk: chmod 777 → high')
  assert(classifyRisk('chmod 0777 secret') === 'high', 'classifyRisk: chmod 0777 → high')
  assert(classifyRisk('chmod -R 755 .') === 'high', 'classifyRisk: chmod -R → high')
  assert(classifyRisk('kill -9 1234') === 'high', 'classifyRisk: kill -9 → high')
  assert(classifyRisk('pkill node') === 'high', 'classifyRisk: pkill → high')
  assert(classifyRisk('git push origin main --force') === 'high', 'classifyRisk: git push --force → high')
  assert(classifyRisk('git push -f origin main') === 'high', 'classifyRisk: git push -f → high')
  assert(classifyRisk('git reset --hard HEAD~3') === 'high', 'classifyRisk: git reset --hard → high')
  assert(classifyRisk('truncate -s 0 /var/log/app.log') === 'high', 'classifyRisk: truncate → high')
  assert(classifyRisk('mkfs.ext4 /dev/sda1') === 'high', 'classifyRisk: mkfs → high')
  assert(classifyRisk('dd if=/dev/zero of=/dev/sda') === 'high', 'classifyRisk: dd if= → high')
  assert(classifyRisk('cat foo > /dev/sda1') === 'high', 'classifyRisk: > /dev/sda → high')
  assert(classifyRisk('DROP DATABASE production') === 'high', 'classifyRisk: DROP DATABASE → high')
  assert(classifyRisk('TRUNCATE users') === 'high', 'classifyRisk: TRUNCATE → high')
}

// 57. classifyRisk: NORMAL 패턴
{
  assert(classifyRisk('file_read /tmp/safe.txt') === 'normal', 'classifyRisk: file_read → normal')
  assert(classifyRisk('list_dir /home') === 'normal', 'classifyRisk: list_dir → normal')
  // 패턴 경계 확인: 단순 curl 은 normal
  assert(classifyRisk('curl https://example.com/api') === 'normal', 'classifyRisk: curl 단독 → normal')
  // chmod 부분 매칭 회귀 방지: 644, 755 등 안전 모드는 normal
  assert(classifyRisk('chmod 644 file') === 'normal', 'classifyRisk: chmod 644 → normal')
  assert(classifyRisk('chmod 755 script.sh') === 'normal', 'classifyRisk: chmod 755 → normal')
  assert(classifyRisk('') === 'normal', 'classifyRisk: 빈 문자열 → normal')
  assert(classifyRisk(null) === 'normal', 'classifyRisk: null → normal')
  assert(classifyRisk(undefined) === 'normal', 'classifyRisk: undefined → normal')
}

// 58. ApprovePrompt 렌더링: 일반 위험
{
  const output = renderToString(
    React.createElement(ApprovePrompt, { description: 'file_read /tmp/safe.txt', onResolve: () => {} })
  )
  assert(output.includes('승인 요청'), 'ApprovePrompt normal: 승인 요청 레이블')
  assert(output.includes('file_read'), 'ApprovePrompt normal: description 표시')
  assert(!output.includes('위험'), 'ApprovePrompt normal: "위험" 단어 없음')
}

// 59. ApprovePrompt 렌더링: HIGH 위험
{
  const output = renderToString(
    React.createElement(ApprovePrompt, { description: 'shell_exec rm -rf /Users/x', onResolve: () => {} })
  )
  assert(output.includes('위험'), 'ApprovePrompt high: "위험" 강조')
  assert(output.includes('rm -rf'), 'ApprovePrompt high: description 표시')
}

await initI18n('ko')

// --- FP-29: InputBar disabled hint ---

// 62a. InputBar disabled with hint renders hint label
{
  const frame = (await (async () => {
    const r = inkRender(React.createElement(InputBar, { disabled: true, hint: '응답 대기 중 · ESC로 취소' }))
    await new Promise(res => setTimeout(res, 20))
    const f = r.lastFrame()
    r.unmount()
    return f
  })())
  assert(frame.includes('응답 대기 중'), 'InputBar disabled: shows hint text')
  assert(frame.includes('ESC'), 'InputBar disabled: shows action hint')
}

// 62b. InputBar disabled without hint renders nothing extra
{
  const r = inkRender(React.createElement(InputBar, { disabled: true }))
  await new Promise(res => setTimeout(res, 20))
  const frame = r.lastFrame()
  r.unmount()
  assert(!frame.includes('['), 'InputBar disabled no hint: no bracketed hint')
}

// --- FP-36: InputBar slash hint ---

// 62c. InputBar slash hint NOT shown initially
{
  const r = inkRender(React.createElement(InputBar, {}))
  await new Promise(res => setTimeout(res, 20))
  const frame = r.lastFrame()
  r.unmount()
  assert(!frame.includes('Tip:'), 'InputBar initial: no slash tip')
}

// 62d. InputBar slash hint shown after typing /
{
  const r = inkRender(React.createElement(InputBar, {}))
  await new Promise(res => setTimeout(res, 20))
  r.stdin.write('/')
  await new Promise(res => setTimeout(res, 30))
  const frame = r.lastFrame()
  r.unmount()
  assert(frame.includes('Tip:'), 'InputBar after /: slash tip shown')
  assert(frame.includes('/help'), 'InputBar after /: /help referenced')
}

// --- FP-22 / FP-01: App disconnected banner + errorHint wiring ---

const baseState = () => createOriginState({
  turnState: TurnState.idle(),
  lastTurn: null,
  turn: 0,
  context: { memories: [], conversationHistory: [] },
  todos: [],
  events: { queue: [], deadLetter: [] },
  delegates: { pending: [] },
  _toolResults: [],
})

const mountApp = async (props) => {
  const rendered = inkRender(React.createElement(App, {
    onInput: () => {}, onApprove: () => {}, onCancel: () => {},
    ...props,
  }))
  await new Promise(r => setTimeout(r, 30))
  const frame = rendered.lastFrame()
  rendered.unmount()
  return frame
}

// 62. App with disconnected prop shows banner (4001 → 세션 만료, FP-24)
{
  const frame = await mountApp({ state: baseState(), disconnected: { code: 4001, at: Date.now() } })
  assert(frame.includes('세션이 만료되었습니다'), 'App disconnected 4001: 세션 만료 표기 (FP-24)')
  assert(frame.includes('4001'), 'App disconnected: close code shown')
  assert(frame.includes('재시작'), 'App disconnected: restart hint shown')
}

// 62-2. 일반 끊김 (그 외 코드) 은 기존 문구
{
  const frame = await mountApp({ state: baseState(), disconnected: { code: 1006, at: Date.now() } })
  assert(frame.includes('서버 연결이 끊겼습니다'), 'App disconnected generic: 서버 연결 끊김')
}

// 62-3. 제거됨 — WS close 4004 (WORKING_DIR_INVALID) 전체 경로 폐기.
//        workingDir 은 서버가 userId 에서 자동 결정 (docs/specs/agent-identity.md I-WD).

// 63. App without disconnected prop does NOT show banner
{
  const frame = await mountApp({ state: baseState() })
  assert(!frame.includes('서버 연결이 끊겼습니다'), 'App normal: no disconnected banner')
}

// 63b. App streaming without content shows thinking but NOT "receiving N chars" (FP-30)
{
  const state = createOriginState({
    turnState: TurnState.working('query'),
    lastTurn: null,
    turn: 0,
    context: { memories: [], conversationHistory: [] },
    todos: [],
    events: { queue: [], deadLetter: [] },
    delegates: { pending: [] },
    _toolResults: [],
    _streaming: { status: 'receiving', content: '', length: 42 },
  })
  state.set('_streaming', { status: 'receiving', content: '', length: 42 })
  const frame = await mountApp({ state })
  assert(!frame.includes('receiving'), 'App streaming: no internal "receiving" wording')
  assert(!frame.includes('chars...'), 'App streaming: no "chars..." wording')
  assert(frame.includes('thinking'), 'App streaming: shows thinking when no content')
}

// 63b-FP15. App streaming with content → StatusBar 는 "응답 중..." (FP-15)
{
  const state = createOriginState({
    turnState: TurnState.working('query'),
    lastTurn: null,
    turn: 0,
    context: { memories: [], conversationHistory: [] },
    todos: [],
    events: { queue: [], deadLetter: [] },
    delegates: { pending: [] },
    _toolResults: [],
    _streaming: { status: 'receiving', content: '오늘 서울은 맑고 ', length: 20 },
  })
  state.set('_streaming', { status: 'receiving', content: '오늘 서울은 맑고 ', length: 20 })
  const frame = await mountApp({ state })
  assert(frame.includes('응답 중'),
    'FP-15: 스트리밍 content 가 도착하면 StatusBar 가 "응답 중" 으로 전환')
  assert(!frame.match(/thinking\.\.\./),
    'FP-15: streaming 중에는 thinking 라벨을 유지하지 않는다')
}

// 63b-FP23. App reconnecting 상태 → StatusBar 에 "연결 중..." 표시 (FP-23)
{
  const state = createOriginState({
    turnState: TurnState.idle(),
    lastTurn: null,
    turn: 0,
    context: { memories: [], conversationHistory: [] },
    todos: [],
    events: { queue: [], deadLetter: [] },
    delegates: { pending: [] },
    _toolResults: [],
  })
  state.set('_reconnecting', true)
  const frame = await mountApp({ state })
  assert(frame.includes('연결 중'),
    'FP-23: reconnecting=true → StatusBar 에 "연결 중..." indicator')
  assert(!frame.includes('● idle'),
    'FP-23: reconnecting 시 idle 인디케이터는 가려진다')
}

// 63b-FP23b. disconnected 배너가 이미 떠 있으면 reconnecting indicator 는 보이지 않는다
{
  const state = createOriginState({
    turnState: TurnState.idle(),
    lastTurn: null,
    turn: 0,
    context: { memories: [], conversationHistory: [] },
    todos: [],
    events: { queue: [], deadLetter: [] },
    delegates: { pending: [] },
    _toolResults: [],
  })
  state.set('_reconnecting', true)
  const frame = await mountApp({ state, disconnected: { code: 4001, at: Date.now() } })
  assert(!frame.includes('연결 중'),
    'FP-23: disconnected 배너가 있으면 reconnecting indicator 가 중복되지 않는다')
}

// --- FP-58: re-render 측정 테스트 ---
// working 상태에서 spinner tick 이 돌 때 전체 App 프레임이 몇 번 다시 쓰이는지 측정한다.
// 가설: StatusBar 의 setFrame(100ms) + setElapsed(1s) 가 React re-render 를 유발하고
// 그 결과 ink-testing-library 의 stdout.frames 배열이 꾸준히 증가한다.
// 측정 결과에 따라 어느 최적화가 효과가 있었는지 실제 숫자로 확인할 수 있다.

{
  const state = createOriginState({
    turnState: TurnState.working('query'),
    lastTurn: null,
    turn: 0,
    context: { memories: [], conversationHistory: [] },
    todos: [],
    events: { queue: [], deadLetter: [] },
    delegates: { pending: [] },
    _toolResults: [],
  })
  // 의도적으로 ChatArea 에 5 개 메시지를 채워 frame 을 크게 만든다.
  const messages = [
    { role: 'user', content: 'hello 1' },
    { role: 'agent', content: 'response 1' },
    { role: 'user', content: 'hello 2' },
    { role: 'agent', content: 'response 2' },
    { role: 'user', content: 'hello 3' },
  ]
  const r = inkRender(React.createElement(App, {
    state, onInput: () => {}, onApprove: () => {}, onCancel: () => {},
    initialMessages: messages,
  }))
  // mount 직후 초기 frame 이 여러 개 올 수 있어 안정화 대기.
  await new Promise(res => setTimeout(res, 150))
  const framesBefore = r.stdout.frames.length
  // 1 초 동안 spinner tick 을 돌린다. 100ms × 10 = 10 ticks
  await new Promise(res => setTimeout(res, 1000))
  const framesAfter = r.stdout.frames.length
  const delta = framesAfter - framesBefore
  r.unmount()

  // 측정 결과를 로그로 남긴다 (정확한 수치는 가설 검증 후 upper bound 로 고정).
  console.log(`  [measure] spinner 1s 동안 frame writes: ${delta}`)
  // spinner 가 100ms 주기면 최대 11 회 (10 ticks + 여유 1). 이를 넘으면 과도한 re-render.
  assert(delta <= 15, `FP-58: spinner 1s 동안 frame writes ≤ 15 (got ${delta})`)
  // 또한 마지막 frame 이 ChatArea 메시지를 계속 포함해야 한다 (sanity).
  const last = r.stdout.frames[r.stdout.frames.length - 1] || ''
  // 실제 frame 크기를 로그로 남긴다 — Ink 가 매 tick 마다 전체 frame 을 써내는지 확인.
  const lineCount = last.split('\n').length
  console.log(`  [measure] 마지막 frame lines: ${lineCount}, bytes: ${last.length}`)
  assert(last.length > 100, 'FP-58 sanity: 마지막 frame 이 비어있지 않음')

  // 모든 frame 의 평균 크기. 각 write 가 전체 frame 을 재기록한다면 frame[i].length 가 모두 비슷하다.
  const sizes = r.stdout.frames.map(f => f.length)
  const avgSize = Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)
  const maxSize = Math.max(...sizes)
  console.log(`  [measure] frame avg: ${avgSize} bytes, max: ${maxSize} bytes, total writes: ${sizes.length}`)

  // 진짜 중요한 질문: unique frame 은 몇 개인가? Ink 는 동일 frame 은 skip 하므로
  // delta = 10 이라는 것은 10 번의 실제 string 변화가 있었다는 뜻이다.
  const uniqueFrames = new Set(r.stdout.frames).size
  console.log(`  [measure] unique frames: ${uniqueFrames} (총 ${sizes.length} writes)`)
}

// --- FP-58: 스트리밍 중 frame write 측정 ---
// LLM chunk 가 도착하지 않아도 working 상태 그 자체로 write 가 발생하는지 확인.
// 사용자 증언: 채팅 입력 후 응답 대기 중에 깜빡임. 스트리밍 시작 전 구간이다.
{
  const state = createOriginState({
    turnState: TurnState.working('query'),
    lastTurn: null,
    turn: 1,
    context: { memories: [], conversationHistory: [{ input: 'q1', output: 'r1' }] },
    todos: [],
    events: { queue: [], deadLetter: [] },
    delegates: { pending: [] },
    _toolResults: [],
  })
  const r = inkRender(React.createElement(App, {
    state, onInput: () => {}, onApprove: () => {}, onCancel: () => {},
  }))
  await new Promise(res => setTimeout(res, 200))
  const framesBefore = r.stdout.frames.length
  // 2 초간 아무 것도 하지 않고 대기 (실제 사용자의 "응답 대기 중" 시뮬레이션)
  await new Promise(res => setTimeout(res, 2000))
  const framesAfter = r.stdout.frames.length
  const delta = framesAfter - framesBefore
  r.unmount()
  console.log(`  [measure] working 2s idle 대기 중 frame writes: ${delta}`)
  assert(delta <= 2, `FP-58 working-idle: frame writes ≤ 2 (got ${delta})`)
}

// --- FP-58: 스트리밍 chunk throttle 검증 ---
// 실환경 계측에서 streaming 이 60ms 주기로 도착 (16 Hz). useAgentState 의
// 200ms trailing throttle 로 5 Hz 이하로 제한되어야 한다.
{
  const state = createOriginState({
    turnState: TurnState.working('query'),
    lastTurn: null,
    turn: 1,
    context: { memories: [], conversationHistory: [] },
    todos: [],
    events: { queue: [], deadLetter: [] },
    delegates: { pending: [] },
    _toolResults: [],
  })
  const r = inkRender(React.createElement(App, {
    state, onInput: () => {}, onApprove: () => {}, onCancel: () => {},
  }))
  await new Promise(res => setTimeout(res, 100))
  const framesBefore = r.stdout.frames.length
  // 실환경 재현: 1 초 동안 60ms 간격으로 chunk 16개 push
  for (let i = 1; i <= 16; i++) {
    state.set('_streaming', { status: 'receiving', content: 'abcdefghij'.repeat(i), length: i * 10 })
    await new Promise(res => setTimeout(res, 60))
  }
  // throttle trailing flush 대기
  await new Promise(res => setTimeout(res, 250))
  const framesAfter = r.stdout.frames.length
  const delta = framesAfter - framesBefore
  r.unmount()
  console.log(`  [measure] streaming 16 chunks/1s frame writes: ${delta}`)
  // throttle 없음 = 16, 200ms throttle = 약 5-6. 안전 상한으로 8 이하 요구.
  assert(delta <= 8, `FP-58 streaming throttle: frame writes ≤ 8 (got ${delta})`)
  // 그리고 완전히 0 이면 trailing flush 가 작동 안 한 것
  assert(delta >= 2, `FP-58 streaming throttle: trailing flush 작동 (got ${delta})`)
}

// --- FP-58: idle 상태에서는 거의 re-render 가 없어야 한다 ---
{
  const state = createOriginState({
    turnState: TurnState.idle(),
    lastTurn: null, turn: 0,
    context: { memories: [], conversationHistory: [] },
    todos: [], events: { queue: [], deadLetter: [] },
    delegates: { pending: [] }, _toolResults: [],
  })
  const r = inkRender(React.createElement(App, {
    state, onInput: () => {}, onApprove: () => {}, onCancel: () => {},
  }))
  await new Promise(res => setTimeout(res, 150))
  const framesBefore = r.stdout.frames.length
  await new Promise(res => setTimeout(res, 1000))
  const framesAfter = r.stdout.frames.length
  const delta = framesAfter - framesBefore
  r.unmount()
  console.log(`  [measure] idle 1s 동안 frame writes: ${delta}`)
  // idle 은 타이머 없음 → 0 또는 1 (초기 안정화 여유) 이어야 함
  assert(delta <= 2, `FP-58 idle: frame writes ≤ 2 (got ${delta})`)
}

// 63b-FP15/23 StatusBar 단위 렌더 —
// - activity override(retry 등) 는 thinking/streaming 기본 라벨보다 우선
// - reconnecting 은 status 보다 우선
{
  // FP-15: activity 에 'retry 1/3...' override 가 있으면 그대로 노출
  const out1 = renderToString(
    React.createElement(StatusBar, {
      status: 'working', activity: 'retry 1/3...',
    })
  )
  assert(out1.includes('retry 1/3'),
    'StatusBar FP-15: activity override(retry) 가 기본 라벨을 대체')
  assert(!out1.includes('응답 중'),
    'StatusBar FP-15: retry override 시 streaming 라벨 미표시')

  // FP-15: activity=null 이면 기본 thinking
  const out2 = renderToString(
    React.createElement(StatusBar, { status: 'working', activity: null })
  )
  assert(out2.includes('thinking'),
    'StatusBar FP-15: activity=null → 기본 thinking 라벨')

  // FP-15: activity='응답 중...' 이면 그대로 노출 (App 이 streaming 으로부터 파생)
  const out3 = renderToString(
    React.createElement(StatusBar, { status: 'working', activity: '응답 중...' })
  )
  assert(out3.includes('응답 중'),
    'StatusBar FP-15: App 이 파생해 넘긴 streaming 라벨 표시')
  assert(!out3.includes('thinking'),
    'StatusBar FP-15: streaming 라벨 제시 시 thinking 노출 안 함')

  // FP-23: reconnecting=true 는 working/idle 상관없이 "연결 중..." 노출
  const out4 = renderToString(
    React.createElement(StatusBar, { status: 'working', reconnecting: true })
  )
  assert(out4.includes('연결 중'),
    'StatusBar FP-23: reconnecting=true → 연결 중 indicator')
  assert(!out4.includes('thinking'),
    'StatusBar FP-23: reconnecting 시 working 라벨 가려짐')

  const out5 = renderToString(
    React.createElement(StatusBar, { status: 'idle', reconnecting: true })
  )
  assert(out5.includes('연결 중'),
    'StatusBar FP-23: idle 중에도 reconnecting 라벨 우선')
  assert(!out5.includes('● idle'),
    'StatusBar FP-23: reconnecting 시 idle dot 가려짐')
}

// --- FP-04 / FP-09 / FP-25 / FP-26: 키바인딩 힌트 라인 ---

// 63c. idle 상태에서 키 힌트 라인 노출
{
  const frame = await mountApp({ state: baseState() })
  assert(frame.includes('/help'), 'App idle: /help 힌트 표시')
  assert(frame.includes('Ctrl+T'), 'App idle: Ctrl+T 힌트 표시')
  assert(frame.includes('Ctrl+O'), 'App idle: Ctrl+O 힌트 표시')
}

// 63d. working 상태에서는 키 힌트 라인 숨김 (InputBar 가 대신 표시)
{
  const state = createOriginState({
    turnState: TurnState.working('q'),
    lastTurn: null,
    turn: 0,
    context: { memories: [], conversationHistory: [] },
    todos: [],
    events: { queue: [], deadLetter: [] },
    delegates: { pending: [] },
    _toolResults: [],
  })
  const frame = await mountApp({ state })
  assert(!frame.includes('Ctrl+T 전사'), 'App working: 키 힌트 라인 숨김 (중복 방지)')
}

// 63e. disconnected 상태에서도 키 힌트 라인 숨김
{
  const frame = await mountApp({ state: baseState(), disconnected: { code: 4001, at: Date.now() } })
  assert(!frame.includes('Ctrl+T 전사'), 'App disconnected: 키 힌트 라인 숨김')
}

// 64. App with failure lastTurn shows errorHint in StatusBar (FP-01)
{
  const state = createOriginState({
    turnState: TurnState.idle(),
    lastTurn: TurnOutcome.failure('q', TurnError('boom', ERROR_KIND.INTERPRETER), null),
    turn: 1,
    context: { memories: [], conversationHistory: [] },
    todos: [],
    events: { queue: [], deadLetter: [] },
    delegates: { pending: [] },
    _toolResults: [],
  })
  const frame = await mountApp({ state })
  assert(frame.includes('error: interpreter'), 'App error: errorHint wired from lastTurn to StatusBar')
}

// --- FP-16: checkServer preserves connection error reason ---

// 60. checkServer returns ECONNREFUSED for closed port
{
  const result = await checkServer('http://127.0.0.1:1')
  assert(result.reachable === false, 'checkServer: reachable=false on closed port')
  assert(result.reason != null, 'checkServer: reason present on failure')
  assert(result.reason.code === 'ECONNREFUSED', `checkServer: code=ECONNREFUSED (got ${result.reason.code})`)
  assert(typeof result.reason.message === 'string' && result.reason.message.length > 0, 'checkServer: reason.message non-empty')
}

// 61. checkServer returns ETIMEDOUT or UNKNOWN for unreachable host
{
  const result = await checkServer('http://192.0.2.1:3000')
  assert(result.reachable === false, 'checkServer: reachable=false on unreachable host')
  assert(result.reason != null, 'checkServer: reason present')
  assert(['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UNKNOWN'].includes(result.reason.code),
    `checkServer: timeout-related code (got ${result.reason.code})`)
}

// --- FP-05: PlanView formatStepLabel 한글 번역 ---

// 67a. EXEC op 한글 라벨
{
  const label = formatStepLabel({ op: 'EXEC', args: { tool: 'file_read', tool_args: { path: '/tmp/x.txt' } } })
  assert(label.includes('도구 실행'), 'formatStepLabel EXEC: 한글 동사')
  assert(label.includes('file_read'), 'formatStepLabel EXEC: tool 이름')
  assert(label.includes('/tmp/x.txt'), 'formatStepLabel EXEC: args preview')
}

// 67b. ASK_LLM
{
  const label = formatStepLabel({ op: 'ASK_LLM', args: { prompt: '오늘 일정 알려줘' } })
  assert(label.includes('AI 분석'), 'formatStepLabel ASK_LLM: 한글 라벨')
  assert(label.includes('오늘 일정'), 'formatStepLabel ASK_LLM: prompt preview')
}

// 67c. RESPOND
{
  assert(formatStepLabel({ op: 'RESPOND', args: { message: 'ok' } }) === '응답 생성', 'formatStepLabel RESPOND: 한글')
  assert(formatStepLabel({ op: 'RESPOND', args: { ref: 2 } }).includes('단계 2'), 'formatStepLabel RESPOND ref: 한글')
}

// 67d. APPROVE / DELEGATE / LOOKUP_MEMORY
{
  assert(formatStepLabel({ op: 'APPROVE', args: { description: 'rm -rf' } }).includes('승인 요청'), 'formatStepLabel APPROVE: 한글')
  assert(formatStepLabel({ op: 'DELEGATE', args: { target: 'backend' } }).includes('하위 에이전트 위임'), 'formatStepLabel DELEGATE: 한글')
  assert(formatStepLabel({ op: 'LOOKUP_MEMORY', args: { query: '지난 주' } }).includes('기억 검색'), 'formatStepLabel LOOKUP_MEMORY: 한글')
}

// 67e. 영어 op 코드 흔적 없음
{
  const labels = [
    formatStepLabel({ op: 'EXEC', args: { tool: 'x', tool_args: {} } }),
    formatStepLabel({ op: 'ASK_LLM', args: { prompt: 'y' } }),
    formatStepLabel({ op: 'RESPOND', args: {} }),
    formatStepLabel({ op: 'APPROVE', args: { description: 'z' } }),
    formatStepLabel({ op: 'DELEGATE', args: { target: 'a' } }),
    formatStepLabel({ op: 'LOOKUP_MEMORY', args: { query: 'b' } }),
  ]
  for (const label of labels) {
    assert(!/\b(EXEC|ASK_LLM|RESPOND|APPROVE|DELEGATE|LOOKUP_MEMORY)\b/.test(label),
      `formatStepLabel: 영어 op 코드 제거 (got: ${label})`)
  }
}

// --- FP-06: SidePanel Events deadLetter 노출 ---

// 68a. deadLetter 있으면 빨간색 + 실패 카운트 표시
{
  const output = renderToString(
    React.createElement(SidePanel, {
      agents: [], tools: [], todos: [], memoryCount: 0,
      events: { queue: [1, 2], deadLetter: [{}, {}, {}] },
    })
  )
  assert(output.includes('대기: 2'), 'SidePanel events: 대기 카운트')
  assert(output.includes('실패: 3'), 'SidePanel events: deadLetter 카운트 (FP-06)')
}

// 68b. deadLetter 비면 기존 동작 유지
{
  const output = renderToString(
    React.createElement(SidePanel, {
      agents: [], tools: [], todos: [], memoryCount: 0,
      events: { queue: [1], deadLetter: [] },
    })
  )
  assert(output.includes('대기: 1'), 'SidePanel events: 대기 카운트')
  assert(!output.includes('실패'), 'SidePanel events: deadLetter 0 일 때 실패 표시 없음')
}

// 68c. queue + deadLetter 둘 다 비면 empty 메시지
{
  const output = renderToString(
    React.createElement(SidePanel, {
      agents: [], tools: [], todos: [], memoryCount: 0,
      events: { queue: [], deadLetter: [] },
    })
  )
  assert(output.includes('비어있음'), 'SidePanel events: 비어있음 메시지')
}

// --- FP-07: TODO status 아이콘 ---

// 69a. todoStatusIcon 매핑
{
  assert(todoStatusIcon('ready') === '○', 'todoStatusIcon: ready → ○')
  assert(todoStatusIcon('done') === '✓', 'todoStatusIcon: done → ✓')
  assert(todoStatusIcon('blocked') === '⊘', 'todoStatusIcon: blocked → ⊘')
  assert(todoStatusIcon(undefined) === '·', 'todoStatusIcon: undefined → ·')
  assert(todoStatusIcon('weird') === '·', 'todoStatusIcon: 알 수 없는 값 → ·')
}

// 69b. SidePanel todos 가 상태 아이콘 렌더
{
  const output = renderToString(
    React.createElement(SidePanel, {
      agents: [], tools: [],
      todos: [
        { title: '보고서 작성', status: 'ready' },
        { title: '이메일 확인', status: 'done' },
      ],
      memoryCount: 0,
    })
  )
  assert(output.includes('○ 보고서 작성'), 'SidePanel todos: ready 아이콘 + 제목')
  assert(output.includes('✓ 이메일 확인'), 'SidePanel todos: done 아이콘 + 제목')
}

// --- FP-12 / FP-40: /statusline 한글화 + 현재 구성 표시 ---

// 65a. /statusline 이 한국어 레이블 + 모든 내부 키 설명
{
  const msgs = []
  handleStatusline('/statusline', {
    statusItems: ['status', 'session', 'budget'],
    setStatusItems: () => {},
    addMessage: (m) => msgs.push(m),
  })
  const out = msgs[0].content
  assert(out.includes('현재 표시'), 'statusline: 한국어 헤더')
  assert(out.includes('status — 상태'), 'statusline: status 설명')
  assert(out.includes('session — 세션 이름'), 'statusline: session 설명')
  assert(out.includes('mem — 메모리 노드 수'), 'statusline: mem 설명 (비활성 목록)')
  assert(!out.includes('statusline items:'), 'statusline: 영어 헤더 제거')
}

// 65b. /statusline +turn 이 변경 후 전체 구성 출력 (FP-40)
{
  const msgs = []
  let items = ['status', 'session']
  handleStatusline('/statusline +turn', {
    statusItems: items,
    setStatusItems: (next) => { items = typeof next === 'function' ? next(items) : next },
    addMessage: (m) => msgs.push(m),
  })
  const out = msgs[0].content
  assert(out.startsWith('+turn'), 'statusline +turn: 변경 액션 표시')
  assert(out.includes('turn — 턴 번호'), 'statusline +turn: 추가된 항목이 현재 표시에 포함')
  assert(out.includes('현재 표시'), 'statusline +turn: 전체 구성 함께 출력')
}

// 65c. /statusline -session 이 변경 후 전체 구성 출력
{
  const msgs = []
  handleStatusline('/statusline -session', {
    statusItems: ['status', 'session', 'budget'],
    setStatusItems: () => {},
    addMessage: (m) => msgs.push(m),
  })
  const out = msgs[0].content
  assert(out.startsWith('-session'), 'statusline -session: 변경 액션 표시')
  assert(out.includes('session — 세션 이름'), 'statusline -session: 제거 후 비활성 목록에 표시')
}

// --- FP-38 / FP-39: /memory help 정확성 + clear 피드백 한글화 ---

// 66a. /memory help 에 사라진 tier 필터 언급 없음
await (async () => {
  const msgs = []
  const memory = { allNodes: async () => [] }
  await handleMemory('/memory help', { memory, addMessage: (m) => msgs.push(m) })
  const out = msgs[0].content
  assert(!out.includes('tier'), 'memory help: tier 단어 제거 (FP-38)')
  assert(!out.includes('episodic'), 'memory help: episodic 단어 제거')
  assert(!out.includes('semantic'), 'memory help: semantic 단어 제거')
})()

// 66b. /memory clear 7d 피드백이 한국어
await (async () => {
  const msgs = []
  const memory = { allNodes: async () => [{}], removeOlderThan: async () => 5 }
  await handleMemory('/memory clear 7d', { memory, addMessage: (m) => msgs.push(m) })
  const out = msgs[msgs.length - 1].content
  assert(out.includes('5개 노드 삭제'), 'memory clear: count 표시')
  assert(out.includes('7d'), 'memory clear: age 파라미터 포함')
  assert(out.includes('이상 경과'), 'memory clear: 한국어 설명 (FP-39)')
  assert(!out.toLowerCase().includes('older than'), 'memory clear: 영어 older than 제거')
})()

// 66c. /memory clear (age 없음) 피드백
await (async () => {
  const msgs = []
  const memory = { allNodes: async () => [{}], clearAll: async () => 3 }
  await handleMemory('/memory clear', { memory, addMessage: (m) => msgs.push(m) })
  const out = msgs[msgs.length - 1].content
  assert(out.includes('3개 노드 삭제'), 'memory clear all: count 표시')
  assert(!out.includes('이상 경과'), 'memory clear all: age 설명 없음')
})()

// --- FP-42: 알 수 없는 슬래시 커맨드 차단 ---

// 80a. 알 수 없는 /xxx 는 시스템 메시지 + handled=true
await (async () => {
  const msgs = []
  const ctx = { addMessage: (m) => msgs.push(m) }
  const handled = await dispatchSlashCommand('/mem', ctx)
  assert(handled === true, 'dispatch: /mem 은 흡수됨 (agent 로 전달 금지)')
  assert(msgs.length === 1, 'dispatch: 시스템 메시지 1개')
  assert(msgs[0].content.includes('알 수 없는 커맨드'), 'dispatch: 한글 안내')
  assert(msgs[0].content.includes('/mem'), 'dispatch: 커맨드 이름 포함')
  assert(msgs[0].content.includes('/help'), 'dispatch: /help 안내')
  assert(msgs[0].tag === 'error', 'dispatch: error 태그')
})()

// 80b. 정상 슬래시 커맨드는 평소대로 dispatch
await (async () => {
  const msgs = []
  const ctx = {
    addMessage: (m) => msgs.push(m),
    statusItems: ['status', 'session'],
    setStatusItems: () => {},
  }
  const handled = await dispatchSlashCommand('/statusline', ctx)
  assert(handled === true, 'dispatch: /statusline 은 정상 처리')
  assert(msgs.length > 0, 'dispatch: /statusline 메시지 출력')
  assert(!msgs[0].content.includes('알 수 없는'), 'dispatch: 정상 경로에서 "알 수 없는" 없음')
})()

// 80c. 슬래시로 시작하지 않는 입력은 handled=false (에이전트로 전달)
await (async () => {
  const msgs = []
  const ctx = { addMessage: (m) => msgs.push(m) }
  const handled = await dispatchSlashCommand('안녕하세요', ctx)
  assert(handled === false, 'dispatch: 일반 입력은 false 반환')
  assert(msgs.length === 0, 'dispatch: 일반 입력은 메시지 생성 안 함')
})()

// --- FP-43: /help 에 /mcp 포함 ---

// 81. /help 출력에 /mcp 행 포함
{
  // t() 는 initI18n 상단 초기화로 이미 로드
  const { t } = await import('@presence/infra/i18n')
  const help = t('help.commands')
  assert(help.includes('/mcp'), 'help: /mcp 커맨드 포함 (FP-43)')
  assert(help.includes('/mcp list'), 'help: /mcp list 예시')
}

// --- FP-71: /persona 슬래시 커맨드 + /help 노출 ---

// 81b. /help 출력에 /persona 행 포함
{
  const { t } = await import('@presence/infra/i18n')
  const help = t('help.commands')
  assert(help.includes('/persona'), 'help: /persona 커맨드 포함 (FP-71)')
  assert(help.includes('/persona set'), 'help: /persona set 예시')
}

// 81c. /persona 디스패치는 onInput 으로 서버 위임 + 응답을 system 메시지로 노출
await (async () => {
  const msgs = []
  let captured = null
  const ctx = {
    addMessage: (m) => msgs.push(m),
    onInput: async (input) => { captured = input; return 'Persona: Presence\n(unset)' },
  }
  const handled = await dispatchSlashCommand('/persona show', ctx)
  assert(handled === true, '/persona dispatch: handled=true')
  assert(captured === '/persona show', '/persona dispatch: input 그대로 서버로 전달')
  // onInput 은 비동기 — Promise resolve 후 메시지 추가됨. await 가 필요.
  await new Promise(resolve => setImmediate(resolve))
  assert(msgs.length === 1, `/persona dispatch: 시스템 메시지 1개 (got ${msgs.length})`)
  assert(msgs[0].content.includes('unset'), `/persona dispatch: 서버 응답 표시 (got: ${msgs[0].content})`)
})()

// --- FP-44: /session list 에 name 표시 ---

// 82a. name 이 id 와 다르면 함께 표시
await (async () => {
  const msgs = []
  handleSessions('/session list', {
    sessionId: 'anthony-default',
    onListSessions: async () => [
      { id: 'anthony-default', name: 'anthony-default', type: 'user' },
      { id: 'work-session', name: '업무 세션', type: 'user' },
    ],
    addMessage: (m) => msgs.push(m),
  })
  await new Promise(r => setTimeout(r, 20))
  const out = msgs[0].content
  assert(out.includes('work-session'), 'sessions list: id 표시')
  assert(out.includes('업무 세션'), 'sessions list: name 표시 (FP-44)')
  // 같은 값이면 중복 억제
  assert((out.match(/anthony-default/g) || []).length === 1, 'sessions list: name==id 일 때 중복 억제')
})()

// 82b. 목록 헤더 한글화
await (async () => {
  const msgs = []
  handleSessions('/session', {
    sessionId: 'x',
    onListSessions: async () => [],
    addMessage: (m) => msgs.push(m),
  })
  await new Promise(r => setTimeout(r, 20))
  assert(msgs[0].content.includes('세션 목록'), 'sessions list: 한글 헤더')
}
)()

// --- FP-41: /session 오류 한글화 ---

// 83. /session list 실패 시 "오류:" 한글
await (async () => {
  const msgs = []
  handleSessions('/session list', {
    sessionId: 'x',
    onListSessions: async () => { throw new Error('network down') },
    addMessage: (m) => msgs.push(m),
  })
  await new Promise(r => setTimeout(r, 30))
  const out = msgs[0].content
  assert(out.includes('오류'), 'sessions 에러: "오류" 한글 (FP-41)')
  assert(out.includes('network down'), 'sessions 에러: 원본 message 포함')
  assert(!out.startsWith('Error:'), 'sessions 에러: 영어 Error: 제거')
})()

// --- FP-17: resolveServerUrl with source detection ---

// 70. --server <url> → source 'arg'
{
  const r = resolveServerUrl(['node', 'main.js', '--server', 'http://example.com:9999'], {})
  assert(r.url === 'http://example.com:9999', 'resolveServerUrl: --server url')
  assert(r.source === 'arg', 'resolveServerUrl: source=arg')
}

// 71. --server=url → source 'arg'
{
  const r = resolveServerUrl(['node', 'main.js', '--server=http://example.com:9999'], {})
  assert(r.url === 'http://example.com:9999', 'resolveServerUrl: --server=url')
  assert(r.source === 'arg', 'resolveServerUrl: source=arg (equal form)')
}

// 72. PRESENCE_SERVER env → source 'env'
{
  const r = resolveServerUrl(['node', 'main.js'], { PRESENCE_SERVER: 'http://env.local:1234' })
  assert(r.url === 'http://env.local:1234', 'resolveServerUrl: env url')
  assert(r.source === 'env', 'resolveServerUrl: source=env')
}

// 73. default → source 'default'
{
  const r = resolveServerUrl(['node', 'main.js'], {})
  assert(r.url === 'http://127.0.0.1:3000', 'resolveServerUrl: default url')
  assert(r.source === 'default', 'resolveServerUrl: source=default')
}

// 74. arg 우선순위 > env
{
  const r = resolveServerUrl(['node', 'main.js', '--server', 'http://arg.local'], { PRESENCE_SERVER: 'http://env.local' })
  assert(r.url === 'http://arg.local', 'resolveServerUrl: arg beats env')
}

// 75. source label 매핑
{
  assert(SERVER_URL_SOURCE_LABEL.arg === '--server', 'source label arg')
  assert(SERVER_URL_SOURCE_LABEL.env === 'PRESENCE_SERVER', 'source label env')
  assert(SERVER_URL_SOURCE_LABEL.default === '기본값', 'source label default')
}

// --- FP-19/20: remainingLabel — i18n auth.* 키 사용 (i18n 이관 후) ---

// 76. 첫 시도 (attempt 0/3) → '2번 남음' (auth.attempts_remaining)
{
  assert(remainingLabel(0, 3) === '2번 남음', 'remainingLabel: attempt 0 → 2번 남음')
}

// 77. 두 번째 시도 (attempt 1/3) → '마지막 시도' (auth.last_attempt)
{
  assert(remainingLabel(1, 3) === '마지막 시도', 'remainingLabel: attempt 1 → 마지막 시도')
}

// 78. 마지막 시도 (attempt 2/3) → null (표기 없음)
{
  assert(remainingLabel(2, 3) === null, 'remainingLabel: attempt 2 → null')
}

// ==========================================================================
// parseInline — FP-32 인라인 마크다운 확장
// ==========================================================================

// parseInline: bold/italic/code/link

{
  // bold
  const bold = parseInline('hello **world** end')
  assert(bold.length === 3, 'PI1: bold 3 parts')
  assert(bold[1].bold === true, 'PI1: bold flag')
  assert(bold[1].text === 'world', 'PI1: bold text')
}

{
  // italic with *
  const italic = parseInline('hello *world* end')
  assert(italic.length === 3, 'PI2: italic 3 parts')
  assert(italic[1].dimColor === true, 'PI2: dimColor flag')
  assert(italic[1].text === 'world', 'PI2: italic text')
}

{
  // italic with _ (word boundary)
  const italic = parseInline('hello _world_ end')
  assert(italic.length === 3, 'PI3: underscore italic 3 parts')
  assert(italic[1].dimColor === true, 'PI3: dimColor flag')
  assert(italic[1].text === 'world', 'PI3: italic text')
}

{
  // intraword underscore — no italic
  const intra = parseInline('a_b_c')
  assert(intra.length === 1, 'PI4: intraword no split')
  assert(intra[0].text === 'a_b_c', 'PI4: raw text preserved')
}

{
  // inline code
  const code = parseInline('use `npm test` here')
  assert(code.length === 3, 'PI5: code 3 parts')
  assert(code[1].color === 'cyan', 'PI5: code cyan')
}

{
  // link
  const link = parseInline('see [docs](https://example.com) here')
  assert(link.length === 3, 'PI6: link 3 parts')
  assert(link[1].text === 'docs', 'PI6: link text only')
  assert(link[1].color === 'blue', 'PI6: link blue')
}

{
  // link with nested parentheses
  const link = parseInline('[x](https://a.com/foo(bar))')
  const linkPart = link.find(part => part.color === 'blue')
  assert(linkPart && linkPart.text === 'x', 'PI7: nested parens link text extracted')
}

{
  // mixed bold and italic — no crash
  const mixed = parseInline('**bold** and *italic* and `code`')
  assert(mixed.length === 5, 'PI8: mixed 5 parts')
  assert(mixed[0].bold === true, 'PI8: bold first')
  assert(mixed[2].dimColor === true, 'PI8: italic second')
  assert(mixed[4].color === 'cyan', 'PI8: code third')
}

summary()
