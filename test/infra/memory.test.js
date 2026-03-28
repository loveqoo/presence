import { createMemoryGraph, MemoryGraph, InMemoryStore, LowdbStore, TIERS } from '@presence/infra/infra/memory.js'
import { createMemoryEmbedder } from '@presence/infra/infra/memory-embedder.js'
import { existsSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { assert, summary } from '../lib/assert.js'

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

  // 4. recall without embedder → empty (키워드 단독 검색 비활성)
  {
    const g = await createMemoryGraph()
    g.addNode({ label: '우리집' })
    g.addNode({ label: 'A식당' })

    const results = await g.recall('우리집 맛집')
    assert(results.length === 0, 'recall no embedder: returns empty')
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
    assert(results.length === 0, 'recall dirty labels: no embedder → empty')
  }

  // 16. recall without embedder → empty
  {
    const g = MemoryGraph.create()
    g.addNode({ label: 404 })
    g.addNode({ label: 'error 404' })
    const results = await g.recall('404')
    assert(results.length === 0, 'recall no embedder: returns empty')
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
    assert(recalled.length === 0, 'roundtrip: no recall without embedder')
    // data 무결성은 allNodes로 직접 확인
    const prNode = g2.allNodes().find(n => n.label === 'PR 현황')
    assert(prNode && prNode.data.output === 'PR 3건', 'roundtrip: data intact')

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

    const count = await createMemoryEmbedder(mockEmbedder).embedPending(g)
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
    await createMemoryEmbedder(embedder).embedPending(g)
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

    const count = await createMemoryEmbedder(embedder).embedPending(g)
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
    // 키워드 검색: '회의'는 정확 term — '회의록'(다른 term)은 미매칭, 벡터로 보강
    const results = await g.recall('회의', { embedder })
    assert(results.length >= 1, 'hybrid recall: at least 1 result')
    assert(results[0].label === '회의록', 'hybrid recall: keyword+vector top match')
  }

  // 23. recall without embedder → 키워드만
  {
    const g = MemoryGraph.create()
    g.addNode({ label: 'keyword match' })
    const results = await g.recall('keyword')
    assert(results.length === 0, 'recall no embedder: returns empty')
  }

  // 24. embedPending with null embedder → no-op
  {
    const g = MemoryGraph.create()
    g.addNode({ label: 'test' })
    const count = await createMemoryEmbedder(null).embedPending(g)
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
    const count = await createMemoryEmbedder(newEmbedder).embedPending(g)

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
    const count = await createMemoryEmbedder(embedder).embedPending(g)

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
    const { textHash: th } = await import('@presence/infra/infra/embedding.js')
    node.embeddingTextHash = th('stable')

    let called = false
    const embedder = { embed: async () => { called = true; return [0.1] }, model: 'm', dimensions: 1 }
    await createMemoryEmbedder(embedder).embedPending(g)

    assert(!called, 'no change: embed not called')
  }

  // --- 중복 방지 (dedup) ---

  // 29. 동일 내용 addNode → 새 노드 생성 안 함, 기존 노드 반환
  {
    const g = MemoryGraph.create()
    const n1 = g.addNode({ label: 'PR 현황', type: 'conversation', tier: TIERS.EPISODIC,
      data: { input: 'PR 현황', output: 'PR 3건' } })
    const before = n1.createdAt

    await new Promise(r => setTimeout(r, 10))

    const n2 = g.addNode({ label: 'PR 현황', type: 'conversation', tier: TIERS.EPISODIC,
      data: { input: 'PR 현황', output: 'PR 3건' } })

    assert(g.allNodes().length === 1, 'dedup: no duplicate node created')
    assert(n2.id === n1.id, 'dedup: returns same node')
    assert(n2.createdAt > before, 'dedup: timestamp updated')
  }

  // 30. conversation: 같은 label, 다른 output → 최신 응답으로 갱신 (1개 유지)
  {
    const g = MemoryGraph.create()
    g.addNode({ label: 'PR 현황', type: 'conversation', tier: TIERS.EPISODIC,
      data: { input: 'PR 현황', output: 'PR 3건' } })
    const n2 = g.addNode({ label: 'PR 현황', type: 'conversation', tier: TIERS.EPISODIC,
      data: { input: 'PR 현황', output: 'PR 5건' } })

    assert(g.allNodes().length === 1, 'conversation dedup: same label → 1 node')
    assert(n2.data.output === 'PR 5건', 'conversation dedup: output updated to latest')
  }

  // 30b. entity: 같은 label, 다른 data → 별도 노드 유지
  {
    const g = MemoryGraph.create()
    g.addNode({ label: 'React', type: 'entity', tier: TIERS.EPISODIC,
      data: { description: 'library' } })
    g.addNode({ label: 'React', type: 'entity', tier: TIERS.EPISODIC,
      data: { description: 'framework' } })

    assert(g.allNodes().length === 2, 'entity dedup: different data → separate nodes')
  }

  // 31. working 티어는 중복 방지 안 함
  {
    const g = MemoryGraph.create()
    g.addNode({ label: 'temp', tier: TIERS.WORKING })
    g.addNode({ label: 'temp', tier: TIERS.WORKING })

    assert(g.allNodes().length === 2, 'dedup: working tier allows duplicates')
  }

  // 32. 승격된 semantic 노드와 동일 내용 episodic 추가 → 기존 semantic 반환
  {
    const g = MemoryGraph.create()
    const n1 = g.addNode({ label: 'React', type: 'entity', tier: TIERS.SEMANTIC })
    const n2 = g.addNode({ label: 'React', type: 'entity', tier: TIERS.EPISODIC })

    assert(g.allNodes().length === 1, 'dedup cross-tier: no new node')
    assert(n2.id === n1.id, 'dedup cross-tier: returns existing semantic node')
  }

  // 33. removeNodes(predicate): 노드 제거 + 고아 엣지 정리
  {
    const g = MemoryGraph.create()
    const a = g.addNode({ label: 'A', tier: TIERS.EPISODIC })
    const b = g.addNode({ label: 'B', tier: TIERS.EPISODIC })
    const c = g.addNode({ label: 'C', tier: TIERS.SEMANTIC })
    g.addEdge(a.id, b.id, 'related')
    g.addEdge(b.id, c.id, 'related')
    g.addEdge(a.id, c.id, 'related')

    const removed = g.removeNodes(n => n.label === 'B')
    assert(removed === 1, 'removeNodes: returns removed count')
    assert(g.nodes.length === 2, 'removeNodes: node removed')
    assert(!g.nodes.find(n => n.label === 'B'), 'removeNodes: correct node removed')
    assert(g.edges.length === 1, 'removeNodes: orphan edges cleaned')
    assert(g.edges[0].from === a.id && g.edges[0].to === c.id, 'removeNodes: surviving edge correct')
  }

  // --- 메모리 무효화 ---

  // 34. expiresAt: 만료된 노드는 recall에서 제외
  {
    const g = MemoryGraph.create()
    const expired = g.addNode({ label: '오래된 정보', tier: TIERS.EPISODIC,
      expiresAt: Date.now() - 1000 })   // 1초 전 만료
    const valid = g.addNode({ label: '최신 정보', tier: TIERS.EPISODIC })
    expired.vector = [0.9, 0.1]
    valid.vector = [0.9, 0.1]

    const embedder = { embed: async () => [0.9, 0.1], model: 'm', dimensions: 2 }
    const results = await g.recall('정보', { embedder })
    assert(!results.find(n => n.id === expired.id), 'expiresAt: expired node excluded from recall')
    assert(results.find(n => n.id === valid.id), 'expiresAt: valid node included in recall')
  }

  // 35. expiresAt: 미래 만료 노드는 정상 반환
  {
    const g = MemoryGraph.create()
    const node = g.addNode({ label: '유효 정보', tier: TIERS.EPISODIC,
      expiresAt: Date.now() + 60_000 })  // 1분 후 만료
    node.vector = [0.9, 0.1]

    const embedder = { embed: async () => [0.9, 0.1], model: 'm', dimensions: 2 }
    const results = await g.recall('정보', { embedder })
    assert(results.find(n => n.id === node.id), 'expiresAt future: node still returned')
  }

  // 36. expiresAt null: 만료 없이 항상 유효
  {
    const g = MemoryGraph.create()
    const node = g.addNode({ label: '영구 정보', tier: TIERS.EPISODIC, expiresAt: null })
    node.vector = [0.9, 0.1]

    const embedder = { embed: async () => [0.9, 0.1], model: 'm', dimensions: 2 }
    const results = await g.recall('정보', { embedder })
    assert(results.find(n => n.id === node.id), 'expiresAt null: always valid')
  }

  // 37. source dedup: 같은 도구+인자 → 기존 노드 갱신
  {
    const g = MemoryGraph.create()
    const src = { tool: 'github_list_prs', toolArgs: { repo: 'my/repo' } }
    const n1 = g.addNode({ label: 'PR 목록', data: { prs: ['#1'] }, tier: TIERS.EPISODIC, source: src })

    const n2 = g.addNode({ label: 'PR 목록', data: { prs: ['#1', '#2'] }, tier: TIERS.EPISODIC, source: src })
    assert(g.allNodes().length === 1, 'source dedup: no new node created')
    assert(n2.id === n1.id, 'source dedup: returns same node')
    assert(n2.data.prs.length === 2, 'source dedup: data updated to latest')
    assert(n2.vector === null, 'source dedup: vector reset for re-embedding')
  }

  // 38. source dedup: 다른 도구 → 별도 노드
  {
    const g = MemoryGraph.create()
    g.addNode({ label: 'data', tier: TIERS.EPISODIC,
      source: { tool: 'tool_a', toolArgs: {} } })
    g.addNode({ label: 'data', tier: TIERS.EPISODIC,
      source: { tool: 'tool_b', toolArgs: {} } })
    assert(g.allNodes().length === 2, 'source dedup: different tool → separate nodes')
  }

  // 39. source dedup: 같은 도구, 다른 인자 → 별도 노드
  {
    const g = MemoryGraph.create()
    g.addNode({ label: 'PR', tier: TIERS.EPISODIC,
      source: { tool: 'github_list_prs', toolArgs: { repo: 'repo-a' } } })
    g.addNode({ label: 'PR', tier: TIERS.EPISODIC,
      source: { tool: 'github_list_prs', toolArgs: { repo: 'repo-b' } } })
    assert(g.allNodes().length === 2, 'source dedup: different args → separate nodes')
  }

  // 40. source dedup: expiresAt 갱신
  {
    const g = MemoryGraph.create()
    const src = { tool: 'fetch_data', toolArgs: {} }
    const n1 = g.addNode({ label: 'data', tier: TIERS.EPISODIC, source: src,
      expiresAt: Date.now() - 1000 })  // 이미 만료

    const freshExpiry = Date.now() + 60_000
    g.addNode({ label: 'data', tier: TIERS.EPISODIC, source: src, expiresAt: freshExpiry })
    assert(n1.expiresAt === freshExpiry, 'source dedup: expiresAt updated on re-save')
  }

  summary()
}

run()
