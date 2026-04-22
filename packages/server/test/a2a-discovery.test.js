/**
 * docs/design/agent-identity-model.md §11 — /a2a discovery endpoints
 *
 * GET /a2a/.well-known/agents — 로컬 agent 카드 목록
 * GET /a2a/:userId/:agentName/card — 단일 agent 카드
 *
 * enabled=true + publicUrl 이 세팅되었을 때만 마운트.
 */

import http from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startServer } from '@presence/server'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import { ensureSecret } from '@presence/infra/infra/auth/token.js'
import { Config } from '@presence/infra/infra/config.js'
import { assert, summary } from '../../../test/lib/assert.js'

const createMockLLM = () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }))
  })
  return {
    start: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise(r => server.close(r)),
  }
}

const get = (port, path) => new Promise((resolve, reject) => {
  http.get({ hostname: '127.0.0.1', port, path }, (res) => {
    let buf = ''
    res.on('data', d => { buf += d })
    res.on('end', () => {
      try { resolve({ status: res.statusCode, body: JSON.parse(buf) }) }
      catch { resolve({ status: res.statusCode, body: buf }) }
    })
  }).on('error', reject)
})

const buildConfig = (llmPort, overrides) => new Config({
  llm: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: 'test', apiKey: 'k', responseFormat: 'json_object', maxRetries: 0, timeoutMs: 5000 },
  embed: { provider: 'none', baseUrl: null, apiKey: null, model: null, dimensions: 256 },
  locale: 'ko', maxIterations: 5,
  memory: { path: null },
  mcp: [],
  scheduler: { enabled: false, pollIntervalMs: 60000, todoReview: { enabled: false, cron: '0 9 * * *' } },
  delegatePolling: { intervalMs: 60000 },
  agents: [],
  prompt: { maxContextTokens: 8000, reservedOutputTokens: 1000, maxContextChars: null, reservedOutputChars: null },
  tools: { allowedDirs: ['/tmp'] },
  ...overrides,
})

const setupDir = async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'a2a-disc-'))
  mkdirSync(join(tmpDir, 'users'), { recursive: true })
  ensureSecret({ basePath: tmpDir })
  const userStore = createUserStore({ basePath: tmpDir })
  await userStore.addUser('admin', 'admin-password-123')
  return tmpDir
}

async function run() {
  console.log('A2A discovery tests')

  // AD1. enabled=true — /a2a/.well-known/agents 응답
  {
    const tmpDir = await setupDir()
    const mockLLM = createMockLLM()
    const llmPort = await mockLLM.start()
    const origDir = process.env.PRESENCE_DIR
    process.env.PRESENCE_DIR = tmpDir

    const config = buildConfig(llmPort, {
      a2a: { enabled: true, publicUrl: 'https://home.example' },
    })
    const { server, shutdown, userContext } = await startServer(config, { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    // 서버는 기본적으로 summarizer + default agent 를 등록
    const res = await get(port, '/a2a/.well-known/agents')
    assert(res.status === 200, 'AD1: 200 OK')
    assert(Array.isArray(res.body.agents), 'AD1: agents 배열 반환')
    assert(res.body.agents.length >= 1, `AD1: 최소 1 카드 (got ${res.body.agents.length})`)
    const sampleCard = res.body.agents[0]
    assert(sampleCard['x-presence']?.agentId != null, 'AD1: 카드에 x-presence.agentId')
    assert(sampleCard.url.startsWith('https://home.example/a2a/'), 'AD1: publicUrl 접두사')

    await shutdown()
    await mockLLM.close()
    process.env.PRESENCE_DIR = origDir
    rmSync(tmpDir, { recursive: true, force: true })
  }

  // AD2. enabled=true — 단일 agent 카드 조회
  {
    const tmpDir = await setupDir()
    const mockLLM = createMockLLM()
    const llmPort = await mockLLM.start()
    const origDir = process.env.PRESENCE_DIR
    process.env.PRESENCE_DIR = tmpDir

    const config = buildConfig(llmPort, {
      a2a: { enabled: true, publicUrl: 'https://home.example' },
    })
    const { server, shutdown, userContext } = await startServer(config, { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    // summarizer 는 user-context 에서 `{username}/summarizer` 로 등록됨 — username 이 없을 때 'default' fallback
    const list = await get(port, '/a2a/.well-known/agents')
    const first = list.body.agents[0]
    const [userId, agentName] = first['x-presence'].agentId.split('/')

    const res = await get(port, `/a2a/${userId}/${agentName}/card`)
    assert(res.status === 200, `AD2: 단일 카드 200 (got ${res.status})`)
    assert(res.body['x-presence'].agentId === `${userId}/${agentName}`, 'AD2: agentId 일치')
    assert(res.body.url === `https://home.example/a2a/${userId}/${agentName}`, 'AD2: url 일치')

    await shutdown()
    await mockLLM.close()
    process.env.PRESENCE_DIR = origDir
    rmSync(tmpDir, { recursive: true, force: true })
  }

  // AD3. 단일 카드 — 미존재 agent → 404
  {
    const tmpDir = await setupDir()
    const mockLLM = createMockLLM()
    const llmPort = await mockLLM.start()
    const origDir = process.env.PRESENCE_DIR
    process.env.PRESENCE_DIR = tmpDir

    const config = buildConfig(llmPort, {
      a2a: { enabled: true, publicUrl: 'https://home.example' },
    })
    const { server, shutdown } = await startServer(config, { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    const res = await get(port, '/a2a/ghost/missing/card')
    assert(res.status === 404, `AD3: 미존재 → 404 (got ${res.status})`)

    await shutdown()
    await mockLLM.close()
    process.env.PRESENCE_DIR = origDir
    rmSync(tmpDir, { recursive: true, force: true })
  }

  // AD4. enabled=false — /a2a/* 라우트 미존재 → 404 (정적 catch-all 로 이동)
  {
    const tmpDir = await setupDir()
    const mockLLM = createMockLLM()
    const llmPort = await mockLLM.start()
    const origDir = process.env.PRESENCE_DIR
    process.env.PRESENCE_DIR = tmpDir

    const config = buildConfig(llmPort, {
      a2a: { enabled: false, publicUrl: null },
    })
    const { server, shutdown } = await startServer(config, { port: 0, persistenceCwd: tmpDir })
    const port = server.address().port

    const res = await get(port, '/a2a/.well-known/agents')
    // enabled=false 일 때 /a2a/* 라우트 미등록 → catch-all 정적 핸들러로 넘어가거나 404.
    // agents JSON 응답이 아니어야 한다는 것만 확인.
    const isAgentsResponse = typeof res.body === 'object' && Array.isArray(res.body.agents)
    assert(!isAgentsResponse, `AD4: enabled=false 에서 agents JSON 응답 안됨`)

    await shutdown()
    await mockLLM.close()
    process.env.PRESENCE_DIR = origDir
    rmSync(tmpDir, { recursive: true, force: true })
  }

  summary()
}

run()
