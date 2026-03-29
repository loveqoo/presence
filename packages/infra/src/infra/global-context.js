import { createToolRegistry } from './tools.js'
import { createPersona } from './persona.js'
import { defaultMemoryPath } from './memory.js'
import { createMem0Memory } from './mem0-memory.js'
import { createLogger } from './logger.js'
import { LLMClient } from './llm.js'
import { createAgentRegistry } from './agent-registry.js'
import { connectMCPServer } from './mcp.js'
import { createEmbedder } from './embedding.js'
import { createJobStore, defaultJobDbPath } from './job-store.js'
import { loadInstanceConfig, validateConfig } from './config.js'
import { createLocalTools } from './local-tools.js'
import { initI18n, t } from '../i18n/index.js'

// =============================================================================
// Global Context: config → 전역 인프라 조립. 서버 수명 동안 1개 인스턴스.
// LLM, 메모리, MCP, JobStore, AgentRegistry 등 세션 간 공유 자원.
// =============================================================================

/**
 * Assembles all shared infrastructure for a server instance (LLM, memory, MCP, tools, etc.).
 * Returns a context object that is shared across all sessions for the lifetime of the server.
 * @param {object|null} configOverride - Config object to use directly; if null, loads from instanceId.
 * @param {{ instanceId?: string }} [options]
 * @returns {Promise<{config, logger, persona, personaConfig, mem0, memory, embedder, memoryPath, toolRegistry, mcpControl, mcpConnections, agentRegistry, llm, jobStore, shutdown: () => Promise<void>}>}
 */
const createGlobalContext = async (configOverride, { instanceId } = {}) => {
  const config = configOverride || loadInstanceConfig(instanceId)
  initI18n(config.locale)
  const { logger } = createLogger()

  // --- Startup validation ---
  const warnings = validateConfig(config)
  for (const w of warnings) logger.warn(`[config] ${w}`)

  const persona = createPersona()
  const personaConfig = persona.get()

  // --- Memory ---
  const memoryPath = config.memory.path || defaultMemoryPath()
  const mem0Result = await createMem0Memory(config, { memoryPath }).catch(e => {
    logger.warn('mem0 init failed, memory disabled', { error: e.message })
    return null
  })
  const mem0 = mem0Result?.mem0 || null
  const memory = mem0Result?.adapter || null
  logger.info(t('startup.memory_loaded', { path: memoryPath, count: memory?.allNodes().length ?? 0 }))

  // --- Embedder ---
  const embedApiKey = config.embed.apiKey
    || (config.embed.provider === 'openai' ? config.llm.apiKey : null)
  const embedEnabled = embedApiKey || config.embed.baseUrl
  const embedder = embedEnabled
    ? createEmbedder({
        provider: config.embed.provider,
        baseUrl: config.embed.baseUrl,
        apiKey: embedApiKey,
        model: config.embed.model,
        dimensions: config.embed.dimensions,
      })
    : null

  // --- Tools (local + MCP) ---
  const toolRegistry = createToolRegistry()
  const localTools = createLocalTools({
    allowedDirs: config.tools?.allowedDirs || [process.cwd()],
  })
  for (const tool of localTools) toolRegistry.register(tool)

  // --- MCP ---
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
      for (const tool of conn.tools) {
        allMcpTools.push({ ...tool, name: `${prefix}__${tool.name}` })
      }
      mcpServers.push({ prefix, serverName: server.serverName, toolCount: conn.tools.length })
      enabledPrefixes.add(prefix)
      mcpConnections.push(conn)
      logger.info(`MCP connected: ${server.serverName} (${conn.tools.length} tools)`)
    } catch (e) {
      logger.warn(`MCP 연결 실패: ${server.serverName}`, { error: e.message })
    }
  }

  if (allMcpTools.length > 0) {
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
      handler: ({ query }) => {
        const tools = visibleTools()
        if (!query) return `${tools.length} MCP tools available. Provide a query to search.`
        const q = query.toLowerCase()
        const matches = tools.filter(t =>
          t.name.toLowerCase().includes(q) ||
          (t.description || '').toLowerCase().includes(q)
        )
        if (matches.length === 0) return `No MCP tools found matching: "${query}"`
        return matches.map(t => `${t.name}: ${t.description || '(no description)'}`).join('\n')
      },
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
      handler: async ({ tool_name, tool_args = {} }) => {
        const tool = mcpToolIndex.get(tool_name)
        if (!tool) throw new Error(`MCP tool not found: "${tool_name}". Use mcp_search_tools to find available tools.`)
        if (!enabledPrefixes.has(getPrefix(tool_name))) throw new Error(`MCP server disabled: "${getPrefix(tool_name)}". Use /mcp enable to re-enable.`)
        return await tool.handler(tool_args)
      },
    })
  }

  const mcpControl = {
    list: () => mcpServers.map(s => ({ ...s, enabled: enabledPrefixes.has(s.prefix) })),
    enable:  (prefix) => { const ok = mcpServers.some(s => s.prefix === prefix); if (ok) enabledPrefixes.add(prefix);    return ok },
    disable: (prefix) => { const ok = mcpServers.some(s => s.prefix === prefix); if (ok) enabledPrefixes.delete(prefix); return ok },
  }

  // --- Agent Registry ---
  const agentRegistry = createAgentRegistry()

  // --- LLM ---
  const llm = new LLMClient({
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    apiKey: config.llm.apiKey,
    timeoutMs: config.llm.timeoutMs,
  })

  agentRegistry.register({
    name: 'summarizer',
    description: '텍스트 요약 에이전트. 긴 내용을 간결하게 정리할 때 위임하세요.',
    capabilities: ['summarize'],
    type: 'local',
    run: async (task) => {
      const result = await llm.chat({
        messages: [
          { role: 'system', content: '주어진 내용을 간결하게 요약하세요. 핵심만 남기세요.' },
          { role: 'user', content: task },
        ],
      })
      return result.content
    },
  })

  // --- Job Store ---
  const jobStore = createJobStore(defaultJobDbPath(memoryPath))

  const shutdown = async () => {
    jobStore.close()
    for (const conn of mcpConnections) {
      try { await conn.close() } catch (_) {}
    }
  }

  return {
    config, logger, persona, personaConfig,
    mem0, memory, embedder, memoryPath,
    toolRegistry, mcpControl, mcpConnections,
    agentRegistry, llm, jobStore,
    shutdown,
  }
}

export { createGlobalContext }
