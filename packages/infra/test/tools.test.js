import { ToolRegistry, ToolRegistryView, TOOL_SOURCE, createToolRegistry } from '@presence/infra/infra/tools/tool-registry.js'
import { assert, summary } from '../../../test/lib/assert.js'

console.log('Tool registry tests')

// =================================================================
// TR1: register + get (enabled) → 도구
// =================================================================
{
  const registry = createToolRegistry()
  registry.register({ name: 'file_read', description: 'Read file', handler: () => 'ok' })
  const tool = registry.get('file_read')
  assert(tool !== null, 'TR1: get returns registered tool')
  assert(tool.name === 'file_read', 'TR1: correct name')
  assert(tool.enabled === true, 'TR1: default enabled')
  assert(tool.source === TOOL_SOURCE.LOCAL, 'TR1: default source is local')
  assert(tool.promptVisible === true, 'TR1: default promptVisible')
}

// =================================================================
// TR2: disable → get=null, find=도구(enabled=false)
// =================================================================
{
  const registry = createToolRegistry()
  registry.register({ name: 'file_read', description: 'Read file', handler: () => 'ok' })
  assert(registry.disable('file_read') === true, 'TR2: disable returns true')
  assert(registry.get('file_read') === null, 'TR2: get returns null when disabled')
  const found = registry.find('file_read')
  assert(found !== null, 'TR2: find returns tool even when disabled')
  assert(found.enabled === false, 'TR2: find shows enabled=false')
  assert(registry.find('nonexistent') === null, 'TR2: find returns null for nonexistent')
}

// =================================================================
// TR2b: disable(name) on MCP tool → false
// =================================================================
{
  const registry = createToolRegistry()
  registry.register({ name: 'mcp0__search', source: TOOL_SOURCE.MCP, group: 'mcp0', handler: () => 'ok' })
  assert(registry.disable('mcp0__search') === false, 'TR2b: disable MCP tool returns false')
  assert(registry.get('mcp0__search') !== null, 'TR2b: MCP tool still enabled')
}

// =================================================================
// TR3: enableGroup/disableGroup 토글
// =================================================================
{
  const registry = createToolRegistry()
  registry.registerGroup({ group: 'mcp0', serverName: 'github' })
  registry.register({ name: 'mcp0__pr', source: TOOL_SOURCE.MCP, group: 'mcp0', promptVisible: false, handler: () => 'ok' })
  registry.register({ name: 'mcp0__issue', source: TOOL_SOURCE.MCP, group: 'mcp0', promptVisible: false, handler: () => 'ok' })

  assert(registry.disableGroup('mcp0') === true, 'TR3: disableGroup returns true')
  assert(registry.get('mcp0__pr') === null, 'TR3: disabled tool1')
  assert(registry.get('mcp0__issue') === null, 'TR3: disabled tool2')
  assert(registry.enableGroup('mcp0') === true, 'TR3: enableGroup returns true')
  assert(registry.get('mcp0__pr') !== null, 'TR3: re-enabled tool1')
  assert(registry.get('mcp0__issue') !== null, 'TR3: re-enabled tool2')
  assert(registry.disableGroup('mcp99') === false, 'TR3: disableGroup unknown returns false')
}

// =================================================================
// TR4: list() → promptVisible + enabled만
// =================================================================
{
  const registry = createToolRegistry()
  registry.register({ name: 'file_read', promptVisible: true, handler: () => 'ok' })
  registry.register({ name: 'mcp0__pr', source: TOOL_SOURCE.MCP, group: 'mcp0', promptVisible: false, handler: () => 'ok' })
  registry.register({ name: 'mcp_search', source: TOOL_SOURCE.SYSTEM, promptVisible: true, handler: () => 'ok' })

  const listed = registry.list()
  assert(listed.length === 2, 'TR4: list returns 2 (promptVisible only)')
  assert(listed.some(t => t.name === 'file_read'), 'TR4: file_read in list')
  assert(listed.some(t => t.name === 'mcp_search'), 'TR4: mcp_search in list')
  assert(!listed.some(t => t.name === 'mcp0__pr'), 'TR4: mcp tool not in list')
}

