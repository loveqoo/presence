import {
  dotSimilarity, topK, toEmbeddingText, textHash, mergeSearchResults, createEmbedder,
} from '../../src/infra/embedding.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

async function run() {
  console.log('Embedding tests')

  // --- dotSimilarity ---

  {
    // 동일 벡터 → 1.0
    assert(Math.abs(dotSimilarity([1, 0, 0], [1, 0, 0]) - 1.0) < 0.001, 'dot: identical → 1.0')
    // 직교 → 0.0
    assert(Math.abs(dotSimilarity([1, 0], [0, 1])) < 0.001, 'dot: orthogonal → 0.0')
    // 반대 → -1.0
    assert(Math.abs(dotSimilarity([1, 0], [-1, 0]) + 1.0) < 0.001, 'dot: opposite → -1.0')
  }

  // --- topK ---

  {
    const items = [
      { id: 'a', score: 0.3 },
      { id: 'b', score: 0.9 },
      { id: 'c', score: 0.6 },
      { id: 'd', score: 0.1 },
    ]
    const result = topK(items, 2)
    assert(result.length === 2, 'topK: returns k items')
    assert(result[0].id === 'b', 'topK: highest first')
    assert(result[1].id === 'c', 'topK: second highest')
  }

  {
    const result = topK([{ score: 0.5 }], 10)
    assert(result.length === 1, 'topK: fewer than k → returns all')
  }

  // --- toEmbeddingText ---

  {
    const node = { label: 'PR 현황', data: { input: 'PR 현황', output: 'PR 3건' } }
    assert(toEmbeddingText(node) === 'PR 현황 PR 현황 PR 3건', 'toEmbeddingText: label + input + output')
  }

  {
    const node = { label: '엔티티', data: {} }
    assert(toEmbeddingText(node) === '엔티티', 'toEmbeddingText: label only')
  }

  {
    const node = { label: null, data: { input: 'hello' } }
    assert(toEmbeddingText(node) === 'hello', 'toEmbeddingText: null label skipped')
  }

  // --- textHash ---

  {
    assert(textHash('hello') === textHash('hello'), 'textHash: deterministic')
    assert(textHash('hello') !== textHash('world'), 'textHash: different texts → different hashes')
    assert(typeof textHash('test') === 'string', 'textHash: returns string')
  }

  // --- mergeSearchResults ---

  {
    const keyword = [
      { node: { id: '1' }, score: 1.0 },
      { node: { id: '2' }, score: 1.0 },
    ]
    const vector = [
      { node: { id: '2' }, score: 0.8 },
      { node: { id: '3' }, score: 0.9 },
    ]
    const merged = mergeSearchResults(keyword, vector)
    assert(merged.length === 3, 'merge: union of 3 unique nodes')
    assert(merged[0].node.id === '1' || merged[0].node.id === '2', 'merge: score 1.0 nodes first')

    const node2 = merged.find(m => m.node.id === '2')
    assert(node2.score === 1.0, 'merge: overlapping node keeps higher score')
  }

  {
    const merged = mergeSearchResults([], [])
    assert(merged.length === 0, 'merge: empty inputs → empty')
  }

  // --- createEmbedder with custom embedFn ---

  {
    const embedder = createEmbedder({
      embedFn: async (text) => [0.1, 0.2, 0.3],
      model: 'mock',
      dimensions: 3,
    })
    assert(embedder.model === 'mock', 'createEmbedder custom: model')
    assert(embedder.dimensions === 3, 'createEmbedder custom: dimensions')

    const vec = await embedder.embed('test')
    assert(vec.length === 3, 'createEmbedder custom: embed returns vector')
    assert(vec[0] === 0.1, 'createEmbedder custom: correct values')
  }

  // --- createEmbedder with mock fetch (openai provider) ---

  {
    const mockFetch = async (url, opts) => {
      const body = JSON.parse(opts.body)
      return {
        ok: true,
        json: async () => ({
          data: [{ embedding: Array(body.dimensions || 1536).fill(0.01) }]
        }),
      }
    }
    const embedder = createEmbedder({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'text-embedding-3-small',
      dimensions: 256,
      fetchFn: mockFetch,
    })
    assert(embedder.model === 'text-embedding-3-small', 'openai provider: model')
    assert(embedder.dimensions === 256, 'openai provider: dimensions')

    const vec = await embedder.embed('hello')
    assert(vec.length === 256, 'openai provider: vector length matches dimensions')
  }

  // --- createEmbedder API error ---

  {
    const mockFetch = async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    })
    const embedder = createEmbedder({ provider: 'openai', apiKey: 'bad', fetchFn: mockFetch })
    try {
      await embedder.embed('test')
      assert(false, 'openai error: should throw')
    } catch (e) {
      assert(e.message.includes('401'), 'openai error: status in message')
    }
  }

  // --- createEmbedder unknown provider ---

  {
    try {
      createEmbedder({ provider: 'unknown' })
      assert(false, 'unknown provider: should throw')
    } catch (e) {
      assert(e.message.includes('unknown'), 'unknown provider: error message')
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
