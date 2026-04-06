import { connectMCPServer } from '../mcp.js'
import { TOOL_SOURCE } from './tool-registry.js'

// =============================================================================
// MCP 툴 통합: MCP 서버에 연결 → 도구를 registry에 개별 등록 + 게이트웨이 도구 등록.
// mcpToolIndex/enabledPrefixes/mcpControl → 모두 registry로 통합.
// =============================================================================

const MCP_PREFIX_DELIMITER = '__'

// --- MCP 서버 연결 + prefix 부여. 실패는 warn 로그 후 스킵. ---
const connectMcpServers = async (config, logger, toolRegistry) => {
  const mcpConnections = []
  let mcpIdx = 0
  for (const server of config.mcp) {
    if (!server.enabled) continue
    try {
      const conn = await connectMCPServer(server)
      const prefix = `mcp${mcpIdx++}`

      // 그룹 등록
      toolRegistry.registerGroup({ group: prefix, serverName: server.serverName })

      // MCP 도구 개별 등록 (promptVisible: false — LLM 프롬프트에 직접 노출하지 않음)
      for (const tool of conn.tools) {
        toolRegistry.register({
          ...tool,
          name: `${prefix}${MCP_PREFIX_DELIMITER}${tool.name}`,
          source: TOOL_SOURCE.MCP,
          group: prefix,
          promptVisible: false,
        })
      }

      mcpConnections.push(conn)
      logger.info(`MCP connected: ${server.serverName} (${conn.tools.length} tools)`)
    } catch (e) {
      logger.warn(`MCP 연결 실패: ${server.serverName}`, { error: e.message })
    }
  }
  return { mcpConnections }
}

// --- 게이트웨이 도구: search + call ---
// handler의 두 번째 인자 context.toolRegistry는 세션의 ToolRegistryView (persona 적용됨)

const formatSearchResults = (tools) => {
  if (tools.length === 0) return 'No MCP tools found.'
  return tools.map(t => `${t.name}: ${t.description || '(no description)'}`).join('\n')
}

const registerGatewayTools = (toolRegistry) => {
  // 검색: context.toolRegistry(세션 view)로 persona-aware 검색
  toolRegistry.register({
    name: 'mcp_search_tools',
    source: TOOL_SOURCE.SYSTEM,
    promptVisible: true,
    description: 'Search available MCP tools by keyword. Returns matching tool names and descriptions. Use this before mcp_call_tool to find the right tool.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search term (e.g. "calendar", "github issue", "slack"). Omit to list all available tools.' } },
    },
    handler: ({ query }, context) => {
      // context.toolRegistry = 세션의 ToolRegistryView (enabled + persona 적용)
      const view = context?.toolRegistry
      const results = view ? view.search(query).filter(t => t.source === TOOL_SOURCE.MCP) : []
      if (!query && results.length > 0) return `${results.length} MCP tools available. Provide a query to search.`
      return formatSearchResults(results)
    },
  })

  // 호출: 전역 registry.find로 disabled/nonexistent 구분 + view로 persona 체크
  toolRegistry.register({
    name: 'mcp_call_tool',
    source: TOOL_SOURCE.SYSTEM,
    promptVisible: true,
    description: 'Call a specific MCP tool by its exact name. Use mcp_search_tools first to find the tool name and understand its parameters.',
    parameters: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Exact tool name from mcp_search_tools result' },
        tool_args: { type: 'object', description: 'Arguments for the tool (check tool description for required fields)' },
      },
      required: ['tool_name'],
    },
    handler: async ({ tool_name: toolName, tool_args: toolArgs = {} }, context) => {
      // 전역 registry로 disabled/nonexistent 구분
      const tool = toolRegistry.find(toolName)
      if (!tool) throw new Error(`MCP tool not found: "${toolName}". Use mcp_search_tools to find available tools.`)
      if (!tool.enabled) throw new Error(`MCP server disabled: "${tool.group}". Use /mcp enable to re-enable.`)
      // 세션 view로 persona 체크
      const view = context?.toolRegistry
      if (view && !view.get(toolName)) throw new Error(`MCP tool not found: "${toolName}". Use mcp_search_tools to find available tools.`)
      return await tool.handler(toolArgs)
    },
  })
}

// MCP 통합 전체: 연결 + 개별 등록 + 게이트웨이 도구.
const initMcpIntegration = async (config, logger, toolRegistry) => {
  const { mcpConnections } = await connectMcpServers(config, logger, toolRegistry)
  if (toolRegistry.listAll().some(t => t.source === TOOL_SOURCE.MCP)) {
    registerGatewayTools(toolRegistry)
  }
  return { mcpConnections }
}

export { initMcpIntegration }
