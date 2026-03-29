import { join } from 'node:path'

// presence의 단일 사용자 에이전트 — 고정 userId
const MEM0_USER_ID = 'default'

// --- Mem0Adapter ---
// mem0 Memory 인스턴스를 래핑해 MemoryGraph 호환 동기 API를 제공.
// allNodes() 등 동기 호출은 내부 캐시를 반환 (save 완료 후 비동기 갱신).

class Mem0Adapter {
  constructor(mem0) {
    this._mem0 = mem0
    this._cache = []
  }

  async _refreshCache() {
    try {
      const result = await this._mem0.getAll({ userId: MEM0_USER_ID })
      this._cache = (result.results || []).map(r => ({
        id: r.id,
        label: r.memory,
        type: 'fact',
        tier: 'episodic',
        createdAt: r.createdAt ? new Date(r.createdAt).getTime() : Date.now(),
      }))
    } catch (_) {}
  }

  // MemoryGraph 호환 API

  allNodes() { return this._cache }

  async getAll() {
    await this._refreshCache()
    return this._cache
  }

  clearAll() {
    const count = this._cache.length
    this._cache = []
    this._mem0.reset().catch(() => {})
    return count
  }

  // mem0는 tier 개념 없음 — no-op
  removeNodesByTier(_tier) { return 0 }

  removeOlderThan(maxAgeMs, _opts = {}) {
    const cutoff = Date.now() - maxAgeMs
    const toDelete = this._cache.filter(n => n.createdAt < cutoff)
    this._cache = this._cache.filter(n => n.createdAt >= cutoff)
    Promise.all(toDelete.map(n => this._mem0.delete(n.id).catch(() => {}))).catch(() => {})
    return toDelete.length
  }

  async save() { /* no-op — mem0가 SQLite에 자동 저장 */ }
}

// --- factory ---

const createMem0Memory = async (config, { memoryPath } = {}) => {
  const { llm, embed } = config
  const embedApiKey = embed.apiKey || (embed.provider === 'openai' ? llm.apiKey : null)
  if (!embedApiKey && !embed.baseUrl) return null

  const { Memory } = await import('mem0ai/oss')
  const mem0 = new Memory({
    llm: {
      provider: 'openai',
      config: {
        apiKey: llm.apiKey,
        model: llm.model,
        ...(llm.baseUrl && { baseURL: llm.baseUrl }),
      },
    },
    embedder: {
      provider: 'openai',
      config: {
        apiKey: embedApiKey,
        model: embed.model || 'text-embedding-3-small',
        embeddingDims: embed.dimensions || 1536,
        ...(embed.baseUrl && { baseURL: embed.baseUrl }),
      },
    },
    vectorStore: {
      provider: 'memory',
      config: { collectionName: 'presence_memories', dimension: embed.dimensions || 1536 },
    },
    historyStore: {
      provider: 'sqlite',
      config: { historyDbPath: memoryPath ? join(memoryPath, 'mem0_history.db') : ':memory:' },
    },
  })

  const adapter = new Mem0Adapter(mem0)
  await adapter._refreshCache()

  return { mem0, adapter }
}

/**
 * `createMem0Memory(config, opts?)` — Initialises a mem0 OSS Memory instance and wraps it in a Mem0Adapter.
 * Returns `{ mem0, adapter }` or `null` if embedding credentials are missing.
 * @param {{ llm: object, embed: object }} config
 * @param {{ memoryPath?: string }} [opts]
 * @returns {Promise<{ mem0: object, adapter: Mem0Adapter } | null>}
 *
 * `Mem0Adapter` — MemoryGraph-compatible adapter over a mem0 Memory instance (synchronous cache + async persistence).
 *
 * `MEM0_USER_ID` — Fixed user ID used for all mem0 operations in single-user deployments.
 */
export { createMem0Memory, Mem0Adapter, MEM0_USER_ID }
