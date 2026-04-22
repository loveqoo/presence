import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runAdminBootstrap } from '@presence/infra/infra/admin-bootstrap.js'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import {
  STATUS,
  loadAgentPolicies,
  getActiveAgentCount,
  submitUserAgent,
  approveUserAgent,
  denyUserAgent,
  listPending, listApproved, listRejected,
  readPendingRequest,
} from '@presence/infra/infra/authz/agent-governance.js'
import { assert, summary } from '../../../test/lib/assert.js'

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

const createTmpDir = () => {
  const dir = join(tmpdir(), `presence-governance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const initAdminBootstrap = async (dir) => {
  const userStore = createUserStore({ basePath: dir })
  await runAdminBootstrap({ userStore, presenceDir: dir, logger: silentLogger })
}

const writeUserConfig = (dir, username, data) => {
  const userDir = join(dir, 'users', username)
  mkdirSync(userDir, { recursive: true })
  writeFileSync(join(userDir, 'config.json'), JSON.stringify(data, null, 2))
}

const readUserConfig = (dir, username) => {
  return JSON.parse(readFileSync(join(dir, 'users', username, 'config.json'), 'utf-8'))
}

const overridePolicies = (dir, policies) => {
  writeFileSync(join(dir, 'users', 'admin', 'agent-policies.json'), JSON.stringify(policies, null, 2))
}

const samplePersona = { systemPrompt: 'Test persona', rules: [], tools: [] }

async function run() {
  console.log('Agent governance tests')

  // GV1. loadAgentPolicies — 파일 없으면 기본값
  {
    const dir = createTmpDir()
    const policies = loadAgentPolicies(dir)
    assert(policies.maxAgentsPerUser === 5, 'GV1: default maxAgentsPerUser=5')
    assert(policies.autoApproveUnderQuota === true, 'GV1: default autoApprove=true')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV2. loadAgentPolicies — 파일 있으면 값 반영
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    overridePolicies(dir, { maxAgentsPerUser: 3, autoApproveUnderQuota: false })
    const policies = loadAgentPolicies(dir)
    assert(policies.maxAgentsPerUser === 3, 'GV2: override maxAgentsPerUser=3')
    assert(policies.autoApproveUnderQuota === false, 'GV2: override autoApprove=false')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV3. getActiveAgentCount — 0 / 3 / archived 제외
  {
    const dir = createTmpDir()
    assert(getActiveAgentCount('ghost', { basePath: dir }) === 0, 'GV3a: no config → 0')

    writeUserConfig(dir, 'alice', {
      agents: [
        { name: 'a', archived: false },
        { name: 'b', archived: false },
        { name: 'c', archived: true },
      ],
    })
    assert(getActiveAgentCount('alice', { basePath: dir }) === 2, 'GV3b: archived 제외 → 2')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV4. submitUserAgent — 빈 config → autoApprove → config 에 반영
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    writeUserConfig(dir, 'bob', { agents: [] })

    const result = submitUserAgent({
      requester: 'bob', agentName: 'assistant', persona: samplePersona,
      basePath: dir, presenceDir: dir,
    })
    assert(result.status === STATUS.APPROVED, 'GV4: auto-approved')

    const config = readUserConfig(dir, 'bob')
    assert(config.agents.length === 1, 'GV4: agent 반영')
    assert(config.agents[0].name === 'assistant', 'GV4: agent name')
    assert(config.agents[0].archived === false, 'GV4: not archived')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV5. submitUserAgent — quota 초과 → pending
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    overridePolicies(dir, { maxAgentsPerUser: 2, autoApproveUnderQuota: true })
    writeUserConfig(dir, 'carol', {
      agents: [
        { name: 'a', archived: false },
        { name: 'b', archived: false },
      ],
    })

    const result = submitUserAgent({
      requester: 'carol', agentName: 'c', persona: samplePersona,
      basePath: dir, presenceDir: dir,
    })
    assert(result.status === STATUS.PENDING, 'GV5: quota 초과 → pending')
    assert(typeof result.reqId === 'string' && result.reqId.startsWith('req-'), 'GV5: reqId 형식')

    const pending = listPending(dir)
    assert(pending.length === 1 && pending[0].id === result.reqId, 'GV5: pending 파일 1개')
    assert(pending[0].reason === 'quota-exceeded', 'GV5: reason=quota-exceeded')

    // config 변경 없음
    const config = readUserConfig(dir, 'carol')
    assert(config.agents.length === 2, 'GV5: config 변경 없음')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV6. submitUserAgent — autoApproveUnderQuota=false → 모두 pending
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    overridePolicies(dir, { maxAgentsPerUser: 5, autoApproveUnderQuota: false })
    writeUserConfig(dir, 'dave', { agents: [] })

    const result = submitUserAgent({
      requester: 'dave', agentName: 'helper', persona: samplePersona,
      basePath: dir, presenceDir: dir,
    })
    assert(result.status === STATUS.PENDING, 'GV6: auto-approve off → pending even under quota')
    const pending = listPending(dir)
    assert(pending[0].reason === 'manual-review', 'GV6: reason=manual-review')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV7. submitUserAgent — 중복 (이미 존재) → ALREADY_EXISTS
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    writeUserConfig(dir, 'eve', {
      agents: [{ name: 'existing', archived: false }],
    })

    const result = submitUserAgent({
      requester: 'eve', agentName: 'existing', persona: samplePersona,
      basePath: dir, presenceDir: dir,
    })
    assert(result.status === STATUS.ALREADY_EXISTS, 'GV7: 중복 → already-exists')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV8. submitUserAgent — invalid agentName → throw
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    let thrown = null
    try {
      submitUserAgent({
        requester: 'frank', agentName: 'Invalid-Name', persona: samplePersona,
        basePath: dir, presenceDir: dir,
      })
    } catch (e) { thrown = e }
    assert(thrown && /invalid agentName/.test(thrown.message), 'GV8: invalid name → throw')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV9. approveUserAgent — happy path (pending → config append + approved 이동)
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    overridePolicies(dir, { maxAgentsPerUser: 1, autoApproveUnderQuota: true })
    writeUserConfig(dir, 'grace', {
      agents: [{ name: 'a', archived: false }],
    })

    const submit = submitUserAgent({
      requester: 'grace', agentName: 'b', persona: samplePersona,
      basePath: dir, presenceDir: dir,
    })
    assert(submit.status === STATUS.PENDING, 'GV9 setup: pending')

    const approve = approveUserAgent(submit.reqId, { presenceDir: dir, basePath: dir })
    assert(approve.status === STATUS.APPROVED, 'GV9: approved')

    const config = readUserConfig(dir, 'grace')
    assert(config.agents.length === 2, 'GV9: config 에 agent 추가')
    assert(config.agents.some(a => a.name === 'b'), 'GV9: b agent 반영')

    assert(listPending(dir).length === 0, 'GV9: pending 비어있음')
    assert(listApproved(dir).length === 1, 'GV9: approved 에 1 개')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV10. approveUserAgent — idempotent replay (이미 config 에 있음 → 파일만 이동)
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    overridePolicies(dir, { maxAgentsPerUser: 1, autoApproveUnderQuota: false })
    writeUserConfig(dir, 'henry', { agents: [] })

    const submit = submitUserAgent({
      requester: 'henry', agentName: 'tool', persona: samplePersona,
      basePath: dir, presenceDir: dir,
    })
    const reqId = submit.reqId
    // 사이드 채널로 미리 config 에 반영 (partial-failure 재현)
    writeUserConfig(dir, 'henry', {
      agents: [{ name: 'tool', archived: false, persona: samplePersona }],
    })

    const approve = approveUserAgent(reqId, { presenceDir: dir, basePath: dir })
    assert(approve.status === STATUS.ALREADY_APPLIED, 'GV10: idempotent → already-applied')

    // agent 중복 push 없음
    const config = readUserConfig(dir, 'henry')
    assert(config.agents.length === 1, 'GV10: agent 중복 push 없음')
    assert(listPending(dir).length === 0, 'GV10: pending cleanup')
    assert(listApproved(dir).length === 1, 'GV10: approved 로 이동')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV11. approveUserAgent — 미존재 reqId → NOT_FOUND
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    const result = approveUserAgent('req-ghost', { presenceDir: dir, basePath: dir })
    assert(result.status === STATUS.NOT_FOUND, 'GV11: 미존재 reqId → not-found')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV12. denyUserAgent — pending → rejected 이동 (config 변경 없음)
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    overridePolicies(dir, { maxAgentsPerUser: 0, autoApproveUnderQuota: true })
    writeUserConfig(dir, 'ivy', { agents: [] })

    const submit = submitUserAgent({
      requester: 'ivy', agentName: 'x', persona: samplePersona,
      basePath: dir, presenceDir: dir,
    })
    const deny = denyUserAgent(submit.reqId, 'too many agents', { presenceDir: dir })
    assert(deny.status === STATUS.REJECTED, 'GV12: denied')

    const config = readUserConfig(dir, 'ivy')
    assert(!config.agents || config.agents.length === 0, 'GV12: config 에 추가 안됨')
    assert(listPending(dir).length === 0, 'GV12: pending 비어있음')
    const rejected = listRejected(dir)
    assert(rejected.length === 1 && rejected[0].reason === 'too many agents', 'GV12: rejected 에 reason')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV13. readPendingRequest — 기본 접근자
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    overridePolicies(dir, { maxAgentsPerUser: 0, autoApproveUnderQuota: true })
    writeUserConfig(dir, 'jack', { agents: [] })

    const submit = submitUserAgent({
      requester: 'jack', agentName: 'z', persona: samplePersona,
      basePath: dir, presenceDir: dir,
    })
    const req = readPendingRequest(dir, submit.reqId)
    assert(req && req.requester === 'jack', 'GV13: read 성공')
    assert(readPendingRequest(dir, 'req-ghost') === null, 'GV13: 미존재 → null')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV14. Atomic write — tmp 잔여 없음
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    writeUserConfig(dir, 'kate', { agents: [] })

    submitUserAgent({
      requester: 'kate', agentName: 'a', persona: samplePersona,
      basePath: dir, presenceDir: dir,
    })
    const userDir = join(dir, 'users', 'kate')
    const tmp = readdirSync(userDir).filter(f => f.includes('.tmp-'))
    assert(tmp.length === 0, `GV14: 루트 tmp 없음 (${tmp.join(',')})`)
    rmSync(dir, { recursive: true, force: true })
  }

  summary()
}

run()
