import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { cpus } from 'os'
import { promisify } from 'util'

const execFileP = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

// localhost listen()이 필요한 테스트 (모두 mock LLM 사용 — 외부 네트워크 불필요).
// 일반 환경에서는 항상 실행됨.
// 샌드박스·CI 등 listen() 자체가 EPERM인 환경에서만
// `node test/run.js --no-network` 로 건너뜁니다.
// (실제 LLM 유무와 무관 — 포트 바인딩 권한 부족일 때만 사용)
const NETWORK_TESTS = new Set([
  'packages/infra/test/llm.test.js',
  'packages/infra/test/mcp-sse.test.js',
  'packages/infra/test/mirror-state.test.js',
  'packages/infra/test/session.test.js',
  'packages/infra/test/supervisor-session.test.js',
  'packages/infra/test/cedar-user-context.test.js',
  'test/e2e/tui-e2e-basic.test.js',
  'test/e2e/tui-e2e-slash.test.js',
  'test/e2e/tui-e2e-input.test.js',
  'test/e2e/tui-e2e-regression.test.js',
  'packages/server/test/server.test.js',
  'packages/server/test/auth-e2e-rest.test.js',
  'packages/server/test/auth-e2e-ws.test.js',
  'packages/server/test/auth-e2e-admin.test.js',
  'packages/server/test/scheduler-e2e.test.js',
  'packages/server/test/a2a-boot-guard.test.js',
  'packages/server/test/a2a-discovery.test.js',
  'packages/server/test/a2a-invoke.test.js',
])

