import { join } from 'node:path'

// presence의 단일 사용자 에이전트 — 고정 userId
const MEM0_USER_ID = 'default'

// =============================================================================
// Memory: mem0 기반 메모리 + 동기 캐시 뷰.
// Write path: search()/add()로 mem0에 접근, add()/clearAll() 등에서 내부 캐시 갱신.
// Read path(UI/REPL): allNodes() 동기 호출로 캐시 조회.
//
// 주의: mem0는 tier 개념이 없는 flat memory. tier 필드는 UI 표시용 라벨.
// =============================================================================

class Memory {
  constructor(mem0) {
    this.mem0 = mem0
    this.cache = []
  }

  // mem0 인스턴스 생성 + 초기 캐시 로드. embed 자격증명 없으면 null.
  static async create(config, opts = {}) {
    const { memoryPath } = opts
    const { llm, embed } = config
    const embedApiKey = embed.apiKey || (embed.provider === 'openai' ? llm.apiKey : null)
    if (!embedApiKey && !embed.baseUrl) return null

    const { Memory: Mem0Memory } = await import('mem0ai/oss')
    const mem0 = new Mem0Memory({
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

    const memory = new Memory(mem0)
    await memory.refreshCache()
    return memory
  }

  // --- Write path ---

  // 유사 메모리 검색. 반환: [{ label }]
  async search(input, limit = 10) {
    const result = await this.mem0.search(input, { userId: MEM0_USER_ID, limit })
    return (result.results || []).map(r => ({ label: r.memory }))
  }

  // 대화 턴 저장 + 캐시 동기화
  async add(userInput, assistantOutput) {
    await this.mem0.add([
      { role: 'user', content: userInput },
      { role: 'assistant', content: assistantOutput || '' },
    ], { userId: MEM0_USER_ID })
    await this.refreshCache()
  }

  // --- Read path (동기 캐시) ---

  async refreshCache() {
    try {
      const result = await this.mem0.getAll({ userId: MEM0_USER_ID })
      this.cache = (result.results || []).map(r => ({
        id: r.id,
        label: r.memory,
        type: 'fact',
        tier: 'episodic',
        createdAt: r.createdAt ? new Date(r.createdAt).getTime() : Date.now(),
      }))
    } catch (_) {}
  }

  allNodes() { return this.cache }

  clearAll() {
    const count = this.cache.length
    this.cache = []
    this.mem0.reset().catch(() => {})
    return count
  }

  removeOlderThan(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs
    const toDelete = this.cache.filter(n => n.createdAt < cutoff)
    this.cache = this.cache.filter(n => n.createdAt >= cutoff)
    Promise.all(toDelete.map(n => this.mem0.delete(n.id).catch(() => {}))).catch(() => {})
    return toDelete.length
  }
}

export { Memory }
