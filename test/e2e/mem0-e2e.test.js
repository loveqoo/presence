/**
 * Mem0 E2E tests — 실제 LLM + Embedding 서버 기반 메모리 통합 테스트
 *
 * 실행 조건: 로컬 LLM 서버(embedding 지원)가 필요.
 * 서버 없으면 skip.
 *
 * 커버하는 시나리오:
 *  M1.  Memory.create — embed 설정이 있으면 Memory 인스턴스 생성
 *  M2.  add + allNodes — 대화 저장 후 캐시에 반영
 *  M3.  search — 유사 메모리 검색
 *  M4.  clearAll — 전체 삭제 + 캐시 초기화
 *  M5.  유저 격리 — 서로 다른 memoryPath는 독립적 mem0
 *  M6.  서버 턴 후 자동 메모리 저장 — chat → memory.allNodes() 증가
 *  M7.  프롬프트 주입 — recall된 메모리가 LLM 프롬프트에 포함
 *  M8.  (단위 테스트 커버: 실패 턴 → save 미호출)
 */

import http from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Memory } from '@presence/infra/infra/memory.js'
import { startServer } from '@presence/server'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import { ensureSecret } from '@presence/infra/infra/auth/token.js'
import { assert, summary } from '../lib/assert.js'
import { request, delay } from '../lib/mock-server.js'

// ---------------------------------------------------------------------------
// 환경 확인
// ---------------------------------------------------------------------------

const LLM_BASE_URL = 'http://127.0.0.1:8045/v1'
const EMBED_MODEL = 'text-embedding-e5-large'

const checkLlmAvailable = async () => {
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(`${LLM_BASE_URL}/models`, { timeout: 3000 }, (res) => {
        let buf = ''
        res.on('data', d => { buf += d })
        res.on('end', () => resolve(JSON.parse(buf)))
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
      req.end()
    })
    return res.data?.some(m => m.id.toLowerCase().includes('embed'))
  } catch { return false }
}

// ---------------------------------------------------------------------------
// 테스트용 config
// ---------------------------------------------------------------------------

const makeConfig = (memoryPath) => ({
  llm: { baseUrl: LLM_BASE_URL, model: 'qwen3.5-35b', apiKey: 'local', responseFormat: 'json_object', maxRetries: 0, timeoutMs: 30000 },
  embed: { provider: 'openai', baseUrl: LLM_BASE_URL, apiKey: 'local', model: EMBED_MODEL, dimensions: 1024 },
  locale: 'ko', maxIterations: 5,
  memory: { path: memoryPath },
  mcp: [],
  scheduler: { enabled: false, pollIntervalMs: 60000, todoReview: { enabled: false, cron: '0 9 * * *' } },
  delegatePolling: { intervalMs: 60000 },
  prompt: { maxContextTokens: 8000, reservedOutputTokens: 1000, maxContextChars: null, reservedOutputChars: null },
})

