/**
 * docs/design/agent-identity-model.md §11.1 — a2a 설정 부팅 가드
 *
 * a2a.enabled=true 일 때 publicUrl 누락 시 서버 부팅 거부.
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

const buildBaseConfig = (llmPort, overrides) => ({
  llm: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: 'test', apiKey: 'k', responseFormat: 'json_object', maxRetries: 0, timeoutMs: 5000 },
  embed: { provider: 'none', baseUrl: null, apiKey: null, model: null, dimensions: 256 },
  locale: 'ko', maxIterations: 5,
  memory: { path: null },
  mcp: [],
  scheduler: { enabled: false, pollIntervalMs: 60000, todoReview: { enabled: false, cron: '0 9 * * *' } },
  delegatePolling: { intervalMs: 60000 },
  agents: [],
  prompt: { maxContextTokens: 8000, reservedOutputTokens: 1000, maxContextChars: null, reservedOutputChars: null },
  ...overrides,
})

const setupDir = async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'a2a-guard-'))
  mkdirSync(join(tmpDir, 'users'), { recursive: true })
  ensureSecret({ basePath: tmpDir })
  const userStore = createUserStore({ basePath: tmpDir })
  // 가장 첫 user 는 admin role 으로 생성됨 — 부팅 시 admin-bootstrap 이 skip.
  await userStore.addUser('admin', 'admin-password-123')
  return tmpDir
}

async function run() {
  console.log('A2A boot guard tests')

  // AG1. enabled=true + publicUrl 없음 → 부팅 거부
  {
    const tmpDir = await setupDir()
    const mockLLM = createMockLLM()
    const llmPort = await mockLLM.start()
    const origDir = process.env.PRESENCE_DIR
    process.env.PRESENCE_DIR = tmpDir

    const badConfig = new Config(buildBaseConfig(llmPort, {
      a2a: { enabled: true, publicUrl: null },
    }))

    let thrown = null
    let server = null
    try {
      const result = await startServer(badConfig, { port: 0, persistenceCwd: tmpDir })
      server = result
    } catch (e) { thrown = e }

    assert(thrown !== null, 'AG1: 부팅 시 throw')
    assert(/publicUrl/.test(thrown?.message || ''), 'AG1: 메시지에 publicUrl 언급')

    if (server) await server.shutdown()
    await mockLLM.close()
    process.env.PRESENCE_DIR = origDir
    rmSync(tmpDir, { recursive: true, force: true })
  }

  // AG2. enabled=true + publicUrl 정상 → 부팅 성공
  {
    const tmpDir = await setupDir()
    const mockLLM = createMockLLM()
    const llmPort = await mockLLM.start()
    const origDir = process.env.PRESENCE_DIR
    process.env.PRESENCE_DIR = tmpDir

    const goodConfig = new Config(buildBaseConfig(llmPort, {
      a2a: { enabled: true, publicUrl: 'https://home.example' },
    }))

    const result = await startServer(goodConfig, { port: 0, persistenceCwd: tmpDir })
    assert(result?.server != null, 'AG2: 서버 인스턴스 반환')

    await result.shutdown()
    await mockLLM.close()
    process.env.PRESENCE_DIR = origDir
    rmSync(tmpDir, { recursive: true, force: true })
  }

  // AG3. enabled=false — publicUrl 여부 무관하게 부팅 성공
  {
    const tmpDir = await setupDir()
    const mockLLM = createMockLLM()
    const llmPort = await mockLLM.start()
    const origDir = process.env.PRESENCE_DIR
    process.env.PRESENCE_DIR = tmpDir

    const defaultConfig = new Config(buildBaseConfig(llmPort, {
      a2a: { enabled: false, publicUrl: null },
    }))

    const result = await startServer(defaultConfig, { port: 0, persistenceCwd: tmpDir })
    assert(result?.server != null, 'AG3: 기본값 (disabled) 부팅 OK')

    await result.shutdown()
    await mockLLM.close()
    process.env.PRESENCE_DIR = origDir
    rmSync(tmpDir, { recursive: true, force: true })
  }

  summary()
}

run()
