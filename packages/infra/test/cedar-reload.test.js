// KG-28 P5 — Cedar policy hot reload 단위 테스트.
// RL1~RL9 — wrapper / single-flight / fail-safe / 호출 단위 atomicity / 살아있는 closure / audit version.

import { createEvaluatorRef } from '@presence/infra/infra/authz/cedar/evaluator-ref.js'
import { createAuditWriter } from '@presence/infra/infra/authz/cedar/audit.js'
import { mkdirSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert, summary } from '../../../test/lib/assert.js'

const tmpLogPath = (label) => {
  const dir = join(tmpdir(), `cedar-reload-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'authz-audit.log')
}

const cleanupTmp = (logPath) => {
  try {
    const dir = join(logPath, '..')
    rmSync(dir, { recursive: true, force: true })
  } catch { /* best effort */ }
}

// reloadEvaluator + rebootCedarSubsystem 의 핵심 로직만 단위 검증.
// 실 cedar 부팅은 cedar-boot.test.js 에서 검증. 본 테스트는 wrapper 의 closure-bound state +
// single-flight + fail-safe 의미론에 집중.
//
// UserContextManager 의 reloadEvaluator 와 동등한 mini reload coordinator.
const createReloadCoordinator = ({ wrapper, rebootFn }) => {
  let pending = null
  return {
    async reload() {
      if (pending) return pending
      const reloadStartedAt = new Date().toISOString()
      const snapshot = wrapper.snapshot()
      pending = (async () => {
        const newEval = await rebootFn()
        const newVersion = snapshot.version + 1
        wrapper.replace(newEval, newVersion)
        return {
          version: newVersion,
          reloadedAt: wrapper.snapshot().reloadedAt,
          reloadStartedAt,
        }
      })()
      try { return await pending }
      finally { pending = null }
    },
  }
}

async function run() {
  console.log('Cedar policy hot reload tests (KG-28 P5)')

  // RL1 — 정상 reload: 새 evaluator 함수가 wrapper 에 적용되어 호출 사이트 자동 propagate
  {
    const v1 = (args) => ({ decision: 'deny', matchedPolicies: ['10-quota'], errors: [], _v: 1 })
    const v2 = (args) => ({ decision: 'allow', matchedPolicies: [], errors: [], _v: 2 })
    const wrapper = createEvaluatorRef(v1, { version: 1 })
    const coordinator = createReloadCoordinator({ wrapper, rebootFn: async () => v2 })

    const before = wrapper({ test: 1 })
    assert(before._v === 1, `RL1: reload 전 v1 호출 (got _v=${before._v})`)
    assert(wrapper.snapshot().version === 1, 'RL1: 초기 version=1')

    const result = await coordinator.reload()
    assert(result.version === 2, `RL1: reload 후 version=2 (got ${result.version})`)
    assert(typeof result.reloadStartedAt === 'string' && result.reloadStartedAt.length > 0, 'RL1: reloadStartedAt 캡처')
    assert(typeof result.reloadedAt === 'string', 'RL1: reloadedAt 응답')

    const after = wrapper({ test: 1 })
    assert(after._v === 2, `RL1: reload 후 v2 호출 (got _v=${after._v})`)
    assert(wrapper.snapshot().version === 2, 'RL1: snapshot version=2')
  }

  // RL2 — 부팅 실패: rebootFn throw → wrapper.replace 미호출 → 이전 evaluator 유지 (fail-safe)
  {
    const v1 = (args) => ({ decision: 'deny', _v: 1 })
    const wrapper = createEvaluatorRef(v1, { version: 1 })
    const rebootFn = async () => { throw new Error('parse failed: invalid policy') }
    const coordinator = createReloadCoordinator({ wrapper, rebootFn })

    let caughtError = null
    try { await coordinator.reload() }
    catch (err) { caughtError = err }

    assert(caughtError !== null, 'RL2: reload throw 전파')
    assert(caughtError.message.includes('parse failed'), `RL2: 에러 메시지 보존 (got ${caughtError.message})`)
    assert(wrapper.snapshot().version === 1, `RL2: version 미변경 (got ${wrapper.snapshot().version})`)

    const result = wrapper({ test: 1 })
    assert(result._v === 1, `RL2: 이전 evaluator 정상 동작 (got _v=${result._v})`)
  }

  // RL3 — 단순 single-flight: 동시 reload 2회 → rebootFn 호출 1회 (spy)
  {
    const v1 = () => ({ _v: 1 })
    const v2 = () => ({ _v: 2 })
    const wrapper = createEvaluatorRef(v1, { version: 1 })
    let bootCalls = 0
    const rebootFn = async () => {
      bootCalls += 1
      await new Promise(r => setTimeout(r, 10))
      return v2
    }
    const coordinator = createReloadCoordinator({ wrapper, rebootFn })

    const [r1, r2] = await Promise.all([coordinator.reload(), coordinator.reload()])
    assert(bootCalls === 1, `RL3: 동시 호출이 같은 promise 공유 — 부팅 함수 1회 (got ${bootCalls})`)
    assert(r1.version === r2.version, 'RL3: 두 호출이 같은 version 받음')
    assert(r1.reloadStartedAt === r2.reloadStartedAt, 'RL3: 두 호출이 같은 reloadStartedAt 받음 (single-flight metadata 공유)')
  }

  // RL4 — version monotonic: 성공 reload 마다 version +1, 실패 reload 는 version 유지
  {
    const v1 = () => ({ _v: 1 })
    const v2 = () => ({ _v: 2 })
    const v3 = () => ({ _v: 3 })
    const wrapper = createEvaluatorRef(v1, { version: 1 })

    let nextEval = v2
    const rebootFn = async () => {
      if (nextEval === null) throw new Error('boot failed')
      const ev = nextEval
      nextEval = null
      return ev
    }
    const coordinator = createReloadCoordinator({ wrapper, rebootFn })

    const r1 = await coordinator.reload()
    assert(r1.version === 2, `RL4: 첫 reload version=2 (got ${r1.version})`)

    nextEval = null   // 다음 reload 실패 trigger
    let failCaught = null
    try { await coordinator.reload() } catch (err) { failCaught = err }
    assert(failCaught !== null, 'RL4: 실패 reload throw')
    assert(wrapper.snapshot().version === 2, `RL4: 실패 후 version 유지 (got ${wrapper.snapshot().version})`)

    nextEval = v3
    const r3 = await coordinator.reload()
    assert(r3.version === 3, `RL4: 다음 성공 reload version=3 (got ${r3.version})`)
  }

  // RL5 — 호출 단위 선형화: reload 진행 중 evaluator(args) 호출 → 각 호출이 self-consistent
  // wrapper.replace 가 sync 라 실 race window 시뮬레이션 어려움. 호출 시점에 어느 evaluator 가 잡혀도
  // self-consistent decision 반환 검증.
  {
    const v1 = (args) => ({ decision: 'deny', matchedPolicies: ['10-quota'], errors: [], _v: 1 })
    const v2 = (args) => ({ decision: 'allow', matchedPolicies: [], errors: [], _v: 2 })
    const wrapper = createEvaluatorRef(v1, { version: 1 })

    // reload 전 호출 → v1
    const before = wrapper({ x: 1 })
    assert(before.decision === 'deny' && before.matchedPolicies[0] === '10-quota',
      `RL5: 호출 self-consistent — v1 (got ${JSON.stringify(before)})`)

    // 직접 wrapper.replace (race 시뮬레이션)
    wrapper.replace(v2, 2)

    // reload 후 호출 → v2
    const after = wrapper({ x: 1 })
    assert(after.decision === 'allow' && after.matchedPolicies.length === 0,
      `RL5: 호출 self-consistent — v2 (got ${JSON.stringify(after)})`)

    // 100 회 호출 모두 한 evaluator 결과로 self-consistent (decision + matchedPolicies + _v 정합)
    const results = []
    for (let i = 0; i < 100; i += 1) results.push(wrapper({ i }))
    const allConsistent = results.every(r =>
      (r._v === 2 && r.decision === 'allow' && r.matchedPolicies.length === 0))
    assert(allConsistent, 'RL5: 100 회 호출 모두 self-consistent (v2 정책 정합)')
  }

  // RL6 — 살아있는 closure: evaluator 를 미리 캡처한 closure 가 reload 후 새 정책 사용
  {
    const v1 = () => ({ _v: 1 })
    const v2 = () => ({ _v: 2 })
    const wrapper = createEvaluatorRef(v1, { version: 1 })

    // 살아있는 세션이 evaluator 를 미리 캡처하는 시뮬레이션
    const capturedEvaluator = wrapper

    // reload
    wrapper.replace(v2, 2)

    // 캡처된 evaluator 호출 — wrapper closure 가 새 state.current 사용
    const result = capturedEvaluator({ x: 1 })
    assert(result._v === 2, `RL6: 캡처된 closure 가 reload 후 새 evaluator 사용 (got _v=${result._v})`)
  }

  // RL7 — 캐시된 UserContext: userContext.evaluator 필드로 저장된 wrapper 가 reload 후 새 정책 사용
  {
    const v1 = () => ({ _v: 1 })
    const v2 = () => ({ _v: 2 })
    const wrapper = createEvaluatorRef(v1, { version: 1 })

    // UserContext.create 시뮬레이션 — evaluator 필드로 저장
    const fakeUserContext = { evaluator: wrapper }

    // reload
    wrapper.replace(v2, 2)

    // 캐시된 UserContext 의 evaluator 필드 호출
    const result = fakeUserContext.evaluator({ x: 1 })
    assert(result._v === 2, `RL7: 캐시된 UserContext.evaluator 가 reload 후 새 정책 사용 (got _v=${result._v})`)
  }

  // RL8 — edge-trigger metadata 공유: reload-1 진행 중 reload-2 트리거 → 두 응답 모두 같은 reloadStartedAt
  {
    const v1 = () => ({ _v: 1 })
    const v2 = () => ({ _v: 2 })
    const wrapper = createEvaluatorRef(v1, { version: 1 })
    let bootCalls = 0
    const rebootFn = async () => {
      bootCalls += 1
      await new Promise(r => setTimeout(r, 20))
      return v2
    }
    const coordinator = createReloadCoordinator({ wrapper, rebootFn })

    // reload-1 시작 (await 안 함)
    const p1 = coordinator.reload()
    // reload-2 트리거 (reload-1 진행 중)
    await new Promise(r => setTimeout(r, 5))
    const p2 = coordinator.reload()

    const [r1, r2] = await Promise.all([p1, p2])
    assert(bootCalls === 1, `RL8: single-flight — 부팅 함수 1회 (got ${bootCalls})`)
    assert(r1.reloadStartedAt === r2.reloadStartedAt,
      `RL8: follower 가 leader 의 reloadStartedAt 공유 (got r1=${r1.reloadStartedAt} r2=${r2.reloadStartedAt})`)
    assert(r1.version === r2.version, 'RL8: 두 호출이 같은 version 받음')
  }

  // RL9 — audit policyVersion 자동 첨부: reload 전후 audit entry 의 policyVersion 이 다름
  {
    const logPath = tmpLogPath('rl9')
    const wrapper = createEvaluatorRef(() => ({}), { version: 1 })

    const auditWriter = createAuditWriter({
      logPath,
      getPolicyVersion: () => wrapper.snapshot().version,
    })

    auditWriter.append({ ts: 't1', caller: 'a', action: 'x', resource: 'r', decision: 'allow' })
    wrapper.replace(() => ({}), 2)
    auditWriter.append({ ts: 't2', caller: 'a', action: 'x', resource: 'r', decision: 'allow' })

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n')
    assert(lines.length === 2, `RL9: audit entry 2 개 (got ${lines.length})`)
    const entry1 = JSON.parse(lines[0])
    const entry2 = JSON.parse(lines[1])
    assert(entry1.policyVersion === 1, `RL9: 첫 entry policyVersion=1 (got ${entry1.policyVersion})`)
    assert(entry2.policyVersion === 2, `RL9: 두 번째 entry policyVersion=2 (got ${entry2.policyVersion})`)

    cleanupTmp(logPath)
  }

  summary()
}

run()
