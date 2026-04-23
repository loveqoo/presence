/**
 * Memory 통합 테스트 — 서버 + 실제 LLM/embedding 기반.
 *
 * 단위 동작은 packages/infra/test/memory.test.js 가 mock으로 커버한다.
 * 이 파일은 "서버 턴 → 자동 저장 → recall → 프롬프트 주입" 이라는
 * 유저가 체감하는 end-to-end 흐름만 검증한다.
 *
 * 실행 조건: 로컬 LLM 서버(embedding 지원, 기본 127.0.0.1:8045)가 필요.
 * 서버 없으면 skip.
 *
 * 커버 시나리오:
 *  MI1. 서버 턴 후 자동 메모리 저장 — chat → context.memories 증가
 *  MI2. 프롬프트 주입 — 사전 등록된 메모리가 recall되어 state에 반영
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

const LLM_BASE_URL = 'http://127.0.0.1:8045/v1'
const EMBED_MODEL = 'text-embedding-e5-large'
const TEST_USERNAME = 'testuser'
const TEST_PASSWORD = 'testpass123'

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

// 인증 서버 부팅 헬퍼. memoryPath 공유로 외부에서 사전 등록한 메모리와 같은 저장소를 쓴다.
const createAuthServer = async (memoryPath) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'memory-integ-'))
  const instanceId = 'memory-integ-test'
  mkdirSync(join(tmpDir, 'instances'), { recursive: true })

  const config = makeConfig(memoryPath || join(tmpDir, 'memory'))
  writeFileSync(join(tmpDir, 'instances', `${instanceId}.json`), JSON.stringify({ memory: config.memory }))
  writeFileSync(join(tmpDir, 'server.json'), JSON.stringify(config))

  ensureSecret({ basePath: tmpDir })
  const userStore = createUserStore({ basePath: tmpDir })
  await userStore.addUser(TEST_USERNAME, TEST_PASSWORD)
  await userStore.changePassword(TEST_USERNAME, TEST_PASSWORD)

  const origDir = process.env.PRESENCE_DIR
  process.env.PRESENCE_DIR = tmpDir

  const { loadUserMerged } = await import('@presence/infra/infra/config-loader.js')
  const mergedConfig = loadUserMerged(instanceId, { basePath: tmpDir })
  const result = await startServer(mergedConfig, { port: 0, persistenceCwd: tmpDir, instanceId })
  const port = result.server.address().port

  const loginRes = await request(port, 'POST', '/api/auth/login', { username: TEST_USERNAME, password: TEST_PASSWORD })
  const token = loginRes.body.accessToken
  const sid = `${TEST_USERNAME}-default`
  // lazy 세션 생성 트리거
  await request(port, 'GET', `/api/sessions/${sid}/state`, null, { token })

  return {
    port, token, sid, tmpDir,
    shutdown: async () => {
      await result.shutdown()
      if (origDir) process.env.PRESENCE_DIR = origDir
      else delete process.env.PRESENCE_DIR
      rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------

async function run() {
  console.log('Memory integration tests')

  const available = await checkLlmAvailable()
  if (!available) {
    console.log('  ⏭ LLM/embedding 서버 없음 — skip')
    summary()
    return
  }

  // =========================================================================
  // MI1. 서버 턴 후 자동 메모리 저장
  //   chat → executor가 memory.add(agentId, input, output) 호출 → 다음 state 조회 시 증가
  // =========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'memory-integ-mi1-'))
    const ctx = await createAuthServer(join(tmpDir, 'memory'))
    const { port, token, sid, shutdown } = ctx

    try {
      const stateBefore = await request(port, 'GET', `/api/sessions/${sid}/state`, null, { token })
      const memBefore = stateBefore.body.context?.memories?.length || 0

      await request(port, 'POST', `/api/sessions/${sid}/chat`, { input: '대한민국의 수도는 서울입니다' }, { token })
      await delay(3000) // mem0 add 대기

      await request(port, 'POST', `/api/sessions/${sid}/chat`, { input: '수도에 대해 아까 뭐라고 했나요?' }, { token })
      await delay(2000)

      const stateAfter = await request(port, 'GET', `/api/sessions/${sid}/state`, null, { token })
      const memAfter = stateAfter.body.context?.memories?.length || 0

      assert(memAfter > memBefore, `MI1: 턴 후 메모리 증가 (${memBefore} → ${memAfter})`)
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // =========================================================================
  // MI2. 프롬프트 주입 — 사전 등록된 메모리가 recall되어 state.context.memories 에 반영
  //   주의: 사전 등록 시 agentId 는 서버 세션의 agentId (`${username}/default` 기본) 와 일치해야 한다.
  //   Memory 는 agent 단위 격리 (docs/specs/architecture.md I7, docs/design/data-scope-alignment.md).
  // =========================================================================
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'memory-integ-mi2-'))
    const memoryPath = join(tmpDir, 'memory')

    // 서버와 같은 qualified agentId 로 사전 등록 (세션 agentId = `${username}/default`)
    const memory = await Memory.create(makeConfig(memoryPath))
    assert(memory !== null, 'MI2: Memory 인스턴스 생성')

    const TEST_AGENT_ID = `${TEST_USERNAME}/default`
    await memory.add(TEST_AGENT_ID, '내 이름은 Anthony입니다', '안녕하세요 Anthony님!')
    await memory.add(TEST_AGENT_ID, '나는 소프트웨어 엔지니어입니다', '개발자시군요!')

    // mem0는 의미적으로 유사한 입력을 하나의 노드로 병합할 수 있으므로 정확한 노드 수는 강제하지 않는다.
    const seeded = await memory.allNodes(TEST_AGENT_ID)
    assert(seeded.length >= 1, `MI2: 사전 메모리 등록됨 (${seeded.length}개)`)

    const ctx = await createAuthServer(memoryPath)
    const { port, token, sid, shutdown } = ctx

    try {
      const chatRes = await request(port, 'POST', `/api/sessions/${sid}/chat`, { input: '내 이름이 뭐였죠?' }, { token })
      assert(chatRes.status === 200, 'MI2: chat 요청 성공')

      const state = await request(port, 'GET', `/api/sessions/${sid}/state`, null, { token })
      const memories = state.body.context?.memories || []
      assert(memories.length > 0, `MI2: recall된 메모리 존재 (${memories.length}개)`)
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  summary()
}

run()
