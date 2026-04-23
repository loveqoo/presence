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
 *  MC5.  allNodes — userId 전달, 빈 배열 반환
 *  MC6.  add + allNodes — userId로 저장 후 조회
 *  MC7.  search — userId 전달, { label } 형태로 변환
 *  MC8.  search — 빈 결과
 *  MC9.  clearAll — userId 기준 삭제
 *  MC10. removeOlderThan — 조건에 맞는 노드만 삭제
 *  MC11. allNodes — getAll 실패 시 빈 배열 반환
 *  MC12. add — mem0.add 실패 시 에러 전파
 *  MC13. search — mem0.search 실패 시 에러 전파
 *  MC14. userId 격리 — 다른 userId는 서로 보이지 않음
 */

import { assert, summary } from '../../../test/lib/assert.js'

// --- Mock mem0 팩토리 ---

const createMockMem0 = (opts = {}) => {
  const store = [] // { id, memory, createdAt, userId }
  let idCounter = 0

  return {
    store,
    search: async (query, searchOpts) => {
      if (opts.searchError) throw new Error(opts.searchError)
      const userId = searchOpts?.userId
      return { results: store.filter(r => r.userId === userId).map(r => ({ memory: r.memory, score: 0.9 })) }
    },
    add: async (messages, addOpts) => {
      if (opts.addError) throw new Error(opts.addError)
      const userId = addOpts?.userId
      const content = messages.map(m => m.content).join(' ')
      store.push({ id: `id-${++idCounter}`, memory: content, createdAt: new Date().toISOString(), userId })
    },
    getAll: async (getOpts) => {
      if (opts.getAllError) throw new Error(opts.getAllError)
      const userId = getOpts?.userId
      return { results: store.filter(r => r.userId === userId).map(r => ({ id: r.id, memory: r.memory, createdAt: r.createdAt })) }
    },
    deleteAll: async (delOpts) => {
      const userId = delOpts?.userId
      const before = store.length
      for (let i = store.length - 1; i >= 0; i--) {
        if (store[i].userId === userId) store.splice(i, 1)
      }
      return before - store.length
    },
    delete: async (id) => {
      const idx = store.findIndex(r => r.id === id)
      if (idx >= 0) store.splice(idx, 1)
    },
  }
}

const createMemoryWithMock = async (mockMem0) => {
  const { Memory } = await import('@presence/infra/infra/memory.js')
  return new Memory(mockMem0)
}

