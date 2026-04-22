/**
 * docs/design/agent-identity-model.md §11 — POST /a2a/:userId/:agentName
 *
 * JSON-RPC 2.0 경로:
 *   message/send → entry.run(text) → completed/failed task result
 *   tasks/get    → 501 (로컬 sync agent 에는 적용 X)
 *
 * 인증: stub (X-Presence-Caller 헤더). canAccessAgent 의 DELEGATE intent.
 */

import http from 'node:http'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startServer } from '@presence/server'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import { ensureSecret } from '@presence/infra/infra/auth/token.js'
import { Config } from '@presence/infra/infra/config.js'
import { DelegationMode } from '@presence/infra/infra/agents/delegation.js'
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

const postJson = (port, path, body, headers = {}) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body)
  const req = http.request({
    hostname: '127.0.0.1', port, path, method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
      ...headers,
    },
  }, (res) => {
    let buf = ''
    res.on('data', d => { buf += d })
    res.on('end', () => {
      try { resolve({ status: res.statusCode, body: JSON.parse(buf) }) }
      catch { resolve({ status: res.statusCode, body: buf }) }
    })
  })
  req.on('error', reject)
  req.write(data)
  req.end()
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
  const tmpDir = mkdtempSync(join(tmpdir(), 'a2a-inv-'))
  mkdirSync(join(tmpDir, 'users'), { recursive: true })
  ensureSecret({ basePath: tmpDir })
  const userStore = createUserStore({ basePath: tmpDir })
  await userStore.addUser('admin', 'admin-password-123')
  return tmpDir
}

const bootServer = async () => {
  const tmpDir = await setupDir()
  const mockLLM = createMockLLM()
  const llmPort = await mockLLM.start()
  const origDir = process.env.PRESENCE_DIR
  process.env.PRESENCE_DIR = tmpDir

  const config = buildConfig(llmPort, {
    a2a: { enabled: true, publicUrl: 'https://home.example' },
  })
  const serverInst = await startServer(config, { port: 0, persistenceCwd: tmpDir })
  const port = serverInst.server.address().port

  // 테스트용 agent 등록 (LOCAL + run 함수)
  serverInst.userContext.agentRegistry.register({
    agentId: 'alice/echo',
    type: DelegationMode.LOCAL,
    description: 'echo agent',
    run: async (task) => `echo: ${task}`,
  })

  return {
    port, tmpDir, mockLLM, origDir,
    userContext: serverInst.userContext,
    cleanup: async () => {
      await serverInst.shutdown()
      await mockLLM.close()
      process.env.PRESENCE_DIR = origDir
      rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

const rpcRequest = (method, params, id = 'req-1') => ({ jsonrpc: '2.0', id, method, params })

async function run() {
  console.log('A2A invocation tests')

  // AI1. message/send — happy path
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'hello' }] } }),
      { 'x-presence-caller': 'alice' })
    assert(res.status === 200, `AI1: 200 OK (got ${res.status})`)
    assert(res.body.jsonrpc === '2.0', 'AI1: jsonrpc envelope')
    assert(res.body.id === 'req-1', 'AI1: id 보존')
    assert(res.body.result?.status?.state === 'completed', 'AI1: completed')
    const text = res.body.result?.artifacts?.[0]?.parts?.[0]?.text
    assert(text === 'echo: hello', `AI1: artifact text round-trip (got ${text})`)
    await ctx.cleanup()
  }

  // AI2. caller header 누락 → 401
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'x' }] } }))
    assert(res.status === 401, `AI2: 401 (got ${res.status})`)
    assert(res.body.error?.code === -32000, 'AI2: JSON-RPC error code')
    assert(/caller/i.test(res.body.error?.message || ''), 'AI2: error message')
    await ctx.cleanup()
  }

  // AI3. 다른 유저의 agent 접근 → canAccessAgent 거부 (403)
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'intrude' }] } }),
      { 'x-presence-caller': 'bob' })
    assert(res.status === 403, `AI3: 403 (got ${res.status})`)
    assert(/not-owner|admin-only/.test(res.body.error?.message || ''), 'AI3: access denied reason')
    await ctx.cleanup()
  }

  // AI4. 미존재 agent → 404
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/ghost',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'x' }] } }),
      { 'x-presence-caller': 'alice' })
    assert(res.status === 404, `AI4: 404 (got ${res.status})`)
    await ctx.cleanup()
  }

  // AI5. agent.run() throws → failed task result (200 with failed state)
  {
    const ctx = await bootServer()
    ctx.userContext.agentRegistry.register({
      agentId: 'alice/crasher',
      type: DelegationMode.LOCAL,
      run: async () => { throw new Error('agent crashed') },
    })
    const res = await postJson(ctx.port, '/a2a/alice/crasher',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'x' }] } }),
      { 'x-presence-caller': 'alice' })
    assert(res.status === 200, 'AI5: 200 OK (JSON-RPC success envelope)')
    assert(res.body.result?.status?.state === 'failed', 'AI5: failed task state')
    const text = res.body.result?.status?.message?.parts?.[0]?.text
    assert(text === 'agent crashed', `AI5: error reason (got ${text})`)
    await ctx.cleanup()
  }

  // AI6. tasks/get → 501 (로컬 sync agent 미지원)
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('tasks/get', { id: 'some-task' }),
      { 'x-presence-caller': 'alice' })
    assert(res.status === 501, `AI6: 501 (got ${res.status})`)
    assert(res.body.error?.code === -32601, 'AI6: method not found')
    await ctx.cleanup()
  }

  // AI7. unknown method → 400
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('tasks/cancel', {}),
      { 'x-presence-caller': 'alice' })
    assert(res.status === 400, `AI7: 400 (got ${res.status})`)
    assert(/method not found/.test(res.body.error?.message || ''), 'AI7: method not found msg')
    await ctx.cleanup()
  }

  // AI8. admin 이 본인 agent 호출 — allow
  {
    const ctx = await bootServer()
    ctx.userContext.agentRegistry.register({
      agentId: 'admin/helper',
      type: DelegationMode.LOCAL,
      run: async (t) => `admin-helper: ${t}`,
    })
    const res = await postJson(ctx.port, '/a2a/admin/helper',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'hi' }] } }),
      { 'x-presence-caller': 'admin' })
    assert(res.status === 200, 'AI8: 200')
    assert(res.body.result?.status?.state === 'completed', 'AI8: completed')
    await ctx.cleanup()
  }

  // AI9. 일반 user 가 admin/* 접근 → admin-only
  {
    const ctx = await bootServer()
    ctx.userContext.agentRegistry.register({
      agentId: 'admin/helper',
      type: DelegationMode.LOCAL,
      run: async () => 'unused',
    })
    const res = await postJson(ctx.port, '/a2a/admin/helper',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'x' }] } }),
      { 'x-presence-caller': 'alice' })
    assert(res.status === 403, 'AI9: 403')
    assert(/admin-only/.test(res.body.error?.message || ''), 'AI9: admin-only reason')
    await ctx.cleanup()
  }

  summary()
}

run()
