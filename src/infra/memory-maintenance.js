import { TIERS } from './memory.js'
import { PHASE, RESULT } from '../core/agent.js'
import { MEMORY } from '../core/policies.js'

// --- Semantic Promotion (FP pipeline) ---

// 텍스트 → 정규화된 키워드 집합 (bigram 기반 유사도용)
const bigrams = (str) => {
  const s = String(str).toLowerCase().replace(/\s+/g, '')
  const set = new Set()
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  return set
}

const jaccardSimilarity = (a, b) => {
  const intersection = [...a].filter(x => b.has(x)).length
  const union = new Set([...a, ...b]).size
  return union === 0 ? 0 : intersection / union
}

// 유사도 기반 클러스터링
const clusterBySimilarity = (nodes, threshold = 0.4) => {
  const clusters = []
  const assigned = new Set()
  for (let i = 0; i < nodes.length; i++) {
    if (assigned.has(i)) continue
    const cluster = [nodes[i]]
    assigned.add(i)
    const bg1 = bigrams(nodes[i].label)
    for (let j = i + 1; j < nodes.length; j++) {
      if (assigned.has(j)) continue
      if (jaccardSimilarity(bg1, bigrams(nodes[j].label)) >= threshold) {
        cluster.push(nodes[j])
        assigned.add(j)
      }
    }
    clusters.push(cluster)
  }
  return clusters
}

// 승격 파이프라인: episodic 노드 → 유사 클러스터 → threshold 이상 → 대표 노드 승격
const findPromotionCandidates = (memory) => {
  const episodic = memory.getNodesByTier(TIERS.EPISODIC)
    .filter(n => n.type === 'conversation')
  return clusterBySimilarity(episodic)
    .filter(cluster => cluster.length >= MEMORY.PROMOTION_THRESHOLD)
    .map(cluster => {
      const sorted = cluster.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      return { representative: sorted[0], duplicates: sorted.slice(1) }
    })
}

const applyPromotions = (memory, candidates, logger) => {
  for (const { representative, duplicates } of candidates) {
    memory.promoteNode(representative.id, TIERS.SEMANTIC)
    // 중복 노드 + 고아 엣지 정리
    const dupIds = new Set(duplicates.map(n => n.id))
    memory.removeNodes(n => dupIds.has(n.id))
    if (logger) logger.info('Memory promoted', {
      label: representative.label,
      merged: duplicates.length,
    })
  }
}

// --- Wire functions ---

// [Turn lifecycle] WORKING에서 recall, IDLE에서 episodic save + working cleanup
const wireMemoryHooks = ({ state, memory, embedder, logger }) => {
  // WORKING hook: recall은 fire-and-forget (hook chain을 blocking하지 않음)
  state.hooks.on('turnState', (phase, s) => {
    if (phase.tag !== PHASE.WORKING || !phase.input) return
    memory.recall(phase.input, { embedder, logger })
      .then(memories => {
        s.set('context.memories', memories.map(n => n.label))
        s.set('_debug.recalledMemories', memories.map(n => ({
          label: n.label, type: n.type, tier: n.tier,
          createdAt: n.createdAt, embeddedAt: n.embeddedAt,
        })))
        s.set('turn', (s.get('turn') || 0) + 1)
      })
      .catch(e => {
        if (logger) logger.warn('Memory recall failed', { error: e.message })
      })
  })

  // IDLE hook: sync 작업(addNode) 즉시 실행, async I/O(save/embed)는 fire-and-forget
  state.hooks.on('turnState', (phase, s) => {
    if (phase.tag !== PHASE.IDLE) return
    memory.removeNodesByTier(TIERS.WORKING)
    const lastTurn = s.get('lastTurn')
    if (lastTurn && lastTurn.tag === RESULT.SUCCESS) {
      memory.addNode({
        label: lastTurn.input || 'unknown',
        type: 'conversation',
        tier: TIERS.EPISODIC,
        data: { input: lastTurn.input, output: lastTurn.result },
      })
    }
    memory.save()
      .then(() => memory.embedPending(embedder, { logger }))
      .catch(e => {
        if (logger) logger.warn('Memory save/embed failed', { error: e.message })
      })
  })
}

// [Background maintenance] IDLE에서 pruning + semantic promotion
const wireMemoryMaintenance = ({ state, memory, logger }) => {
  state.hooks.on('turnState', (phase) => {
    if (phase.tag !== PHASE.IDLE) return

    // 1. Episodic memory pruning
    const pruned = memory.pruneByTier(TIERS.EPISODIC, MEMORY.MAX_EPISODIC)
    if (pruned > 0) {
      if (logger) logger.info(`Memory pruned: ${pruned} old episodic nodes removed`)
    }

    // 2. Semantic promotion
    const candidates = findPromotionCandidates(memory)
    if (candidates.length > 0) {
      applyPromotions(memory, candidates, logger)
    }

    // save if any changes
    if (pruned > 0 || candidates.length > 0) {
      memory.save().catch(e => {
        if (logger) logger.warn('Memory maintenance save failed', { error: e.message })
      })
    }
  })
}

export {
  wireMemoryHooks,
  wireMemoryMaintenance,
  findPromotionCandidates,
  applyPromotions,
}