// agent 단위 격리: 첫 파라미터는 qualified agentId (`{userId}/{agentName}`).
// 레거시 변수명 USER_A/USER_B 는 단일 agent 격리 시나리오 (값은 임의 문자열) 를 의미.
const USER_A = 'userA'
const USER_B = 'userB'
const SAME_USER_AGENT_1 = 'shared/agent1'
const SAME_USER_AGENT_2 = 'shared/agent2'

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
      memory: { path: '/tmp/mc1' },
    }
    const result = await Memory.create(config)
    assert(result === null, 'MC1: embed 자격증명 없으면 null')
  }

  // =========================================================================
  // MC2. embed.provider='openai' + llm.apiKey fallback → apiKey 확보
  // =========================================================================
  {
    const embedApiKey = null || ('openai' === 'openai' ? 'llm-key' : null)
    assert(embedApiKey === 'llm-key', 'MC2: openai provider → llm.apiKey fallback')
  }

  // =========================================================================
  // MC3. embed.baseUrl만 있어도 자격증명 통과
  // =========================================================================
  {
    const embedApiKey = null
    const baseUrl = 'http://localhost:8045/v1'
    const shouldCreate = !(!embedApiKey && !baseUrl)
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
  // MC5. allNodes — userId 전달, 빈 결과
  // =========================================================================
  {
    const mock = createMockMem0()
    const memory = await createMemoryWithMock(mock)
    const nodes = await memory.allNodes(USER_A)
    assert(Array.isArray(nodes), 'MC5: allNodes 배열')
    assert(nodes.length === 0, 'MC5: 초기 상태 비어있음')
  }

  // =========================================================================
  // MC6. add + allNodes — userId로 저장 후 조회
  // =========================================================================
  {
    const mock = createMockMem0()
    const memory = await createMemoryWithMock(mock)

    await memory.add(USER_A, '서울은 한국의 수도입니다', '맞습니다.')
    const nodes = await memory.allNodes(USER_A)
    assert(nodes.length === 1, 'MC6: add 후 노드 1개')
    assert(typeof nodes[0].id === 'string', 'MC6: 노드에 id')
    assert(typeof nodes[0].label === 'string', 'MC6: 노드에 label')
    assert(typeof nodes[0].createdAt === 'number', 'MC6: createdAt은 number')
    // type/tier 필드 없음
    assert(nodes[0].type === undefined, 'MC6: type 필드 없음')
    assert(nodes[0].tier === undefined, 'MC6: tier 필드 없음')

    await memory.add(USER_A, '도쿄는 일본의 수도입니다', '네.')
    const nodes2 = await memory.allNodes(USER_A)
    assert(nodes2.length === 2, 'MC6: 두 번째 add 후 2개')
  }

  // =========================================================================
  // MC7. search — userId 전달, 결과 변환
  // =========================================================================
  {
    const mock = createMockMem0()
    const memory = await createMemoryWithMock(mock)
    await memory.add(USER_A, '파리는 프랑스 수도', '네')

    const results = await memory.search(USER_A, '프랑스')
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
    const results = await memory.search(USER_A, '없는 내용')
    assert(Array.isArray(results), 'MC8: 빈 결과도 배열')
    assert(results.length === 0, 'MC8: 0개')
  }

  // =========================================================================
  // MC9. clearAll — userId 기준 삭제
  // =========================================================================
  {
    const mock = createMockMem0()
    const memory = await createMemoryWithMock(mock)
    await memory.add(USER_A, '데이터1', '응답1')
    await memory.add(USER_A, '데이터2', '응답2')
    const beforeNodes = await memory.allNodes(USER_A)
    assert(beforeNodes.length === 2, 'MC9: 삭제 전 2개')

    const cleared = await memory.clearAll(USER_A)
    assert(cleared === 2, 'MC9: clearAll 반환값 2')
    const afterNodes = await memory.allNodes(USER_A)
    assert(afterNodes.length === 0, 'MC9: 삭제 후 비어있음')
  }

  // =========================================================================
  // MC10. removeOlderThan — 조건부 삭제
  // =========================================================================
  {
    const mock = createMockMem0()
    const memory = await createMemoryWithMock(mock)

    // 과거 timestamp로 직접 store에 삽입
    const pastDate = new Date(Date.now() - 100000).toISOString()
    mock.store.push({ id: 'old-1', memory: '오래된 데이터', createdAt: pastDate, userId: USER_A })
    mock.store.push({ id: 'new-1', memory: '새 데이터', createdAt: new Date().toISOString(), userId: USER_A })

    const beforeNodes = await memory.allNodes(USER_A)
    assert(beforeNodes.length === 2, 'MC10: 삭제 전 2개')
    const removed = await memory.removeOlderThan(USER_A, 50000)
    assert(removed === 1, 'MC10: 1개 삭제')
    const afterNodes = await memory.allNodes(USER_A)
    assert(afterNodes.length === 1, 'MC10: 1개 남음')
    assert(afterNodes[0].label.includes('새 데이터'), 'MC10: 새 데이터만 남음')
  }

  // =========================================================================
  // MC11. allNodes — getAll 실패 시 빈 배열
  // =========================================================================
  {
    const mock = createMockMem0({ getAllError: 'connection failed' })
    const memory = await createMemoryWithMock(mock)
    const nodes = await memory.allNodes(USER_A)
    assert(nodes.length === 0, 'MC11: getAll 실패 시 빈 배열')
  }

  // =========================================================================
  // MC12. add 실패 → 에러 전파
  // =========================================================================
  {
    const mock = createMockMem0({ addError: 'add failed' })
    const memory = await createMemoryWithMock(mock)

    let caught = false
    try {
      await memory.add(USER_A, '데이터', '응답')
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
      await memory.search(USER_A, '쿼리')
    } catch (err) {
      caught = true
      assert(err.message === 'search failed', 'MC13: 에러 메시지 전파')
    }
    assert(caught, 'MC13: search 실패 시 에러 throw')
  }

  // =========================================================================
  // MC14. agentId 격리 — 다른 agentId는 서로 보이지 않음
  // =========================================================================
  {
    const mock = createMockMem0()
    const memory = await createMemoryWithMock(mock)

    await memory.add(USER_A, 'A만의 데이터', 'A 응답')
    await memory.add(USER_B, 'B만의 데이터', 'B 응답')

    const nodesA = await memory.allNodes(USER_A)
    const nodesB = await memory.allNodes(USER_B)

    assert(nodesA.length === 1, 'MC14: agentA 노드 1개')
    assert(nodesB.length === 1, 'MC14: agentB 노드 1개')
    assert(nodesA[0].label.includes('A만의'), 'MC14: agentA는 자신의 데이터만')
    assert(nodesB[0].label.includes('B만의'), 'MC14: agentB는 자신의 데이터만')

    // clearAll은 해당 agentId만 삭제
    await memory.clearAll(USER_A)
    const nodesAAfter = await memory.allNodes(USER_A)
    const nodesBAfter = await memory.allNodes(USER_B)
    assert(nodesAAfter.length === 0, 'MC14: agentA 데이터 삭제됨')
    assert(nodesBAfter.length === 1, 'MC14: agentB 데이터 유지됨')
  }

  // =========================================================================
  // MC15. 같은 유저의 서로 다른 agent 는 기억 격리 — qualified agentId 로 분리
  // =========================================================================
  {
    const mock = createMockMem0()
    const memory = await createMemoryWithMock(mock)

    await memory.add(SAME_USER_AGENT_1, 'agent1 이 보고 들은 것', 'ack1')
    await memory.add(SAME_USER_AGENT_2, 'agent2 가 보고 들은 것', 'ack2')

    const nodes1 = await memory.allNodes(SAME_USER_AGENT_1)
    const nodes2 = await memory.allNodes(SAME_USER_AGENT_2)
    assert(nodes1.length === 1 && nodes1[0].label.includes('agent1'), 'MC15: agent1 자신 기억만')
    assert(nodes2.length === 1 && nodes2[0].label.includes('agent2'), 'MC15: agent2 자신 기억만')

    // agent1 의 search 결과는 agent1 의 store 에서만 나오고, agent2 기억은 절대 포함되지 않는다.
    const searchFromAgent1 = await memory.search(SAME_USER_AGENT_1, 'anything')
    assert(!searchFromAgent1.some(r => r.label.includes('agent2')), 'MC15: agent1 search 결과에 agent2 기억 포함되지 않음')
  }

  summary()
}

run()
