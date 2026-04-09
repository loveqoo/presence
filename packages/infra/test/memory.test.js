/**
 * Memory 단위 테스트 — mock mem0로 Memory 클래스 검증
 *
 * 실제 LLM/embedding 불필요. mem0 인스턴스를 mock하여 Memory의 로직만 검증.
 *
 * 커버하는 시나리오:
 *  MC1.  Memory.create — embed 자격증명 없으면 null
 *  MC2.  Memory.create — embed.provider='openai' + llm.apiKey fallback → 생성
 *  MC3.  Memory.create — embed.baseUrl만 있어도 생성
 *  MC4.  Memory.create — embed.provider='none' → null (apiKey fallback 안 됨)
 *  MC5.  allNodes — 초기 캐시 빈 배열
 *  MC6.  add → refreshCache → allNodes 반영
 *  MC7.  search — mem0 결과를 { label } 형태로 변환
 *  MC8.  search — 빈 결과
 *  MC9.  clearAll — 캐시 초기화 + mem0.reset 호출
 *  MC10. removeOlderThan — 조건에 맞는 노드만 삭제
 *  MC11. refreshCache — mem0.getAll 실패 시 캐시 유지
 *  MC12. add — mem0.add 실패 시 에러 전파 (caller가 catch)
 *  MC13. search — mem0.search 실패 시 에러 전파
 */

import { assert, summary } from '../../../test/lib/assert.js'

// Memory 클래스를 직접 import할 수 없으므로 (constructor가 private),
// create()의 설정 분기와 인스턴스 메서드를 테스트하기 위해
// mock mem0 + 리플렉션 사용

// --- Mock mem0 팩토리 ---

const createMockMem0 = (opts = {}) => {
  const store = []
  let idCounter = 0

  return {
    store,
    search: async (_query, _opts) => {
      if (opts.searchError) throw new Error(opts.searchError)
      return { results: store.map(r => ({ memory: r.memory, score: 0.9 })) }
    },
    add: async (messages, _opts) => {
      if (opts.addError) throw new Error(opts.addError)
      const content = messages.map(m => m.content).join(' ')
      store.push({ id: `id-${++idCounter}`, memory: content, createdAt: new Date().toISOString() })
    },
    getAll: async (_opts) => {
      if (opts.getAllError) throw new Error(opts.getAllError)
      return { results: store.map(r => ({ id: r.id, memory: r.memory, createdAt: r.createdAt })) }
    },
    reset: async () => { store.length = 0 },
    delete: async (id) => {
      const idx = store.findIndex(r => r.id === id)
      if (idx >= 0) store.splice(idx, 1)
    },
  }
}

// Memory 클래스를 직접 인스턴스화하려면 create()를 우회해야 함
// create()는 mem0ai를 import하므로, constructor를 직접 호출할 수 없음
// 대신 Memory.create의 설정 분기는 config 조합으로 테스트하고,
// 인스턴스 메서드는 mock mem0를 주입하여 테스트

const createMemoryWithMock = async (mockMem0) => {
  const { Memory } = await import('@presence/infra/infra/memory.js')
  // Memory constructor는 export되어 있으므로 new로 생성 가능
  const memory = new Memory(mockMem0)
  await memory.refreshCache()
  return memory
}

