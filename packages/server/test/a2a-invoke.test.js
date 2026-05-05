/**
 * docs/design/agent-identity-model.md §11 — POST /a2a/:userId/:agentName
 *
 * JSON-RPC 2.0 경로:
 *   message/send → entry.run(text) → completed/failed task result
 *   tasks/get    → 501 (로컬 sync agent 에는 적용 X)
 *
 * 인증 (KG-17 resolved): Authorization: Bearer <a2a-jwt>. tokenService.signA2aToken(sub)
 * 으로 발급된 JWT 만 통과. canAccessAgent 의 DELEGATE intent 가 verify 후 적용.
 */

import http from 'node:http'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startServer } from '@presence/server'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import { createTokenService, ensureSecret } from '@presence/infra/infra/auth/token.js'
import { Config } from '@presence/infra/infra/config.js'
import { DelegationMode } from '@presence/infra/infra/agents/delegation.js'
import { inspectAccessInvocations, resetAccessInvocations } from '@presence/infra/infra/authz/agent-access.js'
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

  // KG-17: 테스트가 같은 secret 으로 A2A token 발급 — server 가 signA2aToken,
  // 같은 tmpDir 의 server.secret.json 으로 verify. 테스트는 주소 동등.
  const tokenService = createTokenService({ basePath: tmpDir })
  const a2aToken = (sub) => tokenService.signA2aToken(sub)

  return {
    port, tmpDir, mockLLM, origDir, a2aToken,
    userContext: serverInst.userContext,
    cleanup: async () => {
      await serverInst.shutdown()
      await mockLLM.close()
      process.env.PRESENCE_DIR = origDir
      rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

const bearer = (token) => ({ authorization: `Bearer ${token}` })

const rpcRequest = (method, params, id = 'req-1') => ({ jsonrpc: '2.0', id, method, params })

async function run() {
  console.log('A2A invocation tests')

  // AI1. message/send — happy path
  // KG-18: 진입점 #2 (a2a-router) — happy path 가 canAccessAgent 호출 spy 검증
  {
    const ctx = await bootServer()
    resetAccessInvocations()
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'hello' }] } }),
      bearer(ctx.a2aToken('alice')))
    assert(res.status === 200, `AI1: 200 OK (got ${res.status})`)
    assert(res.body.jsonrpc === '2.0', 'AI1: jsonrpc envelope')
    assert(res.body.id === 'req-1', 'AI1: id 보존')
    assert(res.body.result?.status?.state === 'completed', 'AI1: completed')
    const text = res.body.result?.artifacts?.[0]?.parts?.[0]?.text
    assert(text === 'echo: hello', `AI1: artifact text round-trip (got ${text})`)

    // KG-18 spy: 진입점 #2 가 DELEGATE intent 로 canAccessAgent 호출했는지 동적 검증
    const calls = inspectAccessInvocations()
    assert(
      calls.some(c => c.intent === 'delegate' && c.agentId === 'alice/echo' && c.jwtSub === 'alice'),
      'AI1 (KG-18): 진입점 #2 spy — DELEGATE intent + agentId=alice/echo + jwtSub=alice',
    )
    await ctx.cleanup()
  }

  // AI2. Authorization 누락 → 401 missing
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'x' }] } }))
    assert(res.status === 401, `AI2: 401 (got ${res.status})`)
    assert(res.body.error?.code === -32000, 'AI2: AUTH_MISSING code')
    assert(/Bearer/i.test(res.body.error?.message || ''), 'AI2: error message mentions Bearer')
    await ctx.cleanup()
  }

  // AI3. 다른 유저의 agent 접근 → canAccessAgent 거부 (403)
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'intrude' }] } }),
      bearer(ctx.a2aToken('bob')))
    assert(res.status === 403, `AI3: 403 (got ${res.status})`)
    assert(/not-owner|admin-only/.test(res.body.error?.message || ''), 'AI3: access denied reason')
    await ctx.cleanup()
  }

  // AI4. 미존재 agent → 404
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/ghost',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'x' }] } }),
      bearer(ctx.a2aToken('alice')))
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
      bearer(ctx.a2aToken('alice')))
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
      bearer(ctx.a2aToken('alice')))
    assert(res.status === 501, `AI6: 501 (got ${res.status})`)
    assert(res.body.error?.code === -32601, 'AI6: method not found')
    await ctx.cleanup()
  }

  // AI7. unknown method → 400
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('tasks/cancel', {}),
      bearer(ctx.a2aToken('alice')))
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
      bearer(ctx.a2aToken('admin')))
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
      bearer(ctx.a2aToken('alice')))
    assert(res.status === 403, 'AI9: 403')
    assert(/admin-only/.test(res.body.error?.message || ''), 'AI9: admin-only reason')
    await ctx.cleanup()
  }

  // AI10 (KG-17). 위조된 JWT (다른 secret 으로 sign) → 401 invalid signature
  {
    const ctx = await bootServer()
    // 다른 tmpDir 로 별도 secret 생성 → 다른 토큰으로 sign
    const fakeDir = mkdtempSync(join(tmpdir(), 'a2a-fake-'))
    ensureSecret({ basePath: fakeDir })
    const fakeService = createTokenService({ basePath: fakeDir })
    const forged = fakeService.signA2aToken('alice')
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'x' }] } }),
      bearer(forged))
    assert(res.status === 401, `AI10: 401 (got ${res.status})`)
    assert(res.body.error?.code === -32002, 'AI10: AUTH_INVALID code')
    assert(/invalid signature|invalid|signature/i.test(res.body.error?.message || ''), 'AI10: signature error')
    rmSync(fakeDir, { recursive: true, force: true })
    await ctx.cleanup()
  }

  // AI11 (KG-17). access token 을 A2A 경로로 우회 사용 → 401 not an a2a token
  {
    const ctx = await bootServer()
    const accessToken = createTokenService({ basePath: ctx.tmpDir }).signAccessToken({ sub: 'alice', roles: ['user'] })
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'x' }] } }),
      bearer(accessToken))
    assert(res.status === 401, `AI11: 401 (got ${res.status})`)
    assert(res.body.error?.code === -32002, 'AI11: AUTH_INVALID code')
    assert(/not an a2a token/i.test(res.body.error?.message || ''), 'AI11: type 분리 메시지')
    await ctx.cleanup()
  }

  // ---------------------------------------------------------------------------
  // AI12~AI14 — A2A Phase 3 (KG-37) 카드 교환 게이트 + 관계 컨테이너 통합
  // ---------------------------------------------------------------------------

  // AI12. 첫 message/send → upsertOnFirstMeeting + recordMeeting + meeting_count=1
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'hi' }] } }),
      bearer(ctx.a2aToken('alice')))
    assert(res.status === 200, `AI12: 200 OK (got ${res.status})`)
    const rel = ctx.userContext.a2aRelationshipStore.getRelationship({
      localAgentId: 'alice/echo', peerAgentId: 'alice',
    })
    assert(rel !== null, 'AI12: 관계 row 생성됨')
    assert(rel.status === 'active', `AI12: status=active (got ${rel.status})`)
    assert(rel.meetingCount === 1, `AI12: meetingCount=1 (got ${rel.meetingCount})`)
    assert(typeof rel.lastMeetingAt === 'number' && rel.lastMeetingAt > 0, 'AI12: lastMeetingAt 기록')
    await ctx.cleanup()
  }

  // AI13. 두 번째 호출 → 같은 row 재사용, meetingCount=2
  {
    const ctx = await bootServer()
    await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: '1' }] } }, 'r1'),
      bearer(ctx.a2aToken('alice')))
    const res2 = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: '2' }] } }, 'r2'),
      bearer(ctx.a2aToken('alice')))
    assert(res2.status === 200, `AI13: 200 OK (got ${res2.status})`)
    const rel = ctx.userContext.a2aRelationshipStore.getRelationship({
      localAgentId: 'alice/echo', peerAgentId: 'alice',
    })
    assert(rel.meetingCount === 2, `AI13: 2 만남 (got ${rel.meetingCount})`)
    // 1:1 고정 — 다른 관계 row 생성 안 됨
    const list = ctx.userContext.a2aRelationshipStore.listForLocal({ localAgentId: 'alice/echo' })
    assert(list.length === 1, `AI13: 1 row (1:1 고정, got ${list.length})`)
    await ctx.cleanup()
  }

  // AI13b. 서로 다른 (localAgent, caller) → 별도 row — 1:1 composite PK 라우터 검증
  // codex round 1 #6: 다른 caller 가 정말 다른 row 를 만드는지 확인. Phase 3 한계
  // (peerAgentId = JWT caller) 위에서 재현 가능한 가장 직접적 케이스 = admin 자기
  // 자신의 agent 를 등록 + alice 자기 자신의 agent 를 등록 → 두 caller 가 각자
  // owner 로서 호출. 같은 store 안에서 row 가 분리되는지 검증.
  {
    const ctx = await bootServer()
    // admin 도 자기 agent 등록 (alice/echo 는 boot 단계에 이미 등록됨)
    ctx.userContext.agentRegistry.register({
      agentId: 'admin/echo',
      type: DelegationMode.LOCAL,
      run: async (task) => `admin-echo: ${task}`,
    })
    await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'a' }] } }, 'r1'),
      bearer(ctx.a2aToken('alice')))
    await postJson(ctx.port, '/a2a/admin/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'b' }] } }, 'r2'),
      bearer(ctx.a2aToken('admin')))

    const aliceRel = ctx.userContext.a2aRelationshipStore.getRelationship({
      localAgentId: 'alice/echo', peerAgentId: 'alice',
    })
    const adminRel = ctx.userContext.a2aRelationshipStore.getRelationship({
      localAgentId: 'admin/echo', peerAgentId: 'admin',
    })
    assert(aliceRel !== null && aliceRel.meetingCount === 1, 'AI13b: alice row 생성 + count=1')
    assert(adminRel !== null && adminRel.meetingCount === 1, 'AI13b: admin row 생성 + count=1')

    // listForLocal 별 1 row 씩 — 다른 localAgent 의 row 가 섞이지 않음
    const aliceList = ctx.userContext.a2aRelationshipStore.listForLocal({ localAgentId: 'alice/echo' })
    const adminList = ctx.userContext.a2aRelationshipStore.listForLocal({ localAgentId: 'admin/echo' })
    assert(aliceList.length === 1, `AI13b: alice/echo 1 row (got ${aliceList.length})`)
    assert(adminList.length === 1, `AI13b: admin/echo 1 row (got ${adminList.length})`)
    assert(aliceList[0].peerAgentId === 'alice', 'AI13b: alice row 의 peerAgentId=alice')
    assert(adminList[0].peerAgentId === 'admin', 'AI13b: admin row 의 peerAgentId=admin')
    await ctx.cleanup()
  }

  // AI13c. dispatch validation 실패 (non-runnable agent) → meeting 미기록.
  // codex round 1 Additional: meetingCount 가 dispatch 검증 앞에서 증가하면
  // 실패 호출도 만남으로 카운트되어 "meeting = request/response pair" 의미론
  // 위반. fix 후: entry 검증/isLocalRunnable 통과 후에만 recordMeeting.
  {
    const ctx = await bootServer()
    // REMOTE 타입 agent 등록 — canAccessAgent / canStartA2aSession 는 통과하지만
    // isLocalRunnable === false → 400 dispatch validation 실패
    ctx.userContext.agentRegistry.register({
      agentId: 'alice/remote',
      type: DelegationMode.REMOTE,
      description: 'remote agent (non-runnable)',
      // run 함수 없음
    })
    const res = await postJson(ctx.port, '/a2a/alice/remote',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'x' }] } }),
      bearer(ctx.a2aToken('alice')))
    assert(res.status === 400, `AI13c: 400 not invokable (got ${res.status})`)
    assert(/not invokable/.test(res.body.error?.message || ''), 'AI13c: not invokable 메시지')

    const rel = ctx.userContext.a2aRelationshipStore.getRelationship({
      localAgentId: 'alice/remote', peerAgentId: 'alice',
    })
    assert(rel === null, `AI13c: 실패 dispatch 는 만남으로 기록되지 않음 (got ${rel ? JSON.stringify(rel) : 'null'})`)
    await ctx.cleanup()
  }

  // AI14. closeRelationship 후 호출 → 403 ACCESS_DENIED + 'relationship closed'
  {
    const ctx = await bootServer()
    // 첫 호출로 관계 생성
    await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'first' }] } }, 'r1'),
      bearer(ctx.a2aToken('alice')))
    // 사용자가 관계 폐기
    ctx.userContext.a2aRelationshipStore.closeRelationship({
      localAgentId: 'alice/echo', peerAgentId: 'alice',
    })
    // 두 번째 호출 — closed 관계 → 403
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'after-close' }] } }, 'r2'),
      bearer(ctx.a2aToken('alice')))
    assert(res.status === 403, `AI14: 403 (got ${res.status})`)
    assert(/relationship closed/.test(res.body.error?.message || ''),
      `AI14: relationship closed 메시지 (got ${res.body.error?.message})`)
    // meetingCount 가 close 후 호출에서 안 늘어났는지 확인 (recordMeeting throw 후 트랜잭션 롤백)
    const rel = ctx.userContext.a2aRelationshipStore.getRelationship({
      localAgentId: 'alice/echo', peerAgentId: 'alice',
    })
    assert(rel.meetingCount === 1, `AI14: closed 후 meetingCount 불변 (got ${rel.meetingCount})`)
    await ctx.cleanup()
  }

  summary()
}

run()
