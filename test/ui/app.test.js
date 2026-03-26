import React from 'react'
import { renderToString, Box, Text } from 'ink'
import { StatusBar } from '../../src/ui/components/StatusBar.js'
import { ChatArea } from '../../src/ui/components/ChatArea.js'
import { SidePanel } from '../../src/ui/components/SidePanel.js'
import { TranscriptOverlay, buildLines } from '../../src/ui/components/TranscriptOverlay.js'
import { ToolResultView, parseFileEntries, toGrid, truncateLines, getSummary } from '../../src/ui/components/ToolResultView.js'
import { CodeView, detectLang, highlightJS, highlightJSON } from '../../src/ui/components/CodeView.js'
import { detectWholeCodeLang } from '../../src/ui/components/MarkdownText.js'
import { deriveStatus, deriveMemoryCount } from '../../src/ui/hooks/useAgentState.js'
import { createReactiveState } from '../../src/infra/state.js'
import { Phase, TurnResult, ErrorInfo, ERROR_KIND } from '../../src/core/agent.js'
import { assert, summary } from '../lib/assert.js'

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
    { name: 'backend' },
    { name: 'heartbeat' },
  ]
  const output = renderToString(
    React.createElement(SidePanel, { agents, tools: [], todos: [], memoryCount: 5 })
  )
  assert(output.includes('backend'), 'SidePanel: shows agent name')
  assert(output.includes('heartbeat'), 'SidePanel: shows second agent')
  assert(output.includes('Agents'), 'SidePanel: shows Agents header')
  assert(output.includes('5'), 'SidePanel: shows memory count')
}

// 16. SidePanel empty agents
{
  const output = renderToString(
    React.createElement(SidePanel, { agents: [], tools: [], todos: [] })
  )
  assert(output.includes('none'), 'SidePanel: shows (none) when empty')
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
  assert(texts.includes('ops_total') || texts.includes('5 ops'), 'buildLines opTrace: shows op count')
  assert(texts.includes('Ask LLM'), 'buildLines opTrace: shows AskLLM tag')
  assert(texts.includes('slow'), 'buildLines opTrace: marks slowest op')
  assert(texts.includes('file not found'), 'buildLines opTrace: shows error')
  assert(texts.includes('Load Context'), 'buildLines opTrace: shows context phase')
  assert(texts.includes('Ask LLM'), 'buildLines opTrace: shows llm phase')
  assert(texts.includes('Send Response'), 'buildLines opTrace: shows respond phase')
  const redLines = lines.filter(l => l.color === 'red')
  assert(redLines.length > 0, 'buildLines opTrace: error line is red')
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

import { buildReport, formatDuration, truncate } from '../../src/ui/report.js'

// 51. formatDuration helper
{
  assert(formatDuration(null) === '?', 'formatDuration: null → ?')
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
    state: createReactiveState({
      turnState: Phase.idle(),
      lastTurn: TurnResult.success('q', 'ok'),
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

summary()