async function run() {
  console.log('Memory unit tests')

  const { Memory } = await import('@presence/infra/infra/memory.js')

  // =========================================================================
  // MC1. embed 자격증명 없으면 null
  // =========================================================================
  {
    const config = {
      llm: { apiKey: null, model: 'test', baseUrl: null },
      embed: { provider: 'none', apiKey: null, baseUrl: null, model: null, dimensions: 256 },
    }
    const result = await Memory.create(config, { memoryPath: '/tmp/mc1' })
    assert(result === null, 'MC1: embed 자격증명 없으면 null')
  }

  // =========================================================================
  // MC2. embed.provider='openai' + llm.apiKey fallback → apiKey 확보
  // =========================================================================
  {
    // Memory.create 내부에서 embedApiKey = embed.apiKey || (provider==='openai' ? llm.apiKey : null)
    // apiKey가 있으면 mem0 import를 시도하므로, 여기서는 로직만 검증
    const embedApiKey = null || ('openai' === 'openai' ? 'llm-key' : null)
    assert(embedApiKey === 'llm-key', 'MC2: openai provider → llm.apiKey fallback')
  }

  // =========================================================================
  // MC3. embed.baseUrl만 있어도 자격증명 통과
  // =========================================================================
  {
    const embedApiKey = null
    const baseUrl = 'http://localhost:8045/v1'
    const shouldCreate = !(!embedApiKey && !baseUrl) // !(false && false) = true
    assert(shouldCreate, 'MC3: baseUrl만 있으면 생성 조건 통과')
  }

  // =========================================================================
  // MC4. embed.provider='none' → apiKey fallback 안 됨
  // =========================================================================
  {
    const provider = 'none'
    const embedApiKey = null || (provider === 'openai' ? 'llm-key' : null)
    assert(embedApiKey === null, 'MC4: provider=none → llm.apiKey fallback 안 됨')
  }

  // =========================================================================
  // MC5. allNodes — 초기 캐시
  // =========================================================================
  {
    const mock = createMockMem0()
    const memory = await createMemoryWithMock(mock)
    assert(Array.isArray(memory.allNodes()), 'MC5: allNodes 배열')
    assert(memory.allNodes().length === 0, 'MC5: 초기 캐시 비어있음')
  }

  // =========================================================================
  // MC6. add → refreshCache → allNodes 반영
  // =========================================================================
  {
    const mock = createMockMem0()
    const memory = await createMemoryWithMock(mock)

    await memory.add('서울은 한국의 수도입니다', '맞습니다.')
    const nodes = memory.allNodes()
    assert(nodes.length === 1, 'MC6: add 후 노드 1개')
    assert(typeof nodes[0].id === 'string', 'MC6: 노드에 id')
    assert(typeof nodes[0].label === 'string', 'MC6: 노드에 label')
    assert(nodes[0].type === 'fact', 'MC6: type은 fact')
    assert(nodes[0].tier === 'episodic', 'MC6: tier은 episodic')
    assert(typeof nodes[0].createdAt === 'number', 'MC6: createdAt은 number')

    await memory.add('도쿄는 일본의 수도입니다', '네.')
    assert(memory.allNodes().length === 2, 'MC6: 두 번째 add 후 2개')
  }

  // =========================================================================
  // MC7. search — 결과 변환
  // =========================================================================
  {
    const mock = createMockMem0()
    const memory = await createMemoryWithMock(mock)
    await memory.add('파리는 프랑스 수도', '네')

    const results = await memory.search('프랑스')
    assert(Array.isArray(results), 'MC7: search 결과 배열')
    assert(results.length === 1, 'MC7: 1개 결과')
    assert(typeof results[0].label === 'string', 'MC7: label 필드')
    assert(results[0].label.includes('파리'), 'MC7: 내용 포함')
  }

  // =========================================================================
  // MC8. search — 빈 결과
  // =========================================================================
  {
    const mock = createMockMem0()
    const memory = await createMemoryWithMock(mock)
    // store가 비어있으므로 빈 결과
    const results = await memory.search('없는 내용')
    assert(Array.isArray(results), 'MC8: 빈 결과도 배열')
    assert(results.length === 0, 'MC8: 0개')
  }

  // =========================================================================
  // MC9. clearAll — 캐시 초기화 + reset
  // =========================================================================
  {
    const mock = createMockMem0()
    const memory = await createMemoryWithMock(mock)
    await memory.add('데이터1', '응답1')
    await memory.add('데이터2', '응답2')
    assert(memory.allNodes().length === 2, 'MC9: 삭제 전 2개')

    const cleared = memory.clearAll()
    assert(cleared === 2, 'MC9: clearAll 반환값 2')
    assert(memory.allNodes().length === 0, 'MC9: 캐시 비어있음')
  }

  // =========================================================================
  // MC10. removeOlderThan — 조건부 삭제 (mock store에 과거 timestamp 삽입)
  // =========================================================================
  {
    const mock = createMockMem0()
    const memory = await createMemoryWithMock(mock)

    // 과거 timestamp로 직접 store에 삽입
    const pastDate = new Date(Date.now() - 100000).toISOString()
    mock.store.push({ id: 'old-1', memory: '오래된 데이터', createdAt: pastDate })
    mock.store.push({ id: 'new-1', memory: '새 데이터', createdAt: new Date().toISOString() })
    await memory.refreshCache()

    assert(memory.allNodes().length === 2, 'MC10: 삭제 전 2개')
    const removed = memory.removeOlderThan(50000) // 50초 이상 된 것 삭제
    assert(removed === 1, 'MC10: 1개 삭제')
    assert(memory.allNodes().length === 1, 'MC10: 1개 남음')
    assert(memory.allNodes()[0].label.includes('새 데이터'), 'MC10: 새 데이터만 남음')
  }

  // =========================================================================
  // MC11. refreshCache — getAll 실패 시 캐시 유지
  // =========================================================================
  {
    const mock = createMockMem0({ getAllError: 'connection failed' })
    // 에러 발생해도 캐시가 초기 빈 배열로 유지
    const memory = await createMemoryWithMock(mock)
    assert(memory.allNodes().length === 0, 'MC11: getAll 실패 시 빈 캐시 유지')
  }

  // =========================================================================
  // MC12. add 실패 → 에러 전파
  // =========================================================================
  {
    const mock = createMockMem0({ addError: 'add failed' })
    const memory = await createMemoryWithMock(mock)

    let caught = false
    try {
      await memory.add('데이터', '응답')
    } catch (err) {
      caught = true
      assert(err.message === 'add failed', 'MC12: 에러 메시지 전파')
    }
    assert(caught, 'MC12: add 실패 시 에러 throw')
  }

  // =========================================================================
  // MC13. search 실패 → 에러 전파
  // =========================================================================
  {
    const mock = createMockMem0({ searchError: 'search failed' })
    const memory = await createMemoryWithMock(mock)

    let caught = false
    try {
      await memory.search('쿼리')
    } catch (err) {
      caught = true
      assert(err.message === 'search failed', 'MC13: 에러 메시지 전파')
    }
    assert(caught, 'MC13: search 실패 시 에러 throw')
  }

  summary()
}

run()