const tests = [
  // Workspace import map smoke test (must run first)
  'test/workspace/smoke.test.js',
  'packages/core/test/core/make-op.test.js',
  'packages/core/test/core/op.test.js',
  'packages/core/test/core/agent-id.test.js',
  'packages/infra/test/state.test.js',
  'packages/infra/test/hook.test.js',
  'packages/infra/test/origin-state.test.js',
  'packages/core/test/interpreter/test.test.js',
  'packages/core/test/core/free-integration.test.js',
  'packages/core/test/core/fp-laws.test.js',
  'packages/core/test/core/plan.test.js',
  'packages/core/test/core/prompt.test.js',
  'packages/core/test/core/history-writer.test.js',
  'packages/core/test/core/turn-lifecycle.test.js',
  'packages/infra/test/tools.test.js',
  'packages/core/test/core/agent.test.js',
  'packages/core/test/core/assembly.test.js',
  // FSM Transition Algebra (Phase 1 PoC)
  'packages/core/test/core/fsm-core.test.js',
  'packages/core/test/core/fsm-product.test.js',
  'packages/core/test/core/fsm-laws.test.js',
  'packages/infra/test/turn-gate-fsm.test.js',
  // FSM Runtime + EventBus (Phase 2 PoC)
  'packages/core/test/core/fsm-event-bus.test.js',
  'packages/core/test/core/fsm-runtime.test.js',
  // FSM Bridge (Phase 4)
  'packages/infra/test/turn-gate-bridge.test.js',
  // approveFSM + bridge (Phase 6)
  'packages/infra/test/approve-fsm.test.js',
  'packages/infra/test/approve-bridge.test.js',
  // delegateFSM + bridge (Phase 7)
  'packages/infra/test/delegate-fsm.test.js',
  'packages/infra/test/delegate-bridge.test.js',
  // SessionFSM 합성 (Phase 8)
  'packages/infra/test/session-fsm.test.js',
  // Phase 1 infra
  'packages/infra/test/logger.test.js',
  'packages/infra/test/persistence.test.js',
  'packages/infra/test/embedding.test.js',
  'packages/infra/test/mcp.test.js',
  'packages/infra/test/mcp-sse.test.js',
  'packages/infra/test/actors.test.js',
  'packages/infra/test/turn-controller.test.js',
  'packages/infra/test/agent-registry.test.js',
  'packages/infra/test/resolve-delegate-target.test.js',
  'packages/infra/test/agent-access.test.js',
  'packages/infra/test/agent-governance.test.js',
  'packages/infra/test/cedar-evaluator.test.js',
  'packages/infra/test/cedar-boot.test.js',
  'packages/infra/test/cedar-audit.test.js',
  'packages/infra/test/cedar-policy-cli.test.js',
  'packages/infra/test/cedar-user-context.test.js',
  'packages/infra/test/agent-cli.test.js',
  'packages/infra/test/self-card.test.js',
  'packages/infra/test/a2a-client.test.js',
  'packages/infra/test/events.test.js',
  'packages/infra/test/scheduler.test.js',
  'packages/infra/test/session.test.js',
  'packages/infra/test/session-manager-routing.test.js',
  'packages/infra/test/a2a-queue-store.test.js',
  'packages/infra/test/a2a-send-message.test.js',
  'packages/infra/test/a2a-response-dispatcher.test.js',
  'packages/infra/test/a2a-integration.test.js',
  'packages/infra/test/a2a-recovery.test.js',
  'packages/infra/test/check-access-interpreter.test.js',
  'packages/infra/test/agent-tools.test.js',
  'packages/infra/test/mirror-state.test.js',
  'packages/infra/test/local-tools.test.js',
  'packages/infra/test/config.test.js',
  'packages/infra/test/auth-user-store.test.js',
  'packages/infra/test/auth-remove-user.test.js',
  'packages/infra/test/auth-token.test.js',
  'packages/infra/test/auth-provider.test.js',
  'packages/infra/test/admin-bootstrap.test.js',
  'packages/infra/test/user-migration.test.js',
  'packages/infra/test/persona.test.js',
  'packages/infra/test/memory.test.js',
  'packages/tui/test/app.test.js',
  'packages/tui/test/remote.test.js',
  'packages/tui/test/interactive.test.js',
  'packages/tui/test/session-commands.test.js',
  'packages/tui/test/mcp-list-format.test.js',
  // History compaction
  'packages/core/test/core/compaction.test.js',
  // Phase 2
  'packages/infra/test/llm.test.js',
  'packages/core/test/interpreter/prod.test.js',
  'packages/core/test/interpreter/traced.test.js',
  'packages/core/test/interpreter/dryrun.test.js',
  'packages/core/test/core/repl.test.js',
  // Phase 5 integration
  'test/integration/phase5.test.js',
  // Regression
  'test/regression/llm-output.test.js',
  'test/regression/tool-defense.test.js',
  'test/regression/plan-fuzz.test.js',
  'test/regression/e2e-scenario.test.js',
  // Spec invariant static checks
  'test/regression/fsm-single-writer.test.js',
  'test/regression/agent-access-enforcement.test.js',
  'test/regression/agent-id-validation-enforcement.test.js',
  'test/regression/delegate-order-enforcement.test.js',
  'test/regression/i18n-key-parity.test.js',
  'test/regression/cedar-quota-policy.test.js',
  // applyFinalState ordering + turn chaining
  'packages/core/test/core/apply-final-state.test.js',
  // Turn concurrency
  'packages/core/test/core/turn-concurrency.test.js',
  // E2E bootstrap
  'test/e2e/tui-e2e-basic.test.js',
  'test/e2e/tui-e2e-slash.test.js',
  'test/e2e/tui-e2e-input.test.js',
  'test/e2e/tui-e2e-regression.test.js',
  // Interpreter
  'packages/core/test/interpreter/delegate.test.js',
  // Infra
  'packages/infra/test/supervisor-session.test.js',
  // Server
  'packages/server/test/server.test.js',
  'packages/server/test/auth-e2e-rest.test.js',
  'packages/server/test/auth-e2e-ws.test.js',
  'packages/server/test/auth-e2e-admin.test.js',
  'packages/server/test/scheduler-e2e.test.js',
  'packages/server/test/a2a-boot-guard.test.js',
  'packages/server/test/a2a-discovery.test.js',
  'packages/server/test/a2a-invoke.test.js',
]

const noNetwork = process.argv.includes('--no-network')
const serialFlag = process.argv.includes('--serial')

// 첫 smoke 테스트는 import map 검증 — 다른 테스트의 선결조건이라 항상 먼저 직렬 실행.
const SMOKE_FIRST = 'test/workspace/smoke.test.js'

