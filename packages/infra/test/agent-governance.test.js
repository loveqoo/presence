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
  // GV-Y2/Y5 — invariant 회귀 (governance-cedar v2.3 hybrid)
  // ==========================================================================

  // GV-Y2 — Cedar evaluate 호출 횟수 = submitUserAgent 호출 횟수.
  //   v2.3 부터 호출 순서: validate → duplicate → count/policies → Cedar.
  //   ALREADY_EXISTS 는 Cedar 호출 전 단락 (불필요한 latency / audit row 회피).
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

    // 중복 (ALREADY_EXISTS) 은 Cedar 호출 *전* 단락 — v2.3 에서 호출 순서 변경됨.
    submitUserAgent({ requester: 'callcount', agentName: 'a1', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: counter })
    assert(calls === 2, `GV-Y2: 중복 submit 은 Cedar 호출 전 단락 (got ${calls})`)

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

  // ==========================================================================
  // GV-X1~X10 — governance-cedar v2.3 §X (P1 quota Cedar 흡수, 옵션 Y' hybrid)
  // ==========================================================================

  // GV-X1 — Cedar context 셰이프 정확 (currentCount + maxAgents)
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    overridePolicies(dir, { maxAgentsPerUser: 5, autoApproveUnderQuota: true })
    writeUserConfig(dir, 'cx1', { agents: [{ name: 'a' }, { name: 'b' }] })
    let captured = null
    const evaluator = (input) => { captured = input; return { decision: 'allow', matchedPolicies: [], errors: [] } }
    submitUserAgent({ requester: 'cx1', agentName: 'c', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator })
    assert(captured && captured.context, 'GV-X1: context 전달됨')
    assert(captured.context.currentCount === 2, `GV-X1: currentCount=2 (got ${captured.context.currentCount})`)
    assert(captured.context.maxAgents === 5, `GV-X1: maxAgents=5 (got ${captured.context.maxAgents})`)
    assert(captured.principal.type === 'LocalUser' && captured.principal.id === 'cx1', 'GV-X1: principal=LocalUser/cx1')
    assert(captured.action === 'create_agent', 'GV-X1: action=create_agent')
    assert(captured.resource.type === 'User' && captured.resource.id === 'cx1', 'GV-X1: resource=User/cx1')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV-X2 — count=0 maxAgents=5 autoApprove=true → APPROVED (mock allow)
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    overridePolicies(dir, { maxAgentsPerUser: 5, autoApproveUnderQuota: true })
    writeUserConfig(dir, 'cx2', { agents: [] })
    const r = submitUserAgent({ requester: 'cx2', agentName: 'a', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: mockEvaluator })
    assert(r.status === STATUS.APPROVED, `GV-X2: count=0 maxAgents=5 autoApprove=true → APPROVED (got ${r.status})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // GV-X3 — count=4 maxAgents=5 boundary → APPROVED (under quota)
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    overridePolicies(dir, { maxAgentsPerUser: 5, autoApproveUnderQuota: true })
    writeUserConfig(dir, 'cx3', { agents: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }] })
    const r = submitUserAgent({ requester: 'cx3', agentName: 'e', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: mockEvaluator })
    assert(r.status === STATUS.APPROVED, `GV-X3: boundary 4/5 → APPROVED (got ${r.status})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // GV-X4 — count=5 maxAgents=5 → mock deny → PENDING(quota-exceeded)
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    overridePolicies(dir, { maxAgentsPerUser: 5, autoApproveUnderQuota: true })
    writeUserConfig(dir, 'cx4', { agents: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'e' }] })
    const r = submitUserAgent({ requester: 'cx4', agentName: 'f', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: mockEvaluator })
    assert(r.status === STATUS.PENDING, `GV-X4: count=5/5 → PENDING (got ${r.status})`)
    const pending = listPending(dir)
    assert(pending[0].reason === PENDING_REASON.QUOTA_EXCEEDED, `GV-X4: reason=quota-exceeded (got ${pending[0].reason})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // GV-X5 — count=10 maxAgents=5 autoApprove=false → mock deny → PENDING(quota-exceeded). autoApprove 무관.
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    overridePolicies(dir, { maxAgentsPerUser: 5, autoApproveUnderQuota: false })
    writeUserConfig(dir, 'cx5', { agents: Array.from({ length: 10 }, (_, i) => ({ name: `a${i}` })) })
    const r = submitUserAgent({ requester: 'cx5', agentName: 'over', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: mockEvaluator })
    assert(r.status === STATUS.PENDING, `GV-X5: over-quota autoApprove=false → PENDING (got ${r.status})`)
    const pending = listPending(dir)
    assert(pending[0].reason === PENDING_REASON.QUOTA_EXCEEDED, `GV-X5: reason=quota-exceeded (autoApprove 무관) (got ${pending[0].reason})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // GV-X6 — count=2 maxAgents=5 autoApprove=false → mock allow → PENDING(manual-review). third state 코드 잔류.
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    overridePolicies(dir, { maxAgentsPerUser: 5, autoApproveUnderQuota: false })
    writeUserConfig(dir, 'cx6', { agents: [{ name: 'a' }, { name: 'b' }] })
    const r = submitUserAgent({ requester: 'cx6', agentName: 'c', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: mockEvaluator })
    assert(r.status === STATUS.PENDING, `GV-X6: under-quota autoApprove=false → PENDING (got ${r.status})`)
    const pending = listPending(dir)
    assert(pending[0].reason === PENDING_REASON.MANUAL_REVIEW, `GV-X6: reason=manual-review (got ${pending[0].reason})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // GV-X7 — 이미 존재 (active) → ALREADY_EXISTS, Cedar 호출 *전* 단락
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    writeUserConfig(dir, 'cx7', { agents: [{ name: 'dup', archived: false }] })
    let evalCalled = false
    const evaluator = (input) => { evalCalled = true; return mockEvaluator(input) }
    const r = submitUserAgent({ requester: 'cx7', agentName: 'dup', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator })
    assert(r.status === STATUS.ALREADY_EXISTS, `GV-X7: 중복 → ALREADY_EXISTS (got ${r.status})`)
    assert(evalCalled === false, 'GV-X7: Cedar 호출 안됨 (duplicate short-circuit)')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV-X8 — 같은 이름 archived 존재 + count=0 → 정상 진입 (archived 는 차단 사유 아님)
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    overridePolicies(dir, { maxAgentsPerUser: 5, autoApproveUnderQuota: true })
    writeUserConfig(dir, 'cx8', { agents: [{ name: 'reborn', archived: true }] })
    const r = submitUserAgent({ requester: 'cx8', agentName: 'reborn', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: mockEvaluator })
    assert(r.status === STATUS.APPROVED, `GV-X8: archived 동명 → 정상 추가 (got ${r.status})`)
    const config = readUserConfig(dir, 'cx8')
    assert(config.agents.length === 2, 'GV-X8: 새 entry append (archived 유지 + 신규)')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV-X9 — Cedar deny + errors=['parse error'] → DENIED(evaluator-error)
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    writeUserConfig(dir, 'cx9', { agents: [] })
    const evaluator = createMockEvaluator(() => ({ decision: 'deny', matchedPolicies: [], errors: ['parse error: invalid policy'] }))
    const r = submitUserAgent({ requester: 'cx9', agentName: 'broken', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator })
    assert(r.status === STATUS.DENIED, `GV-X9: errors → DENIED (got ${r.status})`)
    assert(r.reason === 'evaluator-error', `GV-X9: reason=evaluator-error (got ${r.reason})`)
    assert(/parse error/.test(r.detail || ''), `GV-X9: detail 에 errors 노출 (got ${r.detail})`)
    assert(listPending(dir).length === 0, 'GV-X9: pending 미생성 (DENIED 분기)')
    rmSync(dir, { recursive: true, force: true })
  }

  // GV-X10 — autoApprove !! 보존 — loadAgentPolicies 가 truthy 입력 (e.g. 1) 을 true 로 coerce
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    overridePolicies(dir, { maxAgentsPerUser: 5, autoApproveUnderQuota: 1 })
    writeUserConfig(dir, 'cx10', { agents: [] })
    const policies = loadAgentPolicies(dir)
    assert(policies.autoApproveUnderQuota === true, `GV-X10: 1 → true coerce (got ${policies.autoApproveUnderQuota})`)
    const r = submitUserAgent({ requester: 'cx10', agentName: 'a', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator: mockEvaluator })
    assert(r.status === STATUS.APPROVED, `GV-X10: truthy autoApprove → APPROVED (got ${r.status})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // ==========================================================================
  // GV-X11~X14 — governance-cedar v2.4 §X (admin 면제 + hardLimit Cedar 흡수, KG-26)
  // ==========================================================================

  // GV-X11 — admin 이 maxAgentsPerUser 초과 + hardLimit 미만 → APPROVED (quota 면제)
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    overridePolicies(dir, { maxAgentsPerUser: 5, autoApproveUnderQuota: true })
    // admin 의 user config 는 admin-bootstrap 이 이미 manager agent 1 개 등록.
    // maxAgents 5 초과 시나리오는 admin 의 agents 를 5+ 로 채워서 만들기.
    writeUserConfig(dir, 'admin', { agents: Array.from({ length: 6 }, (_, i) => ({ name: `agent-${i}`, archived: false })) })
    const r = submitUserAgent({
      requester: 'admin', agentName: 'extra', persona: samplePersona,
      basePath: dir, presenceDir: dir, evaluator: mockEvaluator,
    })
    assert(r.status === STATUS.APPROVED, `GV-X11: admin over maxAgents under hardLimit → APPROVED (got ${r.status})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // GV-X12 — admin 이 hardLimit 초과 → PENDING(quota-exceeded). env 로 hardLimit 낮춰 검증.
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    const previousHard = process.env.PRESENCE_ADMIN_AGENT_HARD_LIMIT
    process.env.PRESENCE_ADMIN_AGENT_HARD_LIMIT = '3'
    try {
      writeUserConfig(dir, 'admin', { agents: Array.from({ length: 3 }, (_, i) => ({ name: `agent-${i}`, archived: false })) })
      const r = submitUserAgent({
        requester: 'admin', agentName: 'extra', persona: samplePersona,
        basePath: dir, presenceDir: dir, evaluator: mockEvaluator,
      })
      assert(r.status === STATUS.PENDING, `GV-X12: admin 3/3 hardLimit → PENDING (got ${r.status})`)
      const pending = listPending(dir)
      assert(pending[0].reason === PENDING_REASON.QUOTA_EXCEEDED, `GV-X12: reason=quota-exceeded (got ${pending[0].reason})`)
    } finally {
      if (previousHard === undefined) delete process.env.PRESENCE_ADMIN_AGENT_HARD_LIMIT
      else process.env.PRESENCE_ADMIN_AGENT_HARD_LIMIT = previousHard
    }
    rmSync(dir, { recursive: true, force: true })
  }

  // GV-X13 — non-admin 은 admin hardLimit env 무관 — 기존 maxAgentsPerUser 만 적용.
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    overridePolicies(dir, { maxAgentsPerUser: 5, autoApproveUnderQuota: true })
    const previousHard = process.env.PRESENCE_ADMIN_AGENT_HARD_LIMIT
    process.env.PRESENCE_ADMIN_AGENT_HARD_LIMIT = '1' // 매우 낮게 — non-admin 에게 영향 없어야 함
    try {
      writeUserConfig(dir, 'cx13', { agents: [{ name: 'a' }, { name: 'b' }] })
      const r = submitUserAgent({
        requester: 'cx13', agentName: 'c', persona: samplePersona,
        basePath: dir, presenceDir: dir, evaluator: mockEvaluator,
      })
      assert(r.status === STATUS.APPROVED, `GV-X13: non-admin 2/5 ignore admin hardLimit=1 → APPROVED (got ${r.status})`)
    } finally {
      if (previousHard === undefined) delete process.env.PRESENCE_ADMIN_AGENT_HARD_LIMIT
      else process.env.PRESENCE_ADMIN_AGENT_HARD_LIMIT = previousHard
    }
    rmSync(dir, { recursive: true, force: true })
  }

  // GV-X14 — Cedar context 에 isAdmin + hardLimit 첨부 (admin / non-admin 분기)
  {
    const dir = createTmpDir()
    await initAdminBootstrap(dir)
    writeUserConfig(dir, 'cx14', { agents: [] })
    writeUserConfig(dir, 'admin', { agents: [] })
    let captured = null
    const evaluator = (input) => { captured = input; return { decision: 'allow', matchedPolicies: [], errors: [] } }

    submitUserAgent({ requester: 'cx14', agentName: 'a', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator })
    assert(captured.context.isAdmin === false, `GV-X14a: non-admin → isAdmin=false (got ${captured.context.isAdmin})`)
    assert(captured.context.hardLimit === 50, `GV-X14a: 기본 hardLimit=50 (got ${captured.context.hardLimit})`)

    submitUserAgent({ requester: 'admin', agentName: 'b', persona: samplePersona, basePath: dir, presenceDir: dir, evaluator })
    assert(captured.context.isAdmin === true, `GV-X14b: admin → isAdmin=true (got ${captured.context.isAdmin})`)
    rmSync(dir, { recursive: true, force: true })
  }

  summary()
}

run()
