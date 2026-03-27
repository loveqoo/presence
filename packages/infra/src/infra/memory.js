import { JSONFilePreset } from 'lowdb/node'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import fp from '@presence/core/lib/fun-fp.js'
import { dotSimilarity, topK, mergeSearchResults, textHash } from './embedding.js'

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

// --- Keyword tokenizer ---

const _tokenize = (text) =>
  text == null ? [] : String(text).toLowerCase().split(/\s+/).filter(k => k.length >= 2)

// --- MemoryGraph ---

class MemoryGraph {
  constructor(store) {
    this.store = store
    this._nextId = store.data.nodes.reduce(
      (max, n) => Math.max(max, Number(n.id) || 0), 0
    ) + 1
    this._index = new Map()     // term → Set<nodeId>
    this._nodeTerms = new Map() // nodeId → string[] (unindex용)
    for (const node of this.nodes) this._indexNode(node)
  }

  _indexNode(node) {
    const terms = _tokenize(node.label)
    if (terms.length === 0) return
    this._nodeTerms.set(node.id, terms)
    for (const term of terms) {
      if (!this._index.has(term)) this._index.set(term, new Set())
      this._index.get(term).add(node.id)
    }
  }

  _unindexNode(nodeId) {
    const terms = this._nodeTerms.get(nodeId)
    if (!terms) return
    for (const term of terms) {
      const set = this._index.get(term)
      if (set) {
        set.delete(nodeId)
        if (set.size === 0) this._index.delete(term)
      }
    }
    this._nodeTerms.delete(nodeId)
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

  addNode({ label, type = 'entity', data = {}, tier = TIERS.EPISODIC, expiresAt = null, source = null }) {
    const sourceHash = source ? textHash(source.tool + JSON.stringify(source.toolArgs || {})) : null

    // 출처 기반 dedup (source 있을 때): 같은 도구+인자 → 기존 노드 갱신
    if (sourceHash && tier !== TIERS.WORKING) {
      const existing = this.nodes.find(n => n.sourceHash === sourceHash && n.tier !== TIERS.WORKING)
      if (existing) {
        existing.label = label
        existing.data = data
        existing.expiresAt = expiresAt
        existing.createdAt = Date.now()
        existing.vector = null
        existing.embeddingTextHash = null
        return existing
      }
    }

    // 중복 방지: working 이외 티어에서 기존 노드 매칭 (label/data 해시)
    // source가 있으면 위 source dedup이 ID이므로 label dedup 건너뜀
    if (tier !== TIERS.WORKING && !source) {
      let existing
      const candidateHash = type === 'conversation'
        ? textHash(String(label))
        : textHash(String(label) + JSON.stringify(data))

      if (type === 'conversation') {
        existing = this.nodes.find(n =>
          n.type === type && n.tier !== TIERS.WORKING &&
          textHash(String(n.label)) === candidateHash
        )
      } else {
        existing = this.nodes.find(n =>
          n.type === type &&
          n.tier !== TIERS.WORKING &&
          textHash(String(n.label) + JSON.stringify(n.data)) === candidateHash
        )
      }
      if (existing) {
        existing.createdAt = Date.now()
        existing.expiresAt = expiresAt
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
      expiresAt,
      source,
      sourceHash,
      vector: null,
      embeddingModel: null,
      embeddingDimensions: null,
      embeddedAt: null,
      embeddingTextHash: null,
    }
    this.nodes.push(node)
    this._indexNode(node)
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

  // --- 키워드 검색 (벡터 검색 보조용) — 역인덱스 O(1) ---
  _keywordSearch(text) {
    const keywords = _tokenize(text)
    if (keywords.length === 0) return []
    const matched = new Set()
    for (const kw of keywords) {
      const nodeIds = this._index.get(kw)
      if (nodeIds) nodeIds.forEach(id => matched.add(id))
    }
    if (matched.size === 0) return []
    return [...matched]
      .map(id => this.nodes.find(n => n.id === id))
      .filter(Boolean)
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
    const now = Date.now()
    const isValid = n => !n.expiresAt || n.expiresAt > now
    const merged = mergeSearchResults(keywordResults, vectorResults)
    const topNodes = merged.filter(({ node }) => isValid(node)).slice(0, k).map(({ node }) => node)

    // 연결 노드 확장 (만료 노드 제외)
    const expanded = new Set(
      topNodes.flatMap(node => [node, ...this.query({ from: node.id, depth: 1 })])
    )

    return [...expanded].filter(isValid)
  }

  setVector(nodeId, { vector, model, dimensions, embeddedAt, textHash: hash }) {
    const node = this.nodes.find(n => n.id === nodeId)
    if (!node) return false
    node.vector = vector
    node.embeddingModel = model
    node.embeddingDimensions = dimensions
    node.embeddedAt = embeddedAt
    node.embeddingTextHash = hash
    return true
  }

  async save() {
    await this.store.save()
  }

  getNodesByTier(tier) {
    return this.nodes.filter(n => n.tier === tier)
  }

  // unindex + filter + orphan edge cleanup 공통 처리
  _removeMatchingNodes(predicate) {
    const before = this.nodes.length
    const keep = [], remove = []
    for (const node of this.nodes) (predicate(node) ? remove : keep).push(node)
    remove.forEach(n => this._unindexNode(n.id))
    this.store.data.nodes = keep
    const nodeIds = new Set(keep.map(n => n.id))
    this.store.data.edges = this.edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to))
    return before - keep.length
  }

  removeNodesByTier(tier) {
    this._removeMatchingNodes(n => n.tier === tier)
  }

  /** @param {(node) => boolean} predicate - true인 노드를 제거 */
  removeNodes(predicate) {
    return this._removeMatchingNodes(predicate)
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
    return this._removeMatchingNodes(n => {
      if (tier && n.tier !== tier) return false
      return (n.createdAt || 0) < cutoff
    })
  }

  // tier별 노드 수 제한: maxCount 초과 시 오래된 것부터 제거
  pruneByTier(tier, maxCount) {
    const tierNodes = this.nodes
      .filter(n => n.tier === tier)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    if (tierNodes.length <= maxCount) return 0
    const toRemoveIds = new Set(tierNodes.slice(0, tierNodes.length - maxCount).map(n => n.id))
    return this._removeMatchingNodes(n => toRemoveIds.has(n.id))
  }

  // 전체 삭제 (working 제외) — edges도 전부 초기화
  clearAll() {
    const before = this.nodes.length
    this.nodes.filter(n => n.tier !== TIERS.WORKING).forEach(n => this._unindexNode(n.id))
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
  return `${home}/.presence/memory`
}

export { MemoryGraph, InMemoryStore, LowdbStore, createMemoryGraph, TIERS, defaultMemoryPath }
