import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runAdminBootstrap } from '@presence/infra/infra/admin-bootstrap.js'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import {
  STATUS,
  PENDING_REASON,
  loadAgentPolicies, loadAgentPoliciesR,
  getActiveAgentCount, getActiveAgentCountR,
  submitUserAgent, submitUserAgentR,
  approveUserAgent,
  denyUserAgent,
  listPending, listApproved, listRejected,
  readPendingRequest,
} from '@presence/infra/infra/authz/agent-governance.js'
import { assert, summary } from '../../../test/lib/assert.js'
import { createMockEvaluator } from '../../../test/lib/cedar-mock.js'

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }
const mockEvaluator = createMockEvaluator()

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
      basePath: dir, presenceDir: dir, evaluator: mockEvaluator,
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
      basePath: dir, presenceDir: dir, evaluator: mockEvaluator,
    })
    assert(result.status === STATUS.PENDING, 'GV5: quota 초과 → pending')
    assert(typeof result.reqId === 'string' && result.reqId.startsWith('req-'), 'GV5: reqId 형식')

    const pending = listPending(dir)
    assert(pending.length === 1 && pending[0].id === result.reqId, 'GV5: pending 파일 1개')
    assert(pending[0].reason === PENDING_REASON.QUOTA_EXCEEDED, 'GV5: reason=quota-exceeded')

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
      basePath: dir, presenceDir: dir, evaluator: mockEvaluator,
    })
    assert(result.status === STATUS.PENDING, 'GV6: auto-approve off → pending even under quota')
    const pending = listPending(dir)
    assert(pending[0].reason === PENDING_REASON.MANUAL_REVIEW, 'GV6: reason=manual-review')
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
      basePath: dir, presenceDir: dir, evaluator: mockEvaluator,
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
        basePath: dir, presenceDir: dir, evaluator: mockEvaluator,
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
      basePath: dir, presenceDir: dir, evaluator: mockEvaluator,
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
      basePath: dir, presenceDir: dir, evaluator: mockEvaluator,
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
      basePath: dir, presenceDir: dir, evaluator: mockEvaluator,
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
      basePath: dir, presenceDir: dir, evaluator: mockEvaluator,
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
      basePath: dir, presenceDir: dir, evaluator: mockEvaluator,
    })
    const userDir = join(dir, 'users', 'kate')
    const tmp = readdirSync(userDir).filter(f => f.includes('.tmp-'))
    assert(tmp.length === 0, `GV14: 루트 tmp 없음 (${tmp.join(',')})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // GV15. Reader 브릿지 동치 — loadAgentPolicies, getActiveAgentCount, submitUserAgent
  //        (test.md#브릿지동치 — deepStrictEqual 로 두 경로 결과 일치 검증)
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)

    // 1) loadAgentPolicies vs loadAgentPoliciesR
    const polBridge = loadAgentPolicies(dir)
    const polReader = loadAgentPoliciesR.run({ presenceDir: dir })()
    assert(JSON.stringify(polBridge) === JSON.stringify(polReader), 'GV15: loadAgentPolicies 브릿지 === Reader')

    // 2) getActiveAgentCount vs getActiveAgentCountR
    writeUserConfig(dir, 'leo', { agents: [{ name: 'a', archived: false }, { name: 'b', archived: true }] })
    const countBridge = getActiveAgentCount('leo', { basePath: dir })
    const countReader = getActiveAgentCountR.run({ username: 'leo', basePath: dir })()
    assert(countBridge === countReader, `GV15: getActiveAgentCount 브릿지 === Reader (${countBridge} === ${countReader})`)

    // 3) submitUserAgentR 가 동일 deps 로 호출 시 브릿지와 동일 결과
    //    (파일 변이가 있으므로 deps 마다 새 tmpDir 에서 병렬 측정 — 상태 독립 확인)
    const dir1 = createTmpDir(); await initAdminBootstrap(dir1)
    const dir2 = createTmpDir(); await initAdminBootstrap(dir2)
    writeUserConfig(dir1, 'mia', { agents: [] })
    writeUserConfig(dir2, 'mia', { agents: [] })
    const resBridge = submitUserAgent({
      requester: 'mia', agentName: 'via-bridge', persona: samplePersona,
      basePath: dir1, presenceDir: dir1, evaluator: mockEvaluator,
    })
    const resReader = submitUserAgentR.run({
      requester: 'mia', agentName: 'via-bridge', persona: samplePersona,
      basePath: dir2, presenceDir: dir2, evaluator: mockEvaluator,
    })()
    assert(resBridge.status === resReader.status, `GV15: submitUserAgent 브릿지.status === Reader.status (${resBridge.status})`)
    rmSync(dir1, { recursive: true, force: true })
    rmSync(dir2, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }

  // ==========================================================================
  // GV-Y1~Y4 — governance-cedar v2.1 §5.1 회귀 항목 (옵션 Y minimal seed 불변식)
  // ==========================================================================

  // GV-Y1 — minimal seed 만 적용된 상태 (mock 이 항상 allow) 에서 admin/user × quota 안/초과 ×
  //         autoApprove 任 의 8 케이스 전부 evaluate 가 allow 반환 (count == call count + 결과 status 정상)
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    let allowCount = 0
    let denyCount = 0
    const tracingEvaluator = (input) => {
      const ans = mockEvaluator(input)
      if (ans.decision === 'allow') allowCount += 1
      else denyCount += 1
      return ans
    }

    // user × autoApprove=true × under-quota
    overridePolicies(dir, { maxAgentsPerUser: 5, autoApproveUnderQuota: true })
    writeUserConfig(dir, 'u1', { agents: [] })
    const r1 = submitUserAgent({ requester: 'u1', agentName: 'a', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: tracingEvaluator })
    assert(r1.status === STATUS.APPROVED, 'GV-Y1.1: user under-quota autoApprove → APPROVED')

    // user × autoApprove=true × over-quota
    writeUserConfig(dir, 'u2', { agents: [{ name: 'x' }, { name: 'y' }, { name: 'z' }, { name: 'p' }, { name: 'q' }] })
    const r2 = submitUserAgent({ requester: 'u2', agentName: 'r', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: tracingEvaluator })
    assert(r2.status === STATUS.PENDING, 'GV-Y1.2: user over-quota → PENDING (Cedar allow → 코드 분기)')

    // user × autoApprove=false × under-quota
    overridePolicies(dir, { maxAgentsPerUser: 5, autoApproveUnderQuota: false })
    writeUserConfig(dir, 'u3', { agents: [] })
    const r3 = submitUserAgent({ requester: 'u3', agentName: 'a', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: tracingEvaluator })
    assert(r3.status === STATUS.PENDING, 'GV-Y1.3: user under-quota autoApprove=false → PENDING')

    // user × autoApprove=false × over-quota
    writeUserConfig(dir, 'u4', { agents: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'e' }] })
    const r4 = submitUserAgent({ requester: 'u4', agentName: 'f', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: tracingEvaluator })
    assert(r4.status === STATUS.PENDING, 'GV-Y1.4: user over-quota autoApprove=false → PENDING')

    // admin (admin 도 일반 LocalUser/create_agent 정책 적용 — 의미론은 코드)
    overridePolicies(dir, { maxAgentsPerUser: 5, autoApproveUnderQuota: true })
    writeUserConfig(dir, 'admin', { agents: [] })
    const r5 = submitUserAgent({ requester: 'admin', agentName: 'q1', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: tracingEvaluator })
    assert(r5.status === STATUS.APPROVED, 'GV-Y1.5: admin under-quota autoApprove → APPROVED')

    // admin × under-quota × autoApprove=false
    overridePolicies(dir, { maxAgentsPerUser: 5, autoApproveUnderQuota: false })
    writeUserConfig(dir, 'admin2', { agents: [] })
    const r6 = submitUserAgent({ requester: 'admin2', agentName: 'q2', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: tracingEvaluator })
    assert(r6.status === STATUS.PENDING, 'GV-Y1.6: admin under-quota autoApprove=false → PENDING')

    // admin × over-quota × autoApprove=true
    overridePolicies(dir, { maxAgentsPerUser: 5, autoApproveUnderQuota: true })
    writeUserConfig(dir, 'admin3', { agents: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'e' }] })
    const r7 = submitUserAgent({ requester: 'admin3', agentName: 'q3', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: tracingEvaluator })
    assert(r7.status === STATUS.PENDING, 'GV-Y1.7: admin over-quota autoApprove=true → PENDING')

    // admin × over-quota × autoApprove=false
    overridePolicies(dir, { maxAgentsPerUser: 5, autoApproveUnderQuota: false })
    writeUserConfig(dir, 'admin4', { agents: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'e' }] })
    const r8 = submitUserAgent({ requester: 'admin4', agentName: 'q4', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: tracingEvaluator })
    assert(r8.status === STATUS.PENDING, 'GV-Y1.8: admin over-quota autoApprove=false → PENDING')

    assert(allowCount === 8, `GV-Y1: 8 케이스 모두 Cedar allow (got allow=${allowCount}, deny=${denyCount})`)
    assert(denyCount === 0, 'GV-Y1: minimal seed 에선 deny 0건')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV-Y2 — Cedar evaluate 호출 횟수 = submitUserAgent 호출 횟수 (1회 보장, 누락/중복 방지)
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    overridePolicies(dir, { maxAgentsPerUser: 5, autoApproveUnderQuota: true })
    writeUserConfig(dir, 'callcount', { agents: [] })
    let calls = 0
    const counter = (input) => { calls += 1; return mockEvaluator(input) }

    submitUserAgent({ requester: 'callcount', agentName: 'a1', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: counter })
    assert(calls === 1, `GV-Y2: 첫 submit → 1회 호출 (got ${calls})`)

    submitUserAgent({ requester: 'callcount', agentName: 'a2', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: counter })
    assert(calls === 2, `GV-Y2: 두 번째 submit → 누적 2회 (got ${calls})`)

    // 중복 (ALREADY_EXISTS) 도 evaluator 호출됨 — RBAC 게이트가 dup 검사 전.
    // 의도적 결정: enforcement point 가 모든 진입에서 작동 (governance-cedar §3.3).
    submitUserAgent({ requester: 'callcount', agentName: 'a1', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: counter })
    assert(calls === 3, `GV-Y2: 중복 submit 도 evaluator 호출 (RBAC gate 우선) (got ${calls})`)

    // invalid name → throw 시점은 evaluator 호출 *전* (validate 가 먼저)
    let calls2 = 0
    const counter2 = (input) => { calls2 += 1; return mockEvaluator(input) }
    let threw = false
    try {
      submitUserAgent({ requester: 'callcount', agentName: 'invalid name with space', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: counter2 })
    } catch (_) { threw = true }
    assert(threw, 'GV-Y2: invalid name → throw')
    assert(calls2 === 0, 'GV-Y2: invalid name throw 시 evaluator 미호출 (validate → evaluate 순서)')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV-Y4 — evaluator 가 deny 반환 → 코드 분기 미도달 (writePending / appendAgentToConfig 호출 안됨)
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    overridePolicies(dir, { maxAgentsPerUser: 5, autoApproveUnderQuota: true })
    writeUserConfig(dir, 'denied', { agents: [] })

    const denyEvaluator = () => ({ decision: 'deny', matchedPolicies: ['50-custom'], errors: [] })
    const result = submitUserAgent({ requester: 'denied', agentName: 'no-go', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: denyEvaluator })
    assert(result.status === STATUS.DENIED, `GV-Y4: deny → STATUS.DENIED (got ${result.status})`)
    assert(/50-custom/.test(result.detail || ''), `GV-Y4: detail 에 matchedPolicies 노출 (got ${result.detail})`)

    // 코드 분기 미도달 — config 무변동, pending 0건
    const config = readUserConfig(dir, 'denied')
    assert(!config.agents || config.agents.length === 0, 'GV-Y4: config.agents 무변동')
    assert(listPending(dir).length === 0, 'GV-Y4: pending 미생성')
    assert(listApproved(dir).length === 0, 'GV-Y4: approved 미생성')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV-Y5 — evaluator 부재 시 throw (invariant 검증)
  {
    let threw = false
    try {
      submitUserAgent({ requester: 'x', agentName: 'a', persona: samplePersona, basePath: '/tmp', presenceDir: '/tmp' })
    } catch (e) {
      threw = true
      assert(/evaluator.*required/.test(e.message), `GV-Y5: error message 에 evaluator required 명시 (${e.message})`)
    }
    assert(threw, 'GV-Y5: evaluator 부재 → throw')
  }

  summary()
}

run()
