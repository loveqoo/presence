import { JSONFilePreset } from 'lowdb/node'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

const TIERS = { WORKING: 'working', EPISODIC: 'episodic', SEMANTIC: 'semantic' }

const createMemoryGraph = async (dbPath = null) => {
  const defaultData = { nodes: [], edges: [] }
  let db = null

  if (dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true })
    db = await JSONFilePreset(dbPath, defaultData)
  } else {
    // In-memory only (for tests)
    db = { data: { ...defaultData }, write: async () => {}, read: async () => {} }
  }

  let nextId = db.data.nodes.reduce((max, n) => Math.max(max, Number(n.id) || 0), 0) + 1

  const addNode = ({ label, type = 'entity', data = {}, tier = TIERS.EPISODIC }) => {
    const id = String(nextId++)
    const node = { id, label, type, data, tier, createdAt: Date.now() }
    db.data.nodes.push(node)
    return node
  }

  const addEdge = (fromId, toId, relation, data = {}) => {
    const edge = { from: fromId, to: toId, relation, data }
    db.data.edges.push(edge)
    return edge
  }

  const findNode = (id) => db.data.nodes.find(n => n.id === id) || null

  const findNodesByLabel = (label) => db.data.nodes.filter(n => n.label === label)

  const query = ({ from, relation, depth = 1 }) => {
    const results = new Set()
    const visited = new Set()
    const queue = [{ nodeId: from, currentDepth: 0 }]

    while (queue.length > 0) {
      const { nodeId, currentDepth } = queue.shift()
      if (currentDepth >= depth) continue
      if (visited.has(`${nodeId}-${currentDepth}`)) continue
      visited.add(`${nodeId}-${currentDepth}`)

      const matching = db.data.edges.filter(e => {
        if (e.from !== nodeId) return false
        return relation ? e.relation === relation : true
      })

      for (const edge of matching) {
        const target = findNode(edge.to)
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

  const recall = (text) => {
    if (!text) return []
    const keywords = text.toLowerCase().split(/\s+/)
    const matched = db.data.nodes.filter(n =>
      keywords.some(k => n.label.toLowerCase().includes(k))
    )

    // Also include connected nodes (1 hop)
    const related = new Set()
    for (const node of matched) {
      related.add(node)
      const connected = query({ from: node.id, depth: 1 })
      connected.forEach(n => related.add(n))
    }

    return [...related]
  }

  const save = async () => {
    if (db.write) await db.write()
  }

  const getNodesByTier = (tier) => db.data.nodes.filter(n => n.tier === tier)

  const removeNodesByTier = (tier) => {
    db.data.nodes = db.data.nodes.filter(n => n.tier !== tier)
    // Also remove edges referencing removed nodes
    const nodeIds = new Set(db.data.nodes.map(n => n.id))
    db.data.edges = db.data.edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to))
  }

  const promoteNode = (nodeId, newTier) => {
    const node = findNode(nodeId)
    if (node) node.tier = newTier
  }

  const allNodes = () => [...db.data.nodes]
  const allEdges = () => [...db.data.edges]

  return {
    addNode, addEdge, findNode, findNodesByLabel,
    query, recall, save,
    getNodesByTier, removeNodesByTier, promoteNode,
    allNodes, allEdges,
    TIERS,
  }
}

export { createMemoryGraph, TIERS }
