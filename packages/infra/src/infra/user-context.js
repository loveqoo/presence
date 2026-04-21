import { createToolRegistry } from './tools/tool-registry.js'
import { createLocalTools } from './tools/local-tools.js'
import { initMcpIntegration } from './tools/mcp-tools.js'
import { createPersona } from './persona.js'
import { createLogger } from './logger.js'
import { LLMClient } from './llm/llm-client.js'
import { createAgentRegistry, registerSummarizer } from './agents/agent-registry.js'
import { createEmbedder } from './embedding/embedder.js'
import { createJobStore, defaultJobDbPath } from './jobs/job-store.js'
import { UserDataStore, defaultUserDataDbPath } from './user-data-store.js'
import { Config } from './config.js'
import { loadUserMerged, ensureAllowedDirs } from './config-loader.js'
import { ensureUserDefaultAgent } from './user-migration.js'
import { initI18n, t } from '../i18n/index.js'
import { createSessionManager } from './sessions/session-manager.js'

// =============================================================================
// UserContext: 유저 1명의 인프라 스택 + 세션 관리.
// 수명: 서버가 이 유저를 제공하는 동안 1개.
// 포함: 유저 공용 인프라(llm, memory, mcp, tools, jobStore 등) + sessions(SessionManager).
// =============================================================================

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
    // configOverride 는 plain object 가능 → Config 인스턴스 보장
    userContext.config = configOverride
      ? (configOverride instanceof Config ? configOverride : new Config(configOverride))
      : loadUserMerged(username)
    initI18n(userContext.config.locale)
    userContext.logger = createLogger().logger
    if (!userContext.config.llm?.apiKey) userContext.logger.warn('[config] llm.apiKey is not set — LLM calls will fail')

    // --- allowedDirs migration (process.cwd() 의존 제거) ---
    userContext.config = ensureAllowedDirs(userContext.config, { username, logger: userContext.logger })

    // --- M3+M4: primaryAgentId + default agent 보충 ---
    // admin 은 admin-bootstrap 이 처리. 비-admin user 만 여기서 lazy migration.
    if (username) {
      const { config: migratedConfig } = ensureUserDefaultAgent(userContext.config, {
        username, logger: userContext.logger,
      })
      userContext.config = migratedConfig
    }

    // --- Persona ---
    userContext.persona = createPersona()
    userContext.personaConfig = userContext.persona.get()

    // --- Memory (외부 주입) ---
    userContext.memory = opts.memory ?? null
    userContext.logger.info(userContext.memory ? 'Memory: mem0 enabled' : 'Memory: disabled')

    // --- User data path (jobStore, userDataStore) ---
    userContext.userDataPath = Config.userDataPath(username || 'default')

    // --- Embedder ---
    userContext.embedder = buildEmbedder(userContext.config)

    // --- Tools (local + MCP) ---
    userContext.toolRegistry = createToolRegistry()
    const localTools = createLocalTools({ allowedDirs: userContext.config.tools.allowedDirs })
    for (const tool of localTools) userContext.toolRegistry.register(tool)
    const { mcpConnections } = await initMcpIntegration(userContext.config, userContext.logger, userContext.toolRegistry)
    userContext.mcpConnections = mcpConnections

    // --- LLM + Agents ---
    userContext.llm = new LLMClient({
      baseUrl: userContext.config.llm.baseUrl,
      model: userContext.config.llm.model,
      apiKey: userContext.config.llm.apiKey,
      timeoutMs: userContext.config.llm.timeoutMs,
    })
    userContext.agentRegistry = createAgentRegistry()
    registerSummarizer(userContext.agentRegistry, userContext.llm)

    // --- Job Store + User Data Store ---
    userContext.jobStore = createJobStore(defaultJobDbPath(userContext.userDataPath))
    userContext.userDataStore = new UserDataStore(defaultUserDataDbPath(userContext.userDataPath))

    // --- Sessions (userContext 자기 참조) ---
    userContext.sessions = createSessionManager(userContext, { onSessionCreated })

    return userContext
  }

  // 세션 → 인프라 순서로 정리.
  async shutdown() {
    await Promise.all(this.sessions.list().map(({ session }) => session.shutdown().catch(() => {})))
    this.jobStore.close()
    this.userDataStore.close()
    for (const conn of this.mcpConnections) {
      try { await conn.close() } catch (_) {}
    }
  }
}

export { UserContext }
