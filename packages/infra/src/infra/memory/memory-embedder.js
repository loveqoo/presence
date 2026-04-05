import { toEmbeddingText, textHash } from '../embedding.js'

const needsEmbedding = (node, embedder) => {
  if (node.vector == null) return true
  if (node.embeddingModel !== embedder.model) return true
  if (embedder.dimensions && node.embeddingDimensions !== embedder.dimensions) return true
  return node.embeddingTextHash !== textHash(toEmbeddingText(node))
}

const createMemoryEmbedder = (embedder, { concurrency = 3 } = {}) => {
  const embedNodes = async (pending, graph, { logger } = {}) => {
    if (!embedder || pending.length === 0) return 0
    let count = 0

    for (let i = 0; i < pending.length; i += concurrency) {
      const batch = pending.slice(i, i + concurrency)
      const results = await Promise.allSettled(
        batch.map(async (node) => {
          const text = toEmbeddingText(node)
          const vector = await embedder.embed(text)
          return { node, vector, text }
        })
      )
      for (let j = 0; j < results.length; j++) {
        const result = results[j]
        if (result.status === 'fulfilled') {
          const { node, vector, text } = result.value
          graph.setVector(node.id, {
            vector,
            model: embedder.model,
            dimensions: embedder.dimensions,
            embeddedAt: Date.now(),
            textHash: textHash(text),
          })
          count++
        } else {
          if (logger) logger.warn('Embedding failed for node', { nodeId: batch[j].id, error: result.reason?.message })
        }
      }
    }

    if (count > 0) await graph.save()
    return count
  }

  return {
    // needsEmbedding: node 단위 검사 (Actor 메시지 경계 스냅샷용)
    needsEmbedding: (node) => embedder ? needsEmbedding(node, embedder) : false,
    // embedNodes: 미리 캡처된 nodes 배열로 임베딩 (Actor에서 직접 사용)
    embedNodes,
    async embedPending(graph, { logger } = {}) {
      if (!embedder) return 0
      const pending = graph.allNodes().filter(n => needsEmbedding(n, embedder))
      return embedNodes(pending, graph, { logger })
    },
  }
}

/**
 * `createMemoryEmbedder(embedder, opts?)` — Wraps an embedder with batched embedding logic for MemoryGraph nodes.
 * Returns `{ needsEmbedding, embedNodes, embedPending }`.
 * @param {{ embed: Function, model: string, dimensions?: number }} embedder
 * @param {{ concurrency?: number }} [opts]
 *
 * `needsEmbedding(node, embedder)` — Returns true if the node lacks a vector or its embedding is stale.
 */
export { createMemoryEmbedder, needsEmbedding }
