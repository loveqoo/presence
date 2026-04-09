import { join } from 'node:path'

// presence의 단일 사용자 에이전트 — 고정 userId
const MEM0_USER_ID = 'default'
const DEFAULT_EMBED_MODEL = 'text-embedding-3-small'
const DEFAULT_EMBED_DIMS = 1536

// =============================================================================
// Memory: mem0 기반 메모리 + 동기 캐시 뷰.
// Write path: search()/add()로 mem0에 접근, add()/clearAll() 등에서 내부 캐시 갱신.
// Read path(UI/REPL): allNodes() 동기 호출로 캐시 조회.
//
// 주의: mem0는 tier 개념이 없는 flat memory. tier 필드는 UI 표시용 라벨.
// =============================================================================

class Memory {
  #mem0
  #cache

  constructor(mem0) {
    this.#mem0 = mem0
    this.#cache = []
  }

  // mem0 인스턴스 생성 + 초기 캐시 로드. embed 자격증명 없으면 null.
  static async create(config, opts = {}) {
    const { memoryPath } = opts
    const { llm, embed } = config
    const embedApiKey = embed.apiKey || (embed.provider === 'openai' ? llm.apiKey : null)
    if (!embedApiKey && !embed.baseUrl) return null

    const { Memory: Mem0Memory } = await import('mem0ai/oss')
    const mem0Config = Memory.#buildMem0Config({ llm, embed, embedApiKey, memoryPath })
    const memory = new Memory(new Mem0Memory(mem0Config))
    await memory.refreshCache()
    return memory
  }

  static #buildMem0Config({ llm, embed, embedApiKey, memoryPath }) {
    const dims = embed.dimensions || DEFAULT_EMBED_DIMS
    return {
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
          model: embed.model || DEFAULT_EMBED_MODEL,
          embeddingDims: dims,
          ...(embed.baseUrl && { baseURL: embed.baseUrl }),
        },
      },
      vectorStore: {
        provider: 'memory',
        config: {
          collectionName: 'presence_memories',
          dimension: dims,
          ...(memoryPath && { dbPath: join(memoryPath, 'vector_store.db') }),
        },
      },
      historyStore: {
        provider: 'sqlite',
        config: { historyDbPath: memoryPath ? join(memoryPath, 'mem0_history.db') : ':memory:' },
      },
    }
  }

  // --- Write path ---

  // 유사 메모리 검색. 반환: [{ label }]
  async search(input, limit = 10) {
    const result = await this.#mem0.search(input, { userId: MEM0_USER_ID, limit })
    return (result.results || []).map(record => ({ label: record.memory }))
  }

  // 대화 턴 저장 + 캐시 동기화
  async add(userInput, assistantOutput) {
    await this.#mem0.add([
      { role: 'user', content: userInput },
      { role: 'assistant', content: assistantOutput || '' },
    ], { userId: MEM0_USER_ID })
    await this.refreshCache()
  }

  // --- Read path (동기 캐시) ---

  async refreshCache() {
    try {
      const result = await this.#mem0.getAll({ userId: MEM0_USER_ID })
      this.#cache = (result.results || []).map(record => ({
        id: record.id,
        label: record.memory,
        type: 'fact',
        tier: 'episodic',
        createdAt: record.createdAt ? new Date(record.createdAt).getTime() : Date.now(),
      }))
    } catch (_) {}
  }

  allNodes() { return this.#cache }

  clearAll() {
    const count = this.#cache.length
    this.#cache = []
    this.#mem0.reset().catch(() => {})
    return count
  }

  removeOlderThan(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs
    const toDelete = this.#cache.filter(node => node.createdAt < cutoff)
    this.#cache = this.#cache.filter(node => node.createdAt >= cutoff)
    Promise.all(toDelete.map(node => this.#mem0.delete(node.id).catch(() => {}))).catch(() => {})
    return toDelete.length
  }
}

export { Memory }
