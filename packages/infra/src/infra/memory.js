import { join } from 'node:path'
import { Config } from './config.js'

const DEFAULT_EMBED_MODEL = 'text-embedding-3-small'
const DEFAULT_EMBED_DIMS = 1536

const defaultMemoryPath = () => join(Config.presenceDir(), 'memory')

// =============================================================================
// Memory: mem0 기반 메모리. 서버 레벨 공유 인스턴스.
// 모든 메서드는 userId를 파라미터로 받아 멀티유저 격리.
// =============================================================================

class Memory {
  #mem0

  constructor(mem0) {
    this.#mem0 = mem0
  }

  // embed 자격증명 없으면 null 반환.
  static async create(config, opts = {}) {
    const { llm, embed } = config
    const embedApiKey = embed.apiKey || (embed.provider === 'openai' ? llm.apiKey : null)
    if (!embedApiKey && !embed.baseUrl) return null

    const memoryPath = config.memory.path || defaultMemoryPath()
    const { Memory: Mem0Memory } = await import('mem0ai/oss')
    const mem0Config = Memory.#buildMem0Config({ llm, embed, embedApiKey, memoryPath })
    return new Memory(new Mem0Memory(mem0Config))
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

  // --- 검색 ---

  async search(userId, input, limit = 10) {
    const result = await this.#mem0.search(input, { userId, limit })
    return (result.results || []).map(record => ({ label: record.memory }))
  }

  // --- 저장 ---

  async add(userId, userInput, assistantOutput) {
    await this.#mem0.add([
      { role: 'user', content: userInput },
      { role: 'assistant', content: assistantOutput || '' },
    ], { userId })
  }

  // --- 조회 ---

  async allNodes(userId) {
    try {
      const result = await this.#mem0.getAll({ userId })
      return (result.results || []).map(record => ({
        id: record.id,
        label: record.memory,
        createdAt: record.createdAt ? new Date(record.createdAt).getTime() : Date.now(),
      }))
    } catch (_) {
      return []
    }
  }

  // --- 삭제 ---

  async clearAll(userId) {
    const nodes = await this.allNodes(userId)
    const count = nodes.length
    if (count > 0) await this.#mem0.deleteAll({ userId }).catch(() => {})
    return count
  }

  async removeOlderThan(userId, maxAgeMs) {
    const nodes = await this.allNodes(userId)
    const cutoff = Date.now() - maxAgeMs
    const toDelete = nodes.filter(node => node.createdAt < cutoff)
    await Promise.all(toDelete.map(node => this.#mem0.delete(node.id).catch(() => {})))
    return toDelete.length
  }
}

export { Memory }
