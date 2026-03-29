import fp from '@presence/core/lib/fun-fp.js'

const { Either } = fp

// --- 순수 함수 ---

/**
 * Computes dot product similarity between two vectors (equivalent to cosine similarity for normalized vectors).
 * @param {number[]} a @param {number[]} b
 * @returns {number}
 */
// OpenAI 임베딩은 정규화됨 → dot product = cosine similarity
const dotSimilarity = (a, b) => {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

/**
 * Returns the top-k highest-scoring items from a scored array.
 * @param {Array<{ node: object, score: number }>} scored @param {number} k
 * @returns {Array<{ node: object, score: number }>}
 */
const topK = (scored, k) =>
  [...scored].sort((a, b) => b.score - a.score).slice(0, k)

/**
 * Derives the text to embed from a memory node (label + input + output joined).
 * @param {{ label: string, data?: { input?: string, output?: string } }} node
 * @returns {string}
 */
// 노드 → 임베딩 대상 텍스트 (무엇을 embed하는지 한 곳에서 결정)
const toEmbeddingText = (node) =>
  [node.label, node.data?.input, node.data?.output]
    .filter(Boolean)
    .join(' ')

/**
 * Fast djb2-based hash for change detection on embedding text.
 * @param {string} str
 * @returns {string} Base-36 hash string.
 */
// 텍스트 변경 감지용 해시
const textHash = (str) => {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/**
 * Merges keyword and vector search results, taking the max score for duplicates and sorting descending.
 * @param {Array<{ node: object, score: number }>} keywordScored
 * @param {Array<{ node: object, score: number }>} vectorScored
 * @returns {Array<{ node: object, score: number }>}
 */
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
  return [...merged.values()].sort((a, b) => b.score - a.score)
}

// --- Provider dispatch ---

// timeout 헬퍼
const fetchWithTimeout = async (_fetch, url, opts, timeoutMs = 30_000) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await _fetch(url, { ...opts, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

const providers = {
  openai: ({ apiKey, model, dimensions, baseUrl, fetchFn, timeoutMs = 30_000 }) => {
    const _fetch = fetchFn || globalThis.fetch
    const _model = model || 'text-embedding-3-small'
    const _baseUrl = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')

    const _key = apiKey || process.env.OPENAI_API_KEY || null

    return async (text) => {
      const body = { input: text, model: _model }
      if (dimensions) body.dimensions = dimensions
      const headers = { 'Content-Type': 'application/json' }
      if (_key) headers['Authorization'] = `Bearer ${_key}`
      const res = await fetchWithTimeout(_fetch, `${_baseUrl}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }, timeoutMs)
      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`Embedding API error ${res.status}: ${errText}`)
      }
      const data = await res.json()
      return data.data[0].embedding
    }
  },

  cohere: ({ apiKey, model, baseUrl, fetchFn, timeoutMs = 30_000 }) => {
    const _fetch = fetchFn || globalThis.fetch
    const _model = model || 'embed-v4.0'
    const _baseUrl = (baseUrl || 'https://api.cohere.com/v2').replace(/\/+$/, '')

    return async (text) => {
      const headers = { 'Content-Type': 'application/json' }
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      const res = await fetchWithTimeout(_fetch, `${_baseUrl}/embed`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          texts: [text],
          model: _model,
          input_type: 'search_query',
          embedding_types: ['float'],
        }),
      }, timeoutMs)
      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`Embedding API error ${res.status}: ${errText}`)
      }
      const data = await res.json()
      return data.embeddings.float[0]
    }
  },
}

// --- Embedder factory ---
// 설계 선택: dimensions 값 (예: 256)은 프로젝트가 결정하는 것이며,
// OpenAI 공식 문서에서 text-embedding-3-small + 256d를 직접 권장하는 것은 아닙니다.

/**
 * Creates an embedder that wraps a provider's embedding API or a custom embedFn.
 * @param {{ provider?: string, embedFn?: Function, model?: string, dimensions?: number, apiKey?: string, baseUrl?: string }} options
 * @returns {{ embed: (text: string) => Promise<number[]>, model: string, dimensions: number|null }}
 */
const createEmbedder = ({ provider = 'openai', embedFn, ...opts }) => {
  if (embedFn) {
    return { embed: embedFn, model: opts.model || 'custom', dimensions: opts.dimensions || null }
  }

  const factory = providers[provider]
  if (!factory) {
    throw new Error(`Unknown embedding provider: ${provider}`)
  }

  return {
    embed: factory(opts),
    model: opts.model || (provider === 'openai' ? 'text-embedding-3-small' : provider),
    dimensions: opts.dimensions || null,
  }
}

export {
  dotSimilarity, topK, toEmbeddingText, textHash, mergeSearchResults,
  createEmbedder, providers,
}
