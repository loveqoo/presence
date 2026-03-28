import React from 'react'
import { render } from 'ink'
import { createToolRegistry } from './infra/tools.js'
import { createPersona } from './infra/persona.js'
import { defaultMemoryPath } from './infra/memory.js'
import { createMem0Memory } from './infra/mem0-memory.js'
import { createLogger } from './infra/logger.js'
import { LLMClient } from './infra/llm.js'
import { createAgentRegistry } from './infra/agent-registry.js'
import { connectMCPServer } from './infra/mcp.js'
import { createEmbedder } from './infra/embedding.js'
import { createJobStore, defaultJobDbPath } from './infra/job-store.js'
import { loadConfig, validateConfig } from './infra/config.js'
import { createLocalTools } from './infra/local-tools.js'
import { initI18n, t } from './i18n/index.js'
import { App } from './ui/App.js'
import { createRemoteState } from './infra/remote-state.js'
import { createSession } from './infra/session-factory.js'

const h = React.createElement

// =============================================================================
// Global Context: config → 전역 인프라 조립. 서버 수명 동안 1개 인스턴스.
// LLM, 메모리, MCP, JobStore, AgentRegistry 등 세션 간 공유 자원.
// =============================================================================

const createGlobalContext = async (configOverride) => {
  const config = configOverride || loadConfig()
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

// =============================================================================
// Bootstrap: createGlobalContext + createSession 조합. 하위 호환 유지.
// e2e 테스트에서 직접 사용 가능: const app = await bootstrap(config)
// =============================================================================

const bootstrap = async (configOverride, { persistenceCwd } = {}) => {
  const globalCtx = await createGlobalContext(configOverride)
  const session = createSession(globalCtx, { persistenceCwd })

  const { config, logger, personaConfig, memory, llm, mcpControl, jobStore, embedder, mcpConnections, mem0 } = globalCtx
  const { agent, state, tools, agents, handleInput, handleApproveResponse, handleCancel, schedulerActor, delegateActor } = session

  // --- Startup summary ---
  logger.info('Startup complete', {
    model: config.llm.model,
    responseFormat: config.llm.responseFormat,
    maxRetries: config.llm.maxRetries,
    maxIterations: config.maxIterations,
    timeoutMs: config.llm.timeoutMs,
    tools: tools.length,
    agents: agents.length,
    mcpServers: mcpConnections.length,
    embedder: embedder ? config.embed.provider : 'none',
    scheduler: config.scheduler.enabled ? `enabled (poll: ${config.scheduler.pollIntervalMs}ms)` : 'disabled',
    scheduledJobs: jobStore.listJobs().filter(j => j.enabled).length,
    memory: mem0 ? `mem0 (${memory?.allNodes().length ?? 0} cached)` : 'disabled',
  })

  const shutdown = async () => {
    await session.shutdown()
    await globalCtx.shutdown()
  }

  return {
    agent, state, config, logger,
    tools, agents, personaConfig,
    handleInput, handleApproveResponse, handleCancel,
    schedulerActor, delegateActor, jobStore,
    memory, llm, mcpControl,
    shutdown,
  }
}

// =============================================================================
// View: Ink 렌더링. TTY 필요.
//
// 실행 모드:
//   기본값 : WS 서버 연결 시도 → 없으면 자동 spawn → 원격 상태로 렌더링
//   --local : in-process bootstrap() 모드 (테스트/오프라인 개발용)
// =============================================================================

const getServerPort = () => Number(process.env.PORT) || 3000

// 서버 생존 여부 확인 (GET /api/state 응답 체크)
const checkServerReachable = async (baseUrl) => {
  try {
    const { default: http } = await import('node:http')
    const url = new URL('/api/state', baseUrl)
    return await new Promise((resolve) => {
      const req = http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      })
      req.on('error', () => resolve(false))
      req.setTimeout(1500, () => { req.destroy(); resolve(false) })
    })
  } catch (_) {
    return false
  }
}

// 서버가 응답할 때까지 폴링 (최대 10초)
const waitForServer = async (baseUrl, { maxMs = 10_000, intervalMs = 300 } = {}) => {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    if (await checkServerReachable(baseUrl)) return true
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return false
}

// 서버 프로세스 백그라운드 spawn (터미널 종료 후에도 유지)
const spawnServer = async (port) => {
  const { spawn } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const { join, dirname } = await import('node:path')
  const serverPath = join(dirname(fileURLToPath(import.meta.url)), 'server/index.js')
  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(port) },
  })
  child.unref()
}