// =================================================================
// TR5: listAll() → 전체
// =================================================================
{
  const registry = createToolRegistry()
  registry.register({ name: 'file_read', handler: () => 'ok' })
  registry.register({ name: 'mcp0__pr', source: TOOL_SOURCE.MCP, group: 'mcp0', promptVisible: false, handler: () => 'ok' })
  registry.disable('file_read')

  assert(registry.listAll().length === 2, 'TR5: listAll returns all including disabled')
}

// =================================================================
// TR6: search(query) → enabled 매칭
// =================================================================
{
  const registry = createToolRegistry()
  registry.register({ name: 'file_read', description: 'Read a text file', handler: () => 'ok' })
  registry.register({ name: 'file_write', description: 'Write a text file', handler: () => 'ok' })
  registry.register({ name: 'shell_exec', description: 'Execute shell', handler: () => 'ok' })

  const results = registry.search('file')
  assert(results.length === 2, 'TR6: search "file" matches 2')
  assert(results.every(t => t.name.includes('file')), 'TR6: all results contain "file"')

  registry.disable('file_read')
  assert(registry.search('file').length === 1, 'TR6: disabled tool excluded from search')
}

// =================================================================
// TR7: groups() → serverName, toolCount, enabled, 등록 순서
// =================================================================
{
  const registry = createToolRegistry()
  registry.registerGroup({ group: 'mcp0', serverName: 'github' })
  registry.registerGroup({ group: 'mcp1', serverName: 'slack' })
  registry.register({ name: 'mcp0__pr', source: TOOL_SOURCE.MCP, group: 'mcp0', promptVisible: false, handler: () => {} })
  registry.register({ name: 'mcp0__issue', source: TOOL_SOURCE.MCP, group: 'mcp0', promptVisible: false, handler: () => {} })
  registry.register({ name: 'mcp1__send', source: TOOL_SOURCE.MCP, group: 'mcp1', promptVisible: false, handler: () => {} })

  const groups = registry.groups()
  assert(groups.length === 2, 'TR7: 2 groups')
  assert(groups[0].group === 'mcp0', 'TR7: first group is mcp0 (registration order)')
  assert(groups[0].serverName === 'github', 'TR7: serverName')
  assert(groups[0].toolCount === 2, 'TR7: toolCount')
  assert(groups[0].enabled === true, 'TR7: initially enabled')

  registry.disableGroup('mcp1')
  assert(registry.groups()[1].enabled === false, 'TR7: disabled group')
}

// =================================================================
// TV1: persona filter → list()에서 제외
// =================================================================
{
  const registry = createToolRegistry()
  registry.register({ name: 'file_read', handler: () => 'ok' })
  registry.register({ name: 'file_write', handler: () => 'ok' })

  const allowedTools = new Set(['file_read'])
  const view = new ToolRegistryView(registry, (tool) => allowedTools.has(tool.name))

  assert(view.list().length === 1, 'TV1: persona filter applied')
  assert(view.list()[0].name === 'file_read', 'TV1: only allowed tool')
}

// =================================================================
// TV2: get(name) → persona-hidden=null
// =================================================================
{
  const registry = createToolRegistry()
  registry.register({ name: 'file_read', handler: () => 'ok' })
  registry.register({ name: 'file_write', handler: () => 'ok' })

  const view = new ToolRegistryView(registry, (tool) => tool.name === 'file_read')

  assert(view.get('file_read') !== null, 'TV2: allowed tool visible')
  assert(view.get('file_write') === null, 'TV2: persona-hidden tool returns null')
}

// =================================================================
// TV3: 전역 disable → view에 즉시 반영
// =================================================================
{
  const registry = createToolRegistry()
  registry.register({ name: 'file_read', handler: () => 'ok' })

  const view = new ToolRegistryView(registry, () => true)
  assert(view.get('file_read') !== null, 'TV3: initially visible')

  registry.disable('file_read')
  assert(view.get('file_read') === null, 'TV3: immediately hidden after global disable')
}

