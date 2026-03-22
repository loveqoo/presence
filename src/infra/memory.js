import { JSONFilePreset } from 'lowdb/node'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import fp from '../lib/fun-fp.js'
import { dotSimilarity, topK, toEmbeddingText, textHash, mergeSearchResults } from './embedding.js'

const { Maybe } = fp

const TIERS = { WORKING: 'working', EPISODIC: 'episodic', SEMANTIC: 'semantic' }

// --- Storage strategies ---

class InMemoryStore {
  constructor() {
    this.data = { nodes: [], edges: [] }
  }
  async save() {}
}

class LowdbStore {
  constructor(db) {
    this.data = db.data
    this._db = db
  }
  async save() {
    await this._db.write()
  }
  static async create(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = await JSONFilePreset(dbPath, { nodes: [], edges: [] })
    return new LowdbStore(db)
  }
}

// --- MemoryGraph ---

class MemoryGraph {
  constructor(store) {
    this.store = store
    this._nextId = store.data.nodes.reduce(
      (max, n) => Math.max(max, Number(n.id) || 0), 0
    ) + 1
  }

  static create() {
    return new MemoryGraph(new InMemoryStore())
  }

  static async fromFile(dbPath) {
    const store = await LowdbStore.create(dbPath)
    return new MemoryGraph(store)
  }

  get nodes() { return this.store.data.nodes }
  get edges() { return this.store.data.edges }

  addNode({ label, type = 'entity', data = {}, tier = TIERS.EPISODIC }) {
    // 중복 방지: working 이외 티어에서 기존 노드 매칭
    if (tier !== TIERS.WORKING) {
      let existing
      const candidateHash = type === 'conversation'
        ? textHash(String(label))
        : textHash(String(label) + JSON.stringify(data))

      if (type === 'conversation') {
        // 대화: 같은 입력(label) 해시면 동일 기억 → 최신 응답으로 갱신
        existing = this.nodes.find(n =>
          n.type === type && n.tier !== TIERS.WORKING &&
          textHash(String(n.label)) === candidateHash
        )
      } else {
        // 그 외: label + 전체 data 해시 비교
        existing = this.nodes.find(n =>
          n.type === type &&
          n.tier !== TIERS.WORKING &&
          textHash(String(n.label) + JSON.stringify(n.data)) === candidateHash
        )
      }
      if (existing) {
        existing.createdAt = Date.now()
        if (type === 'conversation') {
          existing.data = data
          existing.vector = null
          existing.embeddingTextHash = null
        }
        return existing
      }
    }

    const id = String(this._nextId++)
    const node = {
      id, label, type, data, tier, createdAt: Date.now(),
      // 임베딩 필드 (저장 후 비동기 보강)
      vector: null,
      embeddingModel: null,
      embeddingDimensions: null,
      embeddedAt: null,
      embeddingTextHash: null,
    }
    this.nodes.push(node)
    return node
  }

  addEdge(fromId, toId, relation, data = {}) {
    const edge = { from: fromId, to: toId, relation, data }
    this.edges.push(edge)
    return edge
  }

  findNode(id) {
    return Maybe.fromNullable(this.nodes.find(n => n.id === id))
  }

  findNodesByLabel(label) {
    return this.nodes.filter(n => n.label === label)
  }

  query({ from, relation, depth = 1 }) {
    const results = new Set()
    const visited = new Set()
    const queue = [{ nodeId: from, currentDepth: 0 }]

    while (queue.length > 0) {
      const { nodeId, currentDepth } = queue.shift()
      if (currentDepth >= depth) continue
      if (visited.has(`${nodeId}-${currentDepth}`)) continue
      visited.add(`${nodeId}-${currentDepth}`)

      for (const edge of this.edges) {
        if (edge.from !== nodeId) continue
        if (relation && edge.relation !== relation) continue

        Maybe.fold(
          () => {},
          target => {
            results.add(target)
            if (currentDepth + 1 < depth) {
              queue.push({ nodeId: edge.to, currentDepth: currentDepth + 1 })
            }
          },
          this.findNode(edge.to),
        )
      }
    }

    return [...results]
  }

  // --- 키워드 검색 (벡터 검색 보조용) ---
  _keywordSearch(text) {
    const keywords = text.toLowerCase().split(/\s+/).filter(k => k.length >= 2)
    if (keywords.length === 0) return []
    return this.nodes
      .filter(n => {
        if (n.label == null) return false
        const label = String(n.label).toLowerCase()
        return keywords.some(k => label.includes(k))
      })
      .map(node => ({ node, score: 1.0 }))
  }

  // --- 벡터 검색 (dot similarity) ---
  // 차원 불일치 노드는 제외 (모델/차원 변경 시 NaN 방지)
  _vectorSearch(queryVec, k) {
    const dim = queryVec.length
    const compatible = this.nodes.filter(n =>
      Array.isArray(n.vector) && n.vector.length === dim
    )
    if (compatible.length === 0) return []
    const scored = compatible.map(node => ({ node, score: dotSimilarity(queryVec, node.vector) }))
    return topK(scored, k)
  }

