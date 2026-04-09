// OpenAI 임베딩은 정규화됨 → dot product = cosine similarity
const dotSimilarity = (vecA, vecB) => {
  let dot = 0
  for (let idx = 0; idx < vecA.length; idx++) dot += vecA[idx] * vecB[idx]
  return dot
}

const topK = (scored, limit) =>
  [...scored].sort((first, second) => second.score - first.score).slice(0, limit)

// 노드 → 임베딩 대상 텍스트 (무엇을 embed하는지 한 곳에서 결정)
const toEmbeddingText = (node) =>
  [node.label, node.data?.input, node.data?.output]
    .filter(Boolean)
    .join(' ')

// 텍스트 변경 감지용 해시
const textHash = (str) => {
  let hash = 5381
  for (let idx = 0; idx < str.length; idx++) hash = ((hash << 5) + hash + str.charCodeAt(idx)) | 0
  return (hash >>> 0).toString(36)
}

// 벡터 검색 + 키워드 검색 병합 (합집합, 높은 점수 우선)
const mergeSearchResults = (keywordScored, vectorScored) => {
  const merged = new Map()
  for (const { node, score } of keywordScored) {
    merged.set(node.id, { node, score })
  }
  for (const { node, score } of vectorScored) {
    const existing = merged.get(node.id)
    if (existing) {
      existing.score = Math.max(existing.score, score)
    } else {
      merged.set(node.id, { node, score })
    }
  }
  return [...merged.values()].sort((first, second) => second.score - first.score)
}

export { dotSimilarity, topK, toEmbeddingText, textHash, mergeSearchResults }
