import { createMemoryGraph, MemoryGraph, InMemoryStore, LowdbStore, TIERS } from '../../src/infra/memory.js'
import { existsSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

async function run() {
  console.log('Graph memory tests')

  // 1. Add node + find
  {
    const g = await createMemoryGraph()
    const node = g.addNode({ label: '우리집' })
    assert(node.id !== undefined, 'addNode: has id')
    assert(node.label === '우리집', 'addNode: correct label')

    const found = g.findNode(node.id)
    assert(found.isJust(), 'findNode: returns Just')
    assert(found.value.label === '우리집', 'findNode: correct label')
  }

  // 2. Add edge + query
  {
    const g = await createMemoryGraph()
    const house = g.addNode({ label: '우리집' })
    const seoul = g.addNode({ label: '서울' })
    g.addEdge(house.id, seoul.id, '위치')

    const results = g.query({ from: house.id, relation: '위치' })
    assert(results.length === 1, 'query: 1 result')
    assert(results[0].label === '서울', 'query: correct target')
  }

  // 3. Multi-hop query (depth=2)
  {
    const g = await createMemoryGraph()
    const house = g.addNode({ label: '우리집' })
    const restaurantA = g.addNode({ label: 'A식당' })
    const restaurantB = g.addNode({ label: 'B식당' })
    const gangnam = g.addNode({ label: '서울 강남' })

    g.addEdge(house.id, restaurantA.id, '주변맛집')
    g.addEdge(house.id, restaurantB.id, '주변맛집')
    g.addEdge(restaurantA.id, gangnam.id, '위치')

    // depth=1: only direct neighbors
    const d1 = g.query({ from: house.id, relation: '주변맛집', depth: 1 })
    assert(d1.length === 2, 'depth=1: 2 restaurants')

    // depth=2: restaurants + their connections (without relation filter)
    const d2 = g.query({ from: house.id, depth: 2 })
    const labels = d2.map(n => n.label).sort()
    assert(labels.includes('A식당'), 'depth=2: includes A식당')
    assert(labels.includes('서울 강남'), 'depth=2: includes 서울 강남')
  }

  // 4. recall by text
  {
    const g = await createMemoryGraph()
    const house = g.addNode({ label: '우리집' })
    const restaurantA = g.addNode({ label: 'A식당' })
    g.addEdge(house.id, restaurantA.id, '주변맛집')

    const results = await g.recall('우리집 맛집')
    const labels = results.map(n => n.label)
    assert(labels.includes('우리집'), 'recall: includes 우리집')
    assert(labels.includes('A식당'), 'recall: includes connected A식당')
  }

  // 5. Tier management
  {
    const g = await createMemoryGraph()
    g.addNode({ label: 'working-data', tier: TIERS.WORKING })
    g.addNode({ label: 'past-chat', tier: TIERS.EPISODIC })
    g.addNode({ label: 'fact', tier: TIERS.SEMANTIC })

    assert(g.getNodesByTier(TIERS.WORKING).length === 1, 'tier: 1 working')
    assert(g.getNodesByTier(TIERS.SEMANTIC).length === 1, 'tier: 1 semantic')

    g.removeNodesByTier(TIERS.WORKING)
    assert(g.getNodesByTier(TIERS.WORKING).length === 0, 'removeByTier: working cleared')
    assert(g.allNodes().length === 2, 'removeByTier: others remain')
  }

  // 6. Promote node
  {
    const g = await createMemoryGraph()
    const node = g.addNode({ label: 'temp', tier: TIERS.EPISODIC })
    g.promoteNode(node.id, TIERS.SEMANTIC)
    assert(g.findNode(node.id).value.tier === TIERS.SEMANTIC, 'promote: episodic → semantic')
  }

  // 7. Persistence with lowdb
  {
    const dbPath = join(tmpdir(), `presence-mem-test-${Date.now()}`, 'graph.json')

    const g1 = await createMemoryGraph(dbPath)
    const n1 = g1.addNode({ label: 'persistent' })
    g1.addEdge(n1.id, n1.id, 'self')
    await g1.save()

    assert(existsSync(dbPath), 'persistence: file created')

    // Reload
    const g2 = await createMemoryGraph(dbPath)
    assert(g2.allNodes().length === 1, 'persistence: nodes restored')
    assert(g2.allNodes()[0].label === 'persistent', 'persistence: correct data')
    assert(g2.allEdges().length === 1, 'persistence: edges restored')

    rmSync(dirname(dbPath), { recursive: true, force: true })
  }

  // 8. Empty graph query
  {
    const g = await createMemoryGraph()
    const results = g.query({ from: 'nonexistent', relation: 'any' })
    assert(results.length === 0, 'empty query: returns []')
  }

  // 9. recall empty text
  {
    const g = await createMemoryGraph()
    assert((await g.recall('')).length === 0, 'recall empty: returns []')
    assert((await g.recall(null)).length === 0, 'recall null: returns []')
  }

  // --- Class API tests ---

  // 10. MemoryGraph.create() — 동기 생성 (in-memory)
  {
    const g = MemoryGraph.create()
    assert(g instanceof MemoryGraph, 'MemoryGraph.create: returns MemoryGraph instance')
    assert(g.store instanceof InMemoryStore, 'MemoryGraph.create: uses InMemoryStore')
    g.addNode({ label: 'test' })
    assert(g.allNodes().length === 1, 'MemoryGraph.create: operates normally')
  }

  // 11. MemoryGraph.fromFile() — async 생성 (lowdb)
  {
    const dbPath = join(tmpdir(), `presence-class-test-${Date.now()}`, 'graph.json')
    const g = await MemoryGraph.fromFile(dbPath)
    assert(g instanceof MemoryGraph, 'MemoryGraph.fromFile: returns MemoryGraph instance')
    assert(g.store instanceof LowdbStore, 'MemoryGraph.fromFile: uses LowdbStore')

    g.addNode({ label: 'persisted' })
    await g.save()

    // 같은 파일로 두 번째 인스턴스 — 데이터 복원
    const g2 = await MemoryGraph.fromFile(dbPath)
    assert(g2.allNodes()[0].label === 'persisted', 'MemoryGraph.fromFile: restores data')

    rmSync(dirname(dbPath), { recursive: true, force: true })
  }

  // 12. Store 교체: 같은 MemoryGraph에 다른 store strategy
  {
    const store = new InMemoryStore()
    store.data.nodes.push({ id: '1', label: 'preloaded', type: 'entity', data: {}, tier: 'semantic', createdAt: 0 })
    const g = new MemoryGraph(store)
    assert(g.findNode('1').value.label === 'preloaded', 'custom store: preloaded data accessible')
    const n = g.addNode({ label: 'new' })
    assert(Number(n.id) > 1, 'custom store: nextId continues from existing data')
  }

  // 13. 두 MemoryGraph 인스턴스가 독립적인 store를 가짐
  {
    const g1 = MemoryGraph.create()
    const g2 = MemoryGraph.create()
    g1.addNode({ label: 'only-in-g1' })
    assert(g1.allNodes().length === 1, 'isolation: g1 has 1 node')
    assert(g2.allNodes().length === 0, 'isolation: g2 has 0 nodes')
  }

  // 14. nodes/edges getters reflect mutations
  {
    const g = MemoryGraph.create()
    assert(g.nodes.length === 0, 'getter: initially empty')
    const n1 = g.addNode({ label: 'a' })
    const n2 = g.addNode({ label: 'b' })
    assert(g.nodes.length === 2, 'getter: reflects addNode')
    g.addEdge(n1.id, n2.id, 'rel')
    assert(g.edges.length === 1, 'getter: reflects addEdge')
    g.removeNodesByTier(TIERS.EPISODIC)
    assert(g.nodes.length === 0, 'getter: reflects removeNodesByTier')
    assert(g.edges.length === 0, 'getter: dangling edges cleaned')
  }

  // 15. recall: 오염된 label (null, 숫자, undefined) → 예외 없이 스킵
  {
    const store = new InMemoryStore()
    store.data.nodes.push(
      { id: '1', label: null, type: 'entity', data: {}, tier: 'episodic', createdAt: 0 },
      { id: '2', label: 42, type: 'entity', data: {}, tier: 'episodic', createdAt: 0 },
      { id: '3', label: undefined, type: 'entity', data: {}, tier: 'episodic', createdAt: 0 },
      { id: '4', label: 'valid node', type: 'entity', data: {}, tier: 'episodic', createdAt: 0 },
    )
    const g = new MemoryGraph(store)
    const results = await g.recall('valid')
    assert(results.length === 1, 'recall dirty labels: only valid node matched')
    assert(results[0].label === 'valid node', 'recall dirty labels: correct match')
  }

  // 16. recall: 숫자 label은 String 변환 후 매칭 가능
  {
    const g = MemoryGraph.create()
    g.addNode({ label: 404 })
    g.addNode({ label: 'error 404' })
    const results = await g.recall('404')
    assert(results.length === 2, 'recall numeric label: matched via String coercion')
  }

  // 17. 영속화 라운드트립: episodic 추가 → save → 재로드 → recall
  {
    const dbPath = join(tmpdir(), `presence-roundtrip-${Date.now()}`, 'graph.json')

    const g1 = await createMemoryGraph(dbPath)
    g1.addNode({ label: 'PR 현황', type: 'conversation', tier: TIERS.EPISODIC,
      data: { input: 'PR 현황', output: 'PR 3건' } })
    g1.addNode({ label: '회의록', type: 'conversation', tier: TIERS.EPISODIC,
      data: { input: '회의록', output: '안건 5개' } })
    g1.addNode({ label: 'temp', tier: TIERS.WORKING })
    g1.removeNodesByTier(TIERS.WORKING)
    await g1.save()

    // 재로드
    const g2 = await createMemoryGraph(dbPath)
    assert(g2.allNodes().length === 2, 'roundtrip: 2 episodic nodes survived')
    assert(g2.getNodesByTier(TIERS.WORKING).length === 0, 'roundtrip: working nodes not persisted')

    const recalled = await g2.recall('PR')
    assert(recalled.length === 1, 'roundtrip: recall works after reload')
    assert(recalled[0].data.output === 'PR 3건', 'roundtrip: data intact')

    rmSync(dirname(dbPath), { recursive: true, force: true })
  }

  // 18. findNode: 존재하지 않는 id → Nothing
  {
    const g = MemoryGraph.create()
    const notFound = g.findNode('nonexistent')
    assert(notFound.isNothing(), 'findNode missing: returns Nothing')
  }

  // --- 임베딩 통합 테스트 ---

  // 19. embedPending: 미임베딩 노드에 벡터 부여
  {
    const g = MemoryGraph.create()
    g.addNode({ label: 'hello', data: { input: 'hello', output: 'world' } })
    g.addNode({ label: 'test', data: {} })

    assert(g.allNodes().every(n => n.vector === null), 'embedPending before: all vectors null')

    const mockEmbedder = {
      embed: async (text) => [text.length * 0.1, 0.5],
      model: 'mock',
      dimensions: 2,
    }

    const count = await g.embedPending(mockEmbedder)
    assert(count === 2, 'embedPending: 2 nodes embedded')
    assert(g.allNodes().every(n => Array.isArray(n.vector)), 'embedPending after: all have vectors')
    assert(g.allNodes()[0].embeddingModel === 'mock', 'embedPending: model recorded')
    assert(g.allNodes()[0].embeddingDimensions === 2, 'embedPending: dimensions recorded')
    assert(g.allNodes()[0].embeddedAt != null, 'embedPending: timestamp recorded')
    assert(g.allNodes()[0].embeddingTextHash != null, 'embedPending: textHash recorded')
  }

  // 20. embedPending: 이미 임베딩된 노드는 건너뜀
  {
    const g = MemoryGraph.create()
    const node = g.addNode({ label: 'already' })
    node.vector = [0.1, 0.2]
    node.embeddingTextHash = '12345' // 실제 해시와 다름 → 재임베딩 대상

    let callCount = 0
    const embedder = { embed: async () => { callCount++; return [0.3, 0.4] }, model: 'm', dimensions: 2 }

    // textHash 불일치 → 재임베딩
    await g.embedPending(embedder)
    assert(callCount === 1, 'embedPending stale hash: re-embedded')
  }

  // 21. embedPending: embed 실패 시 건너뛰고 계속
  {
    const g = MemoryGraph.create()
    g.addNode({ label: 'fail' })
    g.addNode({ label: 'ok' })

    let callNum = 0
    const embedder = {
      embed: async () => {
        callNum++
        if (callNum === 1) throw new Error('API down')
        return [0.1]
      },
      model: 'm', dimensions: 1,
    }

    const count = await g.embedPending(embedder)
    assert(count === 1, 'embedPending failure: 1 succeeded, 1 skipped')
    assert(g.allNodes()[0].vector === null, 'embedPending failure: failed node still null')
    assert(g.allNodes()[1].vector != null, 'embedPending failure: second node embedded')
  }

  // 22. 하이브리드 recall: 벡터 + 키워드 병합
  {
    const g = MemoryGraph.create()
    const n1 = g.addNode({ label: '회의록', data: {} })
    const n2 = g.addNode({ label: 'PR 리뷰', data: {} })
    const n3 = g.addNode({ label: '점심 메뉴', data: {} })

    // n1, n2에 벡터 부여 (n3은 없음)
    n1.vector = [0.9, 0.1]
    n2.vector = [0.1, 0.9]
    n3.vector = null

    const embedder = { embed: async () => [0.85, 0.15], model: 'm', dimensions: 2 }

    // 벡터 검색: n1이 가장 유사 (0.9*0.85 + 0.1*0.15 = 0.78)
    // 키워드 검색: '회의' → n1 매칭
    const results = await g.recall('회의', { embedder })
    assert(results.length >= 1, 'hybrid recall: at least 1 result')
    assert(results[0].label === '회의록', 'hybrid recall: keyword+vector top match')
  }

  // 23. recall without embedder → 키워드만
  {
    const g = MemoryGraph.create()
    g.addNode({ label: 'keyword match' })
    const results = await g.recall('keyword')
    assert(results.length === 1, 'recall no embedder: keyword fallback works')
  }

  // 24. embedPending with null embedder → no-op
  {
    const g = MemoryGraph.create()
    g.addNode({ label: 'test' })
    const count = await g.embedPending(null)
    assert(count === 0, 'embedPending null: returns 0')
  }

  // 25. 차원 불일치 벡터는 검색에서 제외 (NaN 방지)
  {
    const g = MemoryGraph.create()
    const n1 = g.addNode({ label: 'old model' })
    const n2 = g.addNode({ label: 'new model' })
    n1.vector = [0.5, 0.5]           // 2d (구 모델)
    n2.vector = [0.9, 0.1, 0.0, 0.0] // 4d (신 모델)

    // 4d 쿼리 → 2d 노드는 제외, 4d 노드만 검색
    const embedder = { embed: async () => [0.8, 0.2, 0.0, 0.0], model: 'm', dimensions: 4 }
    const results = await g.recall('test', { embedder })

    // n1(2d)은 차원 불일치로 벡터 검색 대상에서 제외
    // n2(4d)만 벡터 검색에 포함
    const vectorMatched = results.filter(r => r.label === 'new model')
    assert(vectorMatched.length === 1, 'dim mismatch: compatible node found')

    // NaN이 결과에 없음 확인
    assert(results.every(r => r.label != null), 'dim mismatch: no corrupted results')
  }

  // 26. 모델 변경 시 기존 노드 재임베딩
  {
    const g = MemoryGraph.create()
    const node = g.addNode({ label: 'hello' })
    node.vector = [0.1, 0.2]
    node.embeddingModel = 'old-model'
    node.embeddingDimensions = 2
    node.embeddingTextHash = 'whatever'

    const newEmbedder = { embed: async () => [0.5, 0.5, 0.5], model: 'new-model', dimensions: 3 }
    const count = await g.embedPending(newEmbedder)

    assert(count === 1, 'model change: node re-embedded')
    assert(node.vector.length === 3, 'model change: new dimensions')
    assert(node.embeddingModel === 'new-model', 'model change: model updated')
  }

  // 27. 차원 변경 시 기존 노드 재임베딩
  {
    const g = MemoryGraph.create()
    const node = g.addNode({ label: 'test' })
    node.vector = [0.1, 0.2]
    node.embeddingModel = 'same-model'
    node.embeddingDimensions = 2
    node.embeddingTextHash = 'whatever'

    const embedder = { embed: async () => [0.3, 0.4, 0.5, 0.6], model: 'same-model', dimensions: 4 }
    const count = await g.embedPending(embedder)

    assert(count === 1, 'dim change: node re-embedded')
    assert(node.vector.length === 4, 'dim change: new vector length')
    assert(node.embeddingDimensions === 4, 'dim change: dimensions updated')
  }

  // 28. 모델/차원/텍스트 모두 동일 → 재임베딩 안 함
  {
    const g = MemoryGraph.create()
    const node = g.addNode({ label: 'stable' })
    node.vector = [0.9]
    node.embeddingModel = 'm'
    node.embeddingDimensions = 1

    // toEmbeddingText(node) = 'stable' → 그에 맞는 hash 설정
    const { textHash: th } = await import('../../src/infra/embedding.js')
    node.embeddingTextHash = th('stable')

    let called = false
    const embedder = { embed: async () => { called = true; return [0.1] }, model: 'm', dimensions: 1 }
    await g.embedPending(embedder)

    assert(!called, 'no change: embed not called')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
