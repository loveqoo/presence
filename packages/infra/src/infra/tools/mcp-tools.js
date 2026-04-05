import { connectMCPServer } from '../mcp.js'

// =============================================================================
// MCP 툴 통합: 설정된 MCP 서버에 연결하고 toolRegistry에 검색/호출 툴 등록.
// =============================================================================

// --- MCP 서버 연결 + prefix 부여. 실패는 warn 로그 후 스킵. ---
const connectMcpServers = async (config, logger) => {
  const mcpConnections = []
  const allMcpTools = []
  const mcpServers = []
  const enabledPrefixes = new Set()
  let mcpIdx = 0
  for (const server of config.mcp) {
    if (!server.enabled) continue
    try {
      const conn = await connectMCPServer(server)
      const prefix = `mcp${mcpIdx++}`
      for (const tool of conn.tools) allMcpTools.push({ ...tool, name: `${prefix}__${tool.name}` })
      mcpServers.push({ prefix, serverName: server.serverName, toolCount: conn.tools.length })
      enabledPrefixes.add(prefix)
      mcpConnections.push(conn)
      logger.info(`MCP connected: ${server.serverName} (${conn.tools.length} tools)`)
    } catch (e) {
      logger.warn(`MCP 연결 실패: ${server.serverName}`, { error: e.message })
    }
  }
  return { mcpConnections, allMcpTools, mcpServers, enabledPrefixes }
}

const searchMcpTools = (tools, query) => {
  if (!query) return `${tools.length} MCP tools available. Provide a query to search.`
  const q = query.toLowerCase()
  const matches = tools.filter(t =>
    t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)
  )
  if (matches.length === 0) return `No MCP tools found matching: "${query}"`
  return matches.map(t => `${t.name}: ${t.description || '(no description)'}`).join('\n')
}

const callMcpTool = async (mcpToolIndex, enabledPrefixes, getPrefix, tool_name, tool_args) => {
  const tool = mcpToolIndex.get(tool_name)
  if (!tool) throw new Error(`MCP tool not found: "${tool_name}". Use mcp_search_tools to find available tools.`)
  if (!enabledPrefixes.has(getPrefix(tool_name))) throw new Error(`MCP server disabled: "${getPrefix(tool_name)}". Use /mcp enable to re-enable.`)
  return await tool.handler(tool_args)
}

const registerMcpTools = (toolRegistry, allMcpTools, enabledPrefixes) => {
  const mcpToolIndex = new Map(allMcpTools.map(t => [t.name, t]))
  const getPrefix = (name) => name.split('__')[0]
  const visibleTools = () => allMcpTools.filter(t => enabledPrefixes.has(getPrefix(t.name)))

  toolRegistry.register({
    name: 'mcp_search_tools',
    description: 'Search available MCP tools by keyword. Returns matching tool names and descriptions. Use this before mcp_call_tool to find the right tool.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search term (e.g. "calendar", "github issue", "slack"). Omit to list all available tools.' } },
    },
    handler: ({ query }) => searchMcpTools(visibleTools(), query),
  })

  toolRegistry.register({
    name: 'mcp_call_tool',
    description: 'Call a specific MCP tool by its exact name. Use mcp_search_tools first to find the tool name and understand its parameters.',
    parameters: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Exact tool name from mcp_search_tools result' },
        tool_args: { type: 'object', description: 'Arguments for the tool (check tool description for required fields)' },
      },
      required: ['tool_name'],
    },
    handler: async (args) => callMcpTool(mcpToolIndex, enabledPrefixes, getPrefix, args.tool_name, args.tool_args || {}),
  })
}

// enable/disable/list control 객체 — UI가 MCP 서버를 런타임 제어.
const buildMcpControl = (mcpServers, enabledPrefixes) => ({
  list: () => mcpServers.map(s => ({ ...s, enabled: enabledPrefixes.has(s.prefix) })),
  enable:  (prefix) => { const ok = mcpServers.some(s => s.prefix === prefix); if (ok) enabledPrefixes.add(prefix);    return ok },
  disable: (prefix) => { const ok = mcpServers.some(s => s.prefix === prefix); if (ok) enabledPrefixes.delete(prefix); return ok },
})

// MCP 통합 전체: 연결 + 툴 등록 + control 객체 생성.
const initMcpIntegration = async (config, logger, toolRegistry) => {
  const { mcpConnections, allMcpTools, mcpServers, enabledPrefixes } = await connectMcpServers(config, logger)
  if (allMcpTools.length > 0) registerMcpTools(toolRegistry, allMcpTools, enabledPrefixes)
  const mcpControl = buildMcpControl(mcpServers, enabledPrefixes)
  return { mcpConnections, mcpControl }
}

export { initMcpIntegration }
