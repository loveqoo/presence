import { JSONFilePreset } from 'lowdb/node'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

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
    const id = String(this._nextId++)
    const node = { id, label, type, data, tier, createdAt: Date.now() }
    this.nodes.push(node)
    return node
  }

  addEdge(fromId, toId, relation, data = {}) {
    const edge = { from: fromId, to: toId, relation, data }
    this.edges.push(edge)
    return edge
  }

  findNode(id) {
    return this.nodes.find(n => n.id === id) || null
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

        const target = this.findNode(edge.to)
        if (target) {
          results.add(target)
          if (currentDepth + 1 < depth) {
            queue.push({ nodeId: edge.to, currentDepth: currentDepth + 1 })
          }
        }
      }
    }

    return [...results]
  }

  recall(text) {
    if (!text) return []
    const keywords = text.toLowerCase().split(/\s+/)
    const matched = this.nodes.filter(n => {
      if (n.label == null) return false
      const label = String(n.label).toLowerCase()
      return keywords.some(k => label.includes(k))
    })

    const related = new Set()
    for (const node of matched) {
      related.add(node)
      for (const n of this.query({ from: node.id, depth: 1 })) {
        related.add(n)
      }
    }

    return [...related]
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

  promoteNode(nodeId, newTier) {
    const node = this.findNode(nodeId)
    if (node) node.tier = newTier
  }

  allNodes() { return [...this.nodes] }
  allEdges() { return [...this.edges] }
}

// --- 하위 호환: createMemoryGraph 팩토리 ---
const createMemoryGraph = async (dbPath = null) => {
  return dbPath ? MemoryGraph.fromFile(dbPath) : MemoryGraph.create()
}

export { MemoryGraph, InMemoryStore, LowdbStore, createMemoryGraph, TIERS }
