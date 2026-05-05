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

  // 테스트용 agent 등록 (LOCAL + run 함수).
  // Phase 4 (KG-37-PEER): caller agent 도 등록 필수 (V4 — registry 검증).
  // §3D fixture 변경 요약 — alice/echo (callee) + alice/sender / alice/translator
  // (alice 측 callers) + bob/sender (bob 측 caller, AI3 NOT_OWNER 검증) +
  // admin/echo (admin 측 callee/caller, AI13b).
  const reg = serverInst.userContext.agentRegistry
  reg.register({
    agentId: 'alice/echo', type: DelegationMode.LOCAL,
    description: 'echo agent', run: async (task) => `echo: ${task}`,
  })
  reg.register({ agentId: 'alice/sender', type: DelegationMode.LOCAL, run: async () => 'alice-send' })
  reg.register({ agentId: 'alice/translator', type: DelegationMode.LOCAL, run: async () => 'alice-translate' })
  reg.register({ agentId: 'bob/sender', type: DelegationMode.LOCAL, run: async () => 'bob-send' })
  reg.register({ agentId: 'admin/echo', type: DelegationMode.LOCAL, run: async (t) => `admin-echo: ${t}` })
  reg.register({ agentId: 'admin/sender', type: DelegationMode.LOCAL, run: async () => 'admin-send' })

  // KG-17: 테스트가 같은 secret 으로 A2A token 발급 — server 가 signA2aToken,
  // 같은 tmpDir 의 server.secret.json 으로 verify. 테스트는 주소 동등.
  // Phase 4 (KG-37-PEER): a2aToken 헬퍼가 agentId 옵션 받음.
  const tokenService = createTokenService({ basePath: tmpDir })
  const a2aToken = (sub, opts = {}) => tokenService.signA2aToken(sub, opts)

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
      bearer(ctx.a2aToken('alice', { agentId: 'alice/sender' })))
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
      bearer(ctx.a2aToken('bob', { agentId: 'bob/sender' })))
    assert(res.status === 403, `AI3: 403 (got ${res.status})`)
    assert(/not-owner|admin-only/.test(res.body.error?.message || ''), 'AI3: access denied reason')
    await ctx.cleanup()
  }

  // AI4. 미존재 agent → 404
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/ghost',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'x' }] } }),
      bearer(ctx.a2aToken('alice', { agentId: 'alice/sender' })))
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
      bearer(ctx.a2aToken('alice', { agentId: 'alice/sender' })))
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
      bearer(ctx.a2aToken('alice', { agentId: 'alice/sender' })))
    assert(res.status === 501, `AI6: 501 (got ${res.status})`)
    assert(res.body.error?.code === -32601, 'AI6: method not found')
    await ctx.cleanup()
  }

  // AI7. unknown method → 400
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('tasks/cancel', {}),
      bearer(ctx.a2aToken('alice', { agentId: 'alice/sender' })))
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
      bearer(ctx.a2aToken('admin', { agentId: 'admin/echo' })))
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
      bearer(ctx.a2aToken('alice', { agentId: 'alice/sender' })))
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
  // Phase 4: peerAgentId 가 caller agent (alice/sender) — Phase 3 의 user-level 'alice' 에서 변경.
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'hi' }] } }),
      bearer(ctx.a2aToken('alice', { agentId: 'alice/sender' })))
    assert(res.status === 200, `AI12: 200 OK (got ${res.status})`)
    const rel = ctx.userContext.a2aRelationshipStore.getRelationship({
      localAgentId: 'alice/echo', peerAgentId: 'alice/sender',
    })
    assert(rel !== null, 'AI12: 관계 row 생성됨 (peerAgentId=alice/sender)')
    assert(rel.status === 'active', `AI12: status=active (got ${rel.status})`)
    assert(rel.meetingCount === 1, `AI12: meetingCount=1 (got ${rel.meetingCount})`)
    assert(typeof rel.lastMeetingAt === 'number' && rel.lastMeetingAt > 0, 'AI12: lastMeetingAt 기록')
    await ctx.cleanup()
  }

  // AI13. 두 번째 호출 (같은 caller agent) → 같은 row 재사용, meetingCount=2
  {
    const ctx = await bootServer()
    await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: '1' }] } }, 'r1'),
      bearer(ctx.a2aToken('alice', { agentId: 'alice/sender' })))
    const res2 = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: '2' }] } }, 'r2'),
      bearer(ctx.a2aToken('alice', { agentId: 'alice/sender' })))
    assert(res2.status === 200, `AI13: 200 OK (got ${res2.status})`)
    const rel = ctx.userContext.a2aRelationshipStore.getRelationship({
      localAgentId: 'alice/echo', peerAgentId: 'alice/sender',
    })
    assert(rel.meetingCount === 2, `AI13: 2 만남 (got ${rel.meetingCount})`)
    // 같은 caller agent 가 두 번 호출 — 1 row 재사용
    const list = ctx.userContext.a2aRelationshipStore.listForLocal({ localAgentId: 'alice/echo' })
    assert(list.length === 1, `AI13: 1 row (같은 peer 재사용, got ${list.length})`)
    await ctx.cleanup()
  }

  // AI13b. 서로 다른 user 의 caller agent → 별도 row (admin/sender 사용 — V5 self-call 회피).
  {
    const ctx = await bootServer()
    await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'a' }] } }, 'r1'),
      bearer(ctx.a2aToken('alice', { agentId: 'alice/sender' })))
    await postJson(ctx.port, '/a2a/admin/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'b' }] } }, 'r2'),
      bearer(ctx.a2aToken('admin', { agentId: 'admin/sender' })))  // V5 회피 — admin/sender → admin/echo

    const aliceRel = ctx.userContext.a2aRelationshipStore.getRelationship({
      localAgentId: 'alice/echo', peerAgentId: 'alice/sender',
    })
    const adminRel = ctx.userContext.a2aRelationshipStore.getRelationship({
      localAgentId: 'admin/echo', peerAgentId: 'admin/sender',
    })
    assert(aliceRel !== null && aliceRel.meetingCount === 1, 'AI13b: alice row 생성 + count=1')
    assert(adminRel !== null && adminRel.meetingCount === 1, 'AI13b: admin row 생성 + count=1')

    const aliceList = ctx.userContext.a2aRelationshipStore.listForLocal({ localAgentId: 'alice/echo' })
    const adminList = ctx.userContext.a2aRelationshipStore.listForLocal({ localAgentId: 'admin/echo' })
    assert(aliceList.length === 1, `AI13b: alice/echo 1 row (got ${aliceList.length})`)
    assert(adminList.length === 1, `AI13b: admin/echo 1 row (got ${adminList.length})`)
    assert(aliceList[0].peerAgentId === 'alice/sender', 'AI13b: alice row 의 peerAgentId=alice/sender')
    assert(adminList[0].peerAgentId === 'admin/sender', 'AI13b: admin row 의 peerAgentId=admin/sender')
    await ctx.cleanup()
  }

  // AI13c. dispatch validation 실패 (non-runnable agent) → meeting 미기록.
  {
    const ctx = await bootServer()
    ctx.userContext.agentRegistry.register({
      agentId: 'alice/remote',
      type: DelegationMode.REMOTE,
      description: 'remote agent (non-runnable)',
    })
    const res = await postJson(ctx.port, '/a2a/alice/remote',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'x' }] } }),
      bearer(ctx.a2aToken('alice', { agentId: 'alice/sender' })))
    assert(res.status === 400, `AI13c: 400 not invokable (got ${res.status})`)
    assert(/not invokable/.test(res.body.error?.message || ''), 'AI13c: not invokable 메시지')

    const rel = ctx.userContext.a2aRelationshipStore.getRelationship({
      localAgentId: 'alice/remote', peerAgentId: 'alice/sender',
    })
    assert(rel === null, `AI13c: 실패 dispatch 는 만남으로 기록되지 않음 (got ${rel ? JSON.stringify(rel) : 'null'})`)
    await ctx.cleanup()
  }

  // AI14. closeRelationship 후 호출 → 403 ACCESS_DENIED + 'relationship closed'.
  // Phase 4: closed peer = caller agent (alice/sender). user-level closed 는 AI-Y8 별도.
  {
    const ctx = await bootServer()
    await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'first' }] } }, 'r1'),
      bearer(ctx.a2aToken('alice', { agentId: 'alice/sender' })))
    ctx.userContext.a2aRelationshipStore.closeRelationship({
      localAgentId: 'alice/echo', peerAgentId: 'alice/sender',
    })
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'after-close' }] } }, 'r2'),
      bearer(ctx.a2aToken('alice', { agentId: 'alice/sender' })))
    assert(res.status === 403, `AI14: 403 (got ${res.status})`)
    assert(/relationship closed/.test(res.body.error?.message || ''),
      `AI14: relationship closed 메시지 (got ${res.body.error?.message})`)
    const rel = ctx.userContext.a2aRelationshipStore.getRelationship({
      localAgentId: 'alice/echo', peerAgentId: 'alice/sender',
    })
    assert(rel.meetingCount === 1, `AI14: closed 후 meetingCount 불변 (got ${rel.meetingCount})`)
    await ctx.cleanup()
  }

  // ---------------------------------------------------------------------------
  // AI-Y1~Y8 — A2A Phase 4 (KG-37-PEER) — 검증 5단 + Phase 3 closed-row 안전망
  // ---------------------------------------------------------------------------

  // AI-Y1. agentId claim 없는 token → 401 + "missing agentId claim"
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'x' }] } }),
      bearer(ctx.a2aToken('alice')))  // agentId opt 미전달
    assert(res.status === 401, `AI-Y1: 401 (got ${res.status})`)
    assert(/missing agentId claim/.test(res.body.error?.message || ''),
      `AI-Y1: missing agentId 메시지 (got ${res.body.error?.message})`)
    await ctx.cleanup()
  }

  // AI-Y2. agentId claim invalid 형식 → 401 + "agentId invalid"
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'x' }] } }),
      bearer(ctx.a2aToken('alice', { agentId: 'no-slash-format' })))
    assert(res.status === 401, `AI-Y2: 401 (got ${res.status})`)
    assert(/agentId invalid/.test(res.body.error?.message || ''),
      `AI-Y2: agentId invalid 메시지 (got ${res.body.error?.message})`)
    await ctx.cleanup()
  }

  // AI-Y3. sub/agentId user mismatch → 401 + "user mismatch"
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'x' }] } }),
      bearer(ctx.a2aToken('alice', { agentId: 'bob/sender' })))  // sub=alice, agentId=bob/*
    assert(res.status === 401, `AI-Y3: 401 (got ${res.status})`)
    assert(/user mismatch/.test(res.body.error?.message || ''),
      `AI-Y3: user mismatch 메시지 (got ${res.body.error?.message})`)
    await ctx.cleanup()
  }

  // AI-Y4. caller agentId registry 미등록 → 401 + generic "agentId not registered"
  // codex round 2 #4 — IFC: 응답에 caller agentId 자체는 노출 안 함 (registry
  // inventory leak 방지). 정확한 식별자는 logger 에만.
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'x' }] } }),
      bearer(ctx.a2aToken('alice', { agentId: 'alice/ghost' })))  // alice/ghost 미등록
    assert(res.status === 401, `AI-Y4: 401 (got ${res.status})`)
    assert(/A2A token agentId not registered$/.test(res.body.error?.message || ''),
      `AI-Y4: generic not registered (응답 끝, got ${res.body.error?.message})`)
    assert(!/alice\/ghost/.test(res.body.error?.message || ''),
      `AI-Y4: 응답에 specific agentId 노출 안 됨 (got ${res.body.error?.message})`)
    await ctx.cleanup()
  }

  // AI-Y5. self-call (callerAgentId === callee) → 400 + "self-call denied"
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'x' }] } }),
      bearer(ctx.a2aToken('alice', { agentId: 'alice/echo' })))  // 자기 자신 호출
    assert(res.status === 400, `AI-Y5: 400 (got ${res.status})`)
    assert(/self-call denied/.test(res.body.error?.message || ''),
      `AI-Y5: self-call denied 메시지 (got ${res.body.error?.message})`)
    await ctx.cleanup()
  }

  // AI-Y6. 정상 — store row 의 peerAgentId === 'alice/sender' (Phase 4 의미론)
  {
    const ctx = await bootServer()
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'normal' }] } }),
      bearer(ctx.a2aToken('alice', { agentId: 'alice/sender' })))
    assert(res.status === 200, `AI-Y6: 200 (got ${res.status})`)
    const rel = ctx.userContext.a2aRelationshipStore.getRelationship({
      localAgentId: 'alice/echo', peerAgentId: 'alice/sender',
    })
    assert(rel !== null && rel.meetingCount === 1, 'AI-Y6: row 생성 + count=1')
    assert(rel.peerAgentId === 'alice/sender', 'AI-Y6: peerAgentId 가 agent-level (alice/sender)')
    await ctx.cleanup()
  }

  // AI-Y7. composite PK 분리 — 같은 user 의 두 caller agent 가 별도 row.
  // **KG-37-PEER 핵심 증명** — Phase 3 에서는 두 caller 가 sub='alice' 로 합쳐졌음.
  {
    const ctx = await bootServer()
    await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: '1' }] } }, 'r1'),
      bearer(ctx.a2aToken('alice', { agentId: 'alice/sender' })))
    await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: '2' }] } }, 'r2'),
      bearer(ctx.a2aToken('alice', { agentId: 'alice/translator' })))

    const list = ctx.userContext.a2aRelationshipStore.listForLocal({ localAgentId: 'alice/echo' })
    assert(list.length === 2, `AI-Y7: 2 row (caller agent 별 분리, got ${list.length})`)
    const peerIds = list.map(r => r.peerAgentId).sort()
    assert(peerIds[0] === 'alice/sender' && peerIds[1] === 'alice/translator',
      `AI-Y7: peerAgentId 가 alice/sender + alice/translator (got ${peerIds.join(',')})`)
    // 각 row 가 meetingCount=1 — Phase 3 처럼 합쳐지지 않음
    for (const rel of list) {
      assert(rel.meetingCount === 1, `AI-Y7: 각 row meetingCount=1 (got ${rel.meetingCount} for ${rel.peerAgentId})`)
    }
    await ctx.cleanup()
  }

  // AI-Y8. Phase 3 user-level closed row 우회 차단 (best-effort safety net).
  {
    const ctx = await bootServer()
    // store 직접 호출 — Phase 3 legacy 시나리오 모사 (peerAgentId=user-level 'alice')
    ctx.userContext.a2aRelationshipStore.upsertOnFirstMeeting({
      localAgentId: 'alice/echo', peerAgentId: 'alice',
    })
    ctx.userContext.a2aRelationshipStore.closeRelationship({
      localAgentId: 'alice/echo', peerAgentId: 'alice',
    })
    // Phase 4 caller agent 로 호출 → user-level closed safety net 으로 차단
    const res = await postJson(ctx.port, '/a2a/alice/echo',
      rpcRequest('message/send', { message: { parts: [{ kind: 'text', text: 'x' }] } }),
      bearer(ctx.a2aToken('alice', { agentId: 'alice/sender' })))
    assert(res.status === 403, `AI-Y8: 403 (got ${res.status})`)
    // codex round 1 #5 — caller 응답은 generic 'a2a session denied: a2a-denied'.
    // legacy 사유는 logger 에만. 즉 'a2a-denied' 만 검증.
    assert(/a2a session denied: a2a-denied/.test(res.body.error?.message || ''),
      `AI-Y8: generic deny 메시지 (got ${res.body.error?.message})`)
    assert(!/user-level|legacy/.test(res.body.error?.message || ''),
      `AI-Y8: 응답에 legacy 사유 노출 안 됨 (IFC 위반 차단, got ${res.body.error?.message})`)
    // agent-level row 는 생성되지 않음
    const agentLevel = ctx.userContext.a2aRelationshipStore.getRelationship({
      localAgentId: 'alice/echo', peerAgentId: 'alice/sender',
    })
    assert(agentLevel === null, 'AI-Y8: safety net 차단 시 agent-level row 미생성')
    await ctx.cleanup()
  }

  summary()
}

run()