// 인증 서버 부팅 헬퍼
const createAuthServer = async (memoryPath, username = 'testuser') => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'mem0-e2e-'))
  const instanceId = 'mem0-test'
  mkdirSync(join(tmpDir, 'instances'), { recursive: true })

  const config = makeConfig(memoryPath || join(tmpDir, 'memory'))
  writeFileSync(join(tmpDir, 'instances', `${instanceId}.json`), JSON.stringify({
    memory: config.memory,
  }))
  writeFileSync(join(tmpDir, 'server.json'), JSON.stringify(config))

  ensureSecret({ basePath: tmpDir })
  const userStore = createUserStore({ basePath: tmpDir })
  await userStore.addUser(username, 'testpass123')
  await userStore.changePassword(username, 'testpass123')

  const origDir = process.env.PRESENCE_DIR
  process.env.PRESENCE_DIR = tmpDir

  const { Config } = await import('@presence/infra/infra/config.js')
  const mergedConfig = Config.loadUserMerged(instanceId, { basePath: tmpDir })
  const result = await startServer(mergedConfig, { port: 0, persistenceCwd: tmpDir, instanceId })
  const port = result.server.address().port

  const loginRes = await request(port, 'POST', '/api/auth/login', { username, password: 'testpass123' })
  const token = loginRes.body.accessToken
  const sid = `${username}-default`
  // lazy 세션 생성
  await request(port, 'GET', `/api/sessions/${sid}/state`, null, { token })

  const origShutdown = result.shutdown
  return {
    port, token, sid, tmpDir, userContext: result.userContext,
    shutdown: async () => {
      await origShutdown()
      if (origDir) process.env.PRESENCE_DIR = origDir
      else delete process.env.PRESENCE_DIR
      rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------

async function run() {
  console.log('Mem0 E2E tests')

  const available = await checkLlmAvailable()
  if (!available) {
    console.log('  ⏭ LLM/embedding 서버 없음 — skip')
    summary()
    return
  }

  // =========================================================================
  // M1. Memory.create — embed 설정이 있으면 인스턴스 생성
  // =========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mem0-m1-'))
    const config = makeConfig(tmpDir)
    const memory = await Memory.create(config, { memoryPath: tmpDir })
    assert(memory !== null, 'M1: Memory 인스턴스 생성됨')
    assert(typeof memory.search === 'function', 'M1: search 메서드 존재')
    assert(typeof memory.add === 'function', 'M1: add 메서드 존재')
    assert(Array.isArray(memory.allNodes()), 'M1: allNodes 배열 반환')
    rmSync(tmpDir, { recursive: true, force: true })
  }

  // =========================================================================
  // M2. add + allNodes — 대화 저장 후 캐시 반영
  // =========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mem0-m2-'))
    const memory = await Memory.create(makeConfig(tmpDir), { memoryPath: tmpDir })

    await memory.add('서울의 인구는 얼마인가요?', '서울의 인구는 약 950만 명입니다.')
    const nodes = memory.allNodes()

    assert(nodes.length > 0, 'M2: add 후 allNodes에 노드 존재')
    assert(nodes.some(n => typeof n.label === 'string' && n.label.length > 0), 'M2: 노드에 label 존재')
    assert(nodes.every(n => n.id && n.type && n.tier), 'M2: 노드 구조 (id, type, tier)')
    assert(nodes.every(n => typeof n.createdAt === 'number'), 'M2: 노드에 createdAt 존재')
    rmSync(tmpDir, { recursive: true, force: true })
  }

  // =========================================================================
  // M3. search — 유사 메모리 검색
  // =========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mem0-m3-'))
    const memory = await Memory.create(makeConfig(tmpDir), { memoryPath: tmpDir })

    await memory.add('파리는 프랑스의 수도입니다', '맞습니다. 파리는 프랑스의 수도이자 최대 도시입니다.')
    await memory.add('도쿄는 일본의 수도입니다', '네, 도쿄는 일본의 수도입니다.')

    const results = await memory.search('프랑스 수도')
    assert(Array.isArray(results), 'M3: search 결과는 배열')
    assert(results.length > 0, 'M3: 유사 메모리 검색됨')
    assert(results.some(r => r.label.includes('파리') || r.label.includes('프랑스')), 'M3: 관련 메모리 포함')
    rmSync(tmpDir, { recursive: true, force: true })
  }

  // =========================================================================
  // M4. clearAll — 전체 삭제 + 캐시 초기화
  // =========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mem0-m4-'))
    const memory = await Memory.create(makeConfig(tmpDir), { memoryPath: tmpDir })

    await memory.add('테스트 데이터', '테스트 응답')
    assert(memory.allNodes().length > 0, 'M4: 삭제 전 데이터 존재')

    const cleared = memory.clearAll()
    assert(cleared > 0, 'M4: clearAll 반환값 > 0')
    assert(memory.allNodes().length === 0, 'M4: clearAll 후 캐시 비어있음')
    rmSync(tmpDir, { recursive: true, force: true })
  }

  // =========================================================================
  // M5. 유저 격리 — 서로 다른 memoryPath는 독립적
  // =========================================================================
  {
    const tmpDirA = mkdtempSync(join(tmpdir(), 'mem0-m5a-'))
    const tmpDirB = mkdtempSync(join(tmpdir(), 'mem0-m5b-'))

    const memoryA = await Memory.create(makeConfig(tmpDirA), { memoryPath: tmpDirA })
    const memoryB = await Memory.create(makeConfig(tmpDirB), { memoryPath: tmpDirB })

    await memoryA.add('유저A만의 비밀', '유저A 응답')
    await memoryB.add('유저B만의 비밀', '유저B 응답')

    // A는 B의 데이터를 볼 수 없음
    const searchA = await memoryA.search('유저B')
    const nodesA = memoryA.allNodes()
    const nodesB = memoryB.allNodes()

    assert(nodesA.length > 0, 'M5: 유저A 메모리 존재')
    assert(nodesB.length > 0, 'M5: 유저B 메모리 존재')
    // 유저A의 노드에 '유저B' 관련 내용이 없어야 함
    assert(!nodesA.some(n => n.label.includes('유저B')), 'M5: 유저A에 유저B 데이터 없음')
    assert(!nodesB.some(n => n.label.includes('유저A')), 'M5: 유저B에 유저A 데이터 없음')

    rmSync(tmpDirA, { recursive: true, force: true })
    rmSync(tmpDirB, { recursive: true, force: true })
  }

  // =========================================================================
  // M6. 서버 턴 후 자동 메모리 저장
  // =========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mem0-m6-'))
    const ctx = await createAuthServer(join(tmpDir, 'memory'))
    const { port, token, sid, shutdown } = ctx

    try {
      // 대화 전 메모리 수
      const stateBefore = await request(port, 'GET', `/api/sessions/${sid}/state`, null, { token })
      const memBefore = stateBefore.body.context?.memories?.length || 0

      // 대화 실행
      await request(port, 'POST', `/api/sessions/${sid}/chat`, { input: '대한민국의 수도는 서울입니다' }, { token })
      await delay(3000) // mem0 add + cache refresh 대기

      // 두 번째 대화 — 이전 메모리가 recall되어야 함
      await request(port, 'POST', `/api/sessions/${sid}/chat`, { input: '수도에 대해 아까 뭐라고 했나요?' }, { token })
      await delay(2000)

      const stateAfter = await request(port, 'GET', `/api/sessions/${sid}/state`, null, { token })
      const memAfter = stateAfter.body.context?.memories?.length || 0

      assert(memAfter > memBefore, `M6: 턴 후 메모리 증가 (${memBefore} → ${memAfter})`)
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // M7. 프롬프트 주입 — recall된 메모리가 LLM에 전달됨
  // =========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mem0-m7-'))
    const memoryPath = join(tmpDir, 'memory')
    // 먼저 메모리에 데이터 추가
    const memory = await Memory.create(makeConfig(memoryPath), { memoryPath })
    await memory.add('내 이름은 Anthony입니다', '안녕하세요 Anthony님!')
    await memory.add('나는 소프트웨어 엔지니어입니다', '개발자시군요!')
    const nodeCount = memory.allNodes().length
    assert(nodeCount >= 2, 'M7: 사전 메모리 등록 완료')

    // 서버 부팅 (같은 memoryPath 사용)
    const ctx = await createAuthServer(memoryPath)
    const { port, token, sid, shutdown } = ctx

    try {
      // '이름'을 물어보면 recall에서 Anthony 관련 메모리가 검색되어야 함
      const chatRes = await request(port, 'POST', `/api/sessions/${sid}/chat`, { input: '내 이름이 뭐였죠?' }, { token })
      assert(chatRes.status === 200, 'M7: chat 성공')

      // state에서 recall된 memories 확인
      const state = await request(port, 'GET', `/api/sessions/${sid}/state`, null, { token })
      const memories = state.body.context?.memories || []
      assert(memories.length > 0, `M7: recall된 메모리 존재 (${memories.length}개)`)
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // M8(실패 턴 → memory 저장 안 됨)은 단위 테스트(actors.test.js)에서 커버.
  // executor.js line 67: lastTurn.tag === RESULT.SUCCESS일 때만 save 호출.

  summary()
}

run()
