import { createToolRegistry } from './tools/tool-registry.js'
import { createLocalTools } from './tools/local-tools.js'
import { initMcpIntegration } from './tools/mcp-tools.js'
import { createPersona } from './persona.js'
import { Memory } from './memory.js'
import { createLogger } from './logger.js'
import { LLMClient } from './llm.js'
import { createAgentRegistry } from './agents/agent-registry.js'
import { createEmbedder } from './embedding.js'
import { createJobStore, defaultJobDbPath } from './jobs/job-store.js'
import { Config } from './config.js'
import { initI18n, t } from '../i18n/index.js'
import { createSessionManager } from './sessions/session-manager.js'

// =============================================================================
// UserContext: 유저 1명의 인프라 스택 + 세션 관리.
// 수명: 서버가 이 유저를 제공하는 동안 1개.
// 포함: 유저 공용 인프라(llm, memory, mcp, tools, jobStore 등) + sessions(SessionManager).
// =============================================================================

const defaultMemoryPath = () => {
  const home = process.env.HOME || process.env.USERPROFILE || '.'
  return `${home}/.presence/memory`
}

const buildEmbedder = (config) => {
  const embedApiKey = config.embed.apiKey
    || (config.embed.provider === 'openai' ? config.llm.apiKey : null)
  if (!embedApiKey && !config.embed.baseUrl) return null
  return createEmbedder({
    provider: config.embed.provider,
    baseUrl: config.embed.baseUrl,
    apiKey: embedApiKey,
    model: config.embed.model,
    dimensions: config.embed.dimensions,
  })
}

const registerSummarizer = (agentRegistry, llm) => {
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
}

class UserContext {
  /**
   * Builds a UserContext for a single user: bootstraps all infrastructure and creates a SessionManager.
   * @param {object|null} configOverride
   * @param {{ username?: string, onSessionCreated?: Function }} [opts]
   * @returns {Promise<UserContext>}
   */
  static async create(configOverride, opts = {}) {
    const { username, onSessionCreated } = opts
    const userContext = new UserContext()

    // --- Config + logger ---
    userContext.config = configOverride || Config.loadUserMerged(username)
    initI18n(userContext.config.locale)
    userContext.logger = createLogger().logger
    for (const w of Config.validate(userContext.config)) userContext.logger.warn(`[config] ${w}`)

    // --- Persona ---
    userContext.persona = createPersona()
    userContext.personaConfig = userContext.persona.get()

    // --- Memory ---
    userContext.memoryPath = userContext.config.memory.path
      || (username ? Config.userDataPath(username) : defaultMemoryPath())
    userContext.memory = await Memory.create(userContext.config, { memoryPath: userContext.memoryPath }).catch(e => {
      userContext.logger.warn('mem0 init failed, memory disabled', { error: e.message })
      return null
    })
    userContext.logger.info(t('startup.memory_loaded', {
      path: userContext.memoryPath, count: userContext.memory?.allNodes().length ?? 0,
    }))

    // --- Embedder ---
    userContext.embedder = buildEmbedder(userContext.config)

    // --- Tools (local + MCP) ---
    userContext.toolRegistry = createToolRegistry()
    const localTools = createLocalTools({ allowedDirs: userContext.config.tools?.allowedDirs || [process.cwd()] })
    for (const tool of localTools) userContext.toolRegistry.register(tool)
    const { mcpConnections, mcpControl } = await initMcpIntegration(userContext.config, userContext.logger, userContext.toolRegistry)
    userContext.mcpConnections = mcpConnections
    userContext.mcpControl = mcpControl

    // --- LLM + Agents ---
    userContext.llm = new LLMClient({
      baseUrl: userContext.config.llm.baseUrl,
      model: userContext.config.llm.model,
      apiKey: userContext.config.llm.apiKey,
      timeoutMs: userContext.config.llm.timeoutMs,
    })
    userContext.agentRegistry = createAgentRegistry()
    registerSummarizer(userContext.agentRegistry, userContext.llm)

    // --- Job Store ---
    userContext.jobStore = createJobStore(defaultJobDbPath(userContext.memoryPath))

    // --- Sessions (userContext 자기 참조) ---
    userContext.sessions = createSessionManager(userContext, { onSessionCreated })

    return userContext
  }

  // 세션 → 인프라 순서로 정리.
  async shutdown() {
    await Promise.all(this.sessions.list().map(({ session }) => session.shutdown().catch(() => {})))
    this.jobStore.close()
    for (const conn of this.mcpConnections) {
      try { await conn.close() } catch (_) {}
    }
  }
}

export { UserContext }