// e2e/network 테스트는 port + PRESENCE_DIR 의 동시성 위험 (mkdtemp 로 dir 분리 중이지만
// PresenceServer 부팅 + listen() 동시 실행은 자원 contention). 직렬 실행 유지.
const isSerial = (path) => NETWORK_TESTS.has(path)

let allPassed = true
let totalPassed = 0
let totalFailed = 0
let filesFailed = 0
let skipped = 0
const failures = []

const fmtSummary = (output) => {
  const lines = output.trim().split('\n')
  const header = lines[0]
  const summary = lines[lines.length - 1]
  return { header, summary: summary.trim() }
}

const recordResult = (test, output) => {
  const match = output.match(/(\d+) passed, (\d+) failed/)
  if (match) {
    totalPassed += Number(match[1])
    totalFailed += Number(match[2])
    if (Number(match[2]) > 0) allPassed = false
  }
  const { header, summary } = fmtSummary(output)
  console.log(`  ✓ ${header} — ${summary}`)
}

const recordFailure = (test, err) => {
  allPassed = false
  filesFailed++
  console.error(`  ✗ ${test} FAILED`)
  const out = err.stdout || ''
  const match = out.match(/(\d+) passed, (\d+) failed/)
  if (match) {
    totalPassed += Number(match[1])
    totalFailed += Number(match[2])
  }
  const tail = out.trim().split('\n').slice(-5).join('\n')
  if (tail) console.error(tail)
  if (err.stderr) console.error(err.stderr.trim().split('\n').slice(0, 3).join('\n'))
  failures.push(test)
}

const runOne = async (test) => {
  try {
    const { stdout } = await execFileP('node', [test], { cwd: root, timeout: 60000 })
    recordResult(test, stdout)
  } catch (err) {
    recordFailure(test, err)
  }
}

// 동시성 큐 — 입력 배열을 worker N 개가 순차 소비.
const runParallel = async (paths, concurrency) => {
  let idx = 0
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < paths.length) {
      const i = idx++
      await runOne(paths[i])
    }
  })
  await Promise.all(workers)
}

const main = async () => {
  console.log(`=== Presence Test Suite${noNetwork ? ' (--no-network)' : serialFlag ? ' (--serial)' : ''} ===\n`)

  // Phase 1 — smoke (import map 검증 선행)
  if (!noNetwork || !NETWORK_TESTS.has(SMOKE_FIRST)) {
    await runOne(SMOKE_FIRST)
  }

  // Phase 2 — 모든 후속 테스트.
  //   각 파일이 별도 Node 프로세스 (execFile) 로 격리.
  //   network 테스트도 port 0 (ephemeral) + mkdtemp PRESENCE_DIR 로 자체 격리.
  //   --serial 플래그는 디버깅용 (병렬 issue 분리 시).
  const parallelPool = []
  for (const test of tests) {
    if (test === SMOKE_FIRST) continue
    if (noNetwork && NETWORK_TESTS.has(test)) {
      console.log(`  - ${test} (skipped: network)`)
      skipped++
      continue
    }
    parallelPool.push(test)
  }

  const concurrency = serialFlag ? 1 : Math.max(2, Math.min(cpus().length, 8))
  if (parallelPool.length > 0) {
    console.log(`\n  [${concurrency}-way] ${parallelPool.length} tests\n`)
    await runParallel(parallelPool, concurrency)
  }

  const skippedNote = skipped > 0 ? `, ${skipped} skipped (network)` : ''
  console.log(`\n=== Total: ${totalPassed} passed, ${totalFailed} failed${filesFailed > 0 ? `, ${filesFailed} file(s) errored` : ''}${skippedNote} ===`)

  if (failures.length > 0) {
    console.log('\nFailed files:')
    for (const f of failures) console.log(`  ${f}`)
  }
  if (noNetwork && skipped > 0) {
    console.log(`    To run all tests: node test/run.js`)
  }

  if (!allPassed || totalFailed > 0 || filesFailed > 0) process.exit(1)
}

main().catch(err => { console.error(err); process.exit(2) })