  // --- recall ---
  // embedder 없으면 recall 비활성 (키워드 단독 검색은 오히려 해로움)
  async recall(text, { embedder, topK: k = 10, logger } = {}) {
    if (!text) return []
    if (!embedder) return []

    let vectorResults = []
    try {
      const queryVec = await embedder.embed(text)
      vectorResults = this._vectorSearch(queryVec, k)
    } catch (e) {
      if (logger) logger.warn('Embedding recall failed', { error: e.message })
      return []
    }

    // 벡터 결과를 키워드로 보강 (벡터가 있을 때만)
    const keywordResults = this._keywordSearch(text)
    const merged = mergeSearchResults(keywordResults, vectorResults)
    const topNodes = merged.slice(0, k).map(({ node }) => node)

    // 연결 노드 확장
    const expanded = new Set(
      topNodes.flatMap(node => [node, ...this.query({ from: node.id, depth: 1 })])
    )

    return [...expanded]
  }

  // --- 미임베딩 노드 보강 ---
  async embedPending(embedder, { logger } = {}) {
    if (!embedder) return 0

    const needsEmbedding = (n) => {
      if (n.vector == null) return true
      // 모델 또는 차원 변경 → 재임베딩
      if (n.embeddingModel !== embedder.model) return true
      if (embedder.dimensions && n.embeddingDimensions !== embedder.dimensions) return true
      // 텍스트 변경 → 재임베딩
      return n.embeddingTextHash !== textHash(toEmbeddingText(n))
    }

    const pending = this.nodes.filter(needsEmbedding)

    let count = 0
    for (const node of pending) {
      const text = toEmbeddingText(node)
      try {
        node.vector = await embedder.embed(text)
        node.embeddingModel = embedder.model
        node.embeddingDimensions = embedder.dimensions
        node.embeddedAt = Date.now()
        node.embeddingTextHash = textHash(text)
        count++
      } catch (e) {
        if (logger) logger.warn('Embedding failed for node', { nodeId: node.id, error: e.message })
      }
    }

    if (count > 0) await this.save()
    return count
  }

  async save() {
    await this.store.save()
  }

  getNodesByTier(tier) {
    return this.nodes.filter(n => n.tier === tier)
  }

  removeNodesByTier(tier) {
    this.store.data.nodes = this.nodes.filter(n => n.tier !== tier)
    const nodeIds = new Set(this.nodes.map(n => n.id))
    this.store.data.edges = this.edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to))
  }

  /** @param {(node) => boolean} predicate - true인 노드를 제거 */
  removeNodes(predicate) {
    const before = this.nodes.length
    this.store.data.nodes = this.nodes.filter(n => !predicate(n))
    const nodeIds = new Set(this.nodes.map(n => n.id))
    this.store.data.edges = this.edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to))
    return before - this.nodes.length
  }

  promoteNode(nodeId, newTier) {
    Maybe.fold(
      () => {},
      node => { node.tier = newTier },
      this.findNode(nodeId),
    )
  }

  // age 기반 삭제: maxAgeMs보다 오래된 노드 제거. tier 필터 선택적.
  removeOlderThan(maxAgeMs, { tier } = {}) {
    const cutoff = Date.now() - maxAgeMs
    const before = this.nodes.length
    this.store.data.nodes = this.nodes.filter(n => {
      if (tier && n.tier !== tier) return true
      return (n.createdAt || 0) >= cutoff
    })
    // 고아 엣지 정리
    const nodeIds = new Set(this.nodes.map(n => n.id))
    this.store.data.edges = this.edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to))
    return before - this.nodes.length
  }

  // tier별 노드 수 제한: maxCount 초과 시 오래된 것부터 제거
  pruneByTier(tier, maxCount) {
    const tierNodes = this.nodes
      .filter(n => n.tier === tier)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    if (tierNodes.length <= maxCount) return 0
    const toRemove = new Set(tierNodes.slice(0, tierNodes.length - maxCount).map(n => n.id))
    const before = this.nodes.length
    this.store.data.nodes = this.nodes.filter(n => !toRemove.has(n.id))
    const nodeIds = new Set(this.nodes.map(n => n.id))
    this.store.data.edges = this.edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to))
    return before - this.nodes.length
  }

  // 전체 삭제 (working 제외)
  clearAll() {
    const before = this.nodes.length
    this.store.data.nodes = this.nodes.filter(n => n.tier === TIERS.WORKING)
    this.store.data.edges = []
    return before - this.nodes.length
  }

  allNodes() { return [...this.nodes] }
  allEdges() { return [...this.edges] }
}

const createMemoryGraph = async (dbPath = null) => {
  return dbPath ? MemoryGraph.fromFile(dbPath) : MemoryGraph.create()
}

const defaultMemoryPath = () => {
  const home = process.env.HOME || process.env.USERPROFILE || '.'
  return `${home}/.presence/memory/graph.json`
}

export { MemoryGraph, InMemoryStore, LowdbStore, createMemoryGraph, TIERS, defaultMemoryPath }
