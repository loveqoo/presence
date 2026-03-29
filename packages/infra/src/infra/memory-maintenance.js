import { TIERS } from './memory.js'
import { MEMORY } from '@presence/core/core/policies.js'

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

/**
 * `findPromotionCandidates(memory)` — Finds episodic `conversation` nodes that cluster above the promotion threshold.
 * @param {object} memory - MemoryGraph instance.
 * @returns {Array<{ representative: object, duplicates: object[] }>}
 *
 * `applyPromotions(memory, candidates, logger?)` — Promotes representative nodes to semantic tier and removes duplicates.
 */
export {
  findPromotionCandidates,
  applyPromotions,
}