// =================================================================
// TV4: view.search() → persona + enabled
// =================================================================
{
  const registry = createToolRegistry()
  registry.register({ name: 'file_read', description: 'Read file', handler: () => 'ok' })
  registry.register({ name: 'file_write', description: 'Write file', handler: () => 'ok' })

  const view = new ToolRegistryView(registry, (tool) => tool.name === 'file_read')
  const results = view.search('file')
  assert(results.length === 1, 'TV4: search filtered by persona')
  assert(results[0].name === 'file_read', 'TV4: only persona-allowed result')
}

// =================================================================
// TM1: MCP 개별 등록 후 search 발견
// =================================================================
{
  const registry = createToolRegistry()
  registry.registerGroup({ group: 'mcp0', serverName: 'github' })
  registry.register({ name: 'mcp0__create_issue', source: TOOL_SOURCE.MCP, group: 'mcp0', promptVisible: false, description: 'Create GitHub issue', handler: () => 'ok' })

  const results = registry.search('issue')
  assert(results.length === 1, 'TM1: MCP tool found by search')
  assert(results[0].name === 'mcp0__create_issue', 'TM1: correct name')
}

// =================================================================
// TM2: 그룹 disable → search 제외 + get=null
// =================================================================
{
  const registry = createToolRegistry()
  registry.registerGroup({ group: 'mcp0', serverName: 'github' })
  registry.register({ name: 'mcp0__pr', source: TOOL_SOURCE.MCP, group: 'mcp0', promptVisible: false, description: 'List PRs', handler: () => 'ok' })

  registry.disableGroup('mcp0')
  assert(registry.search('pr').length === 0, 'TM2: disabled group excluded from search')
  assert(registry.get('mcp0__pr') === null, 'TM2: get returns null')
}

// =================================================================
// TM3-5: mcp_call_tool disabled/nonexistent/persona-hidden
// =================================================================
{
  const registry = createToolRegistry()
  registry.registerGroup({ group: 'mcp0', serverName: 'github' })
  registry.register({ name: 'mcp0__pr', source: TOOL_SOURCE.MCP, group: 'mcp0', promptVisible: false, description: 'PRs', handler: async () => 'pr result' })

  // TM3: disabled → 'MCP server disabled'
  registry.disableGroup('mcp0')
  const disabledTool = registry.find('mcp0__pr')
  assert(disabledTool !== null && !disabledTool.enabled, 'TM3: find returns disabled tool')

  // TM4: nonexistent → 'MCP tool not found'
  assert(registry.find('mcp0__nonexistent') === null, 'TM4: nonexistent returns null')
}

// =================================================================
// TH1: tool handler receives context with toolRegistry
// (핵심: 인터프리터가 context를 전달하는지 검증)
// =================================================================
{
  const registry = createToolRegistry()
  let receivedContext = null
  registry.register({
    name: 'test_tool',
    handler: (args, context) => { receivedContext = context; return 'ok' },
  })

  const tool = registry.get('test_tool')
  // 인터프리터가 하는 것과 동일한 호출: handler(args, { toolRegistry })
  const mockView = { search: () => [], get: () => null }
  tool.handler({}, { toolRegistry: mockView })

  assert(receivedContext !== null, 'TH1: context passed to handler')
  assert(receivedContext.toolRegistry === mockView, 'TH1: context.toolRegistry is the session view')
}

// =================================================================
// Legacy: 기존 호환
// =================================================================
{
  const registry = createToolRegistry()
  registry.register({
    name: 'github_list_prs',
    description: 'GitHub PR 목록 조회',
    parameters: { type: 'object', required: ['repo'], properties: { repo: { type: 'string' } } },
  })
  registry.register({
    name: 'slack_send',
    description: '슬랙 메시지 발송',
    parameters: { type: 'object', required: ['channel', 'message'], properties: { channel: { type: 'string' }, message: { type: 'string' } } },
  })

  assert(registry.get('github_list_prs') !== null, 'legacy: get returns tool')
  assert(registry.list().length === 2, 'legacy: list returns 2')
  assert(registry.get('unknown') === null, 'legacy: unknown returns null')
  assert(registry.schema().length === 2, 'legacy: schema returns 2 names')
}

summary()