// 원격 모드: WS 상태 미러링 + REST 커맨드
const runRemote = async (baseUrl) => {
  const port = getServerPort()
  const wsUrl = baseUrl.replace(/^http/, 'ws')

  const remoteState = createRemoteState({ wsUrl, sessionId: 'user-default' })

  const post = async (path, body) => {
    const { default: http } = await import('node:http')
    const url = new URL(path, baseUrl)
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body || {})
      const req = http.request({
        hostname: url.hostname, port: url.port, path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (res) => {
        let buf = ''
        res.on('data', d => { buf += d })
        res.on('end', () => { try { resolve(JSON.parse(buf)) } catch { resolve(buf) } })
      })
      req.on('error', reject)
      req.write(data)
      req.end()
    })
  }

  const getJson = async (path) => {
    const { default: http } = await import('node:http')
    const url = new URL(path, baseUrl)
    return new Promise((resolve, reject) => {
      http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
        let buf = ''
        res.on('data', d => { buf += d })
        res.on('end', () => { try { resolve(JSON.parse(buf)) } catch { resolve([]) } })
      }).on('error', reject)
    })
  }

  const handleInput = async (input) => {
    const res = await post('/api/chat', { input })
    if (res.type === 'error') throw new Error(res.content)
    return res.content
  }
  const handleApproveResponse = (approved) => { post('/api/approve', { approved }).catch(() => {}) }
  const handleCancel = () => { post('/api/cancel').catch(() => {}) }

  const [tools, agents, config] = await Promise.all([
    getJson('/api/tools').catch(() => []),
    getJson('/api/agents').catch(() => []),
    getJson('/api/config').catch(() => ({})),
  ])

  const cwd = process.cwd()
  let gitBranch = ''
  try {
    const { execSync } = await import('child_process')
    gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
  } catch (_) {}

  const onSignal = () => { remoteState.disconnect(); process.exit(0) }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  const { waitUntilExit } = render(
    h(App, {
      state: remoteState,
      onInput: handleInput,
      onApprove: handleApproveResponse,
      onCancel: handleCancel,
      agentName: config.persona?.name || 'Presence',
      tools,
      agents,
      cwd,
      gitBranch,
      model: config.llm?.model || '',
      config,
      memory: null,   // remote mode: /memory 커맨드는 서버에서 처리
      llm: null,      // remote mode: /models 커맨드 비활성
      mcpControl: null, // remote mode: /mcp 커맨드는 서버에서 처리
      initialMessages: [],
    })
  )

  await waitUntilExit()
  process.off('SIGTERM', onSignal)
  process.off('SIGINT', onSignal)
  remoteState.disconnect()
}

// in-process 모드: bootstrap() 후 직접 렌더링
const runLocal = async () => {
  const app = await bootstrap()

  const onSignal = async () => { await app.shutdown().catch(() => {}); process.exit(0) }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  const cwd = process.cwd()
  let gitBranch = ''
  try {
    const { execSync } = await import('child_process')
    gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
  } catch (_) {}

  const { waitUntilExit } = render(
    h(App, {
      state: app.state,
      onInput: app.handleInput,
      onApprove: app.handleApproveResponse,
      onCancel: app.handleCancel,
      agentName: app.personaConfig.name,
      tools: app.tools,
      agents: app.agents,
      cwd,
      gitBranch,
      model: app.config.llm.model,
      config: app.config,
      memory: app.memory,
      llm: app.llm,
      mcpControl: app.mcpControl,
      initialMessages: [],
    })
  )

  if (app.config.scheduler.enabled) app.schedulerActor.send({ type: 'start' }).fork(() => {}, () => {})
  app.delegateActor.send({ type: 'start' }).fork(() => {}, () => {})

  await waitUntilExit()
  process.off('SIGTERM', onSignal)
  process.off('SIGINT', onSignal)
  await app.shutdown()
}

const main = async () => {
  const isLocal = process.argv.includes('--local')

  if (isLocal) {
    return runLocal()
  }

  // 원격 모드: 서버 자동 감지 + 필요 시 spawn
  const port = getServerPort()
  const baseUrl = `http://127.0.0.1:${port}`

  const reachable = await checkServerReachable(baseUrl)
  if (!reachable) {
    console.log(`서버가 실행 중이지 않습니다. 시작 중... (port ${port})`)
    await spawnServer(port)
    const ready = await waitForServer(baseUrl)
    if (!ready) {
      console.error('서버 시작 실패. --local 플래그로 in-process 모드로 실행하거나 서버를 수동으로 시작하세요.')
      process.exit(1)
    }
  }

  return runRemote(baseUrl)
}

export { main, bootstrap, createGlobalContext, createSession }

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''))) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1) })
}
