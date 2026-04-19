import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

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
  'test/e2e/tui-e2e.test.js',
  'packages/server/test/server.test.js',
  'packages/server/test/auth-e2e.test.js',
])

const tests = [
  // Workspace import map smoke test (must run first)
  'test/workspace/smoke.test.js',
  'packages/core/test/core/make-op.test.js',
  'packages/core/test/core/op.test.js',
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
  'packages/infra/test/a2a-client.test.js',
  'packages/infra/test/events.test.js',
  'packages/infra/test/scheduler.test.js',
  'packages/infra/test/session.test.js',
  'packages/infra/test/mirror-state.test.js',
  'packages/infra/test/local-tools.test.js',
  'packages/infra/test/config.test.js',
  'packages/infra/test/auth-user-store.test.js',
  'packages/infra/test/auth-remove-user.test.js',
  'packages/infra/test/auth-token.test.js',
  'packages/infra/test/auth-provider.test.js',
  'packages/infra/test/persona.test.js',
  'packages/infra/test/memory.test.js',
  'packages/tui/test/app.test.js',
  'packages/tui/test/remote.test.js',
  'packages/tui/test/interactive.test.js',
  'packages/tui/test/session-commands.test.js',
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
  // applyFinalState ordering + turn chaining
  'packages/core/test/core/apply-final-state.test.js',
  // Turn concurrency
  'packages/core/test/core/turn-concurrency.test.js',
  // E2E bootstrap
  'test/e2e/tui-e2e.test.js',
  // Interpreter
  'packages/core/test/interpreter/delegate.test.js',
  // Infra
  'packages/infra/test/supervisor-session.test.js',
  // Server
  'packages/server/test/server.test.js',
  'packages/server/test/auth-e2e.test.js',
]

const noNetwork = process.argv.includes('--no-network')

let allPassed = true
let totalPassed = 0
let totalFailed = 0
let filesFailed = 0
let skipped = 0

console.log(`=== Presence Test Suite${noNetwork ? ' (--no-network)' : ''} ===\n`)

for (const test of tests) {
  if (noNetwork && NETWORK_TESTS.has(test)) {
    console.log(`  - ${test} (skipped: network)`)
    skipped++
    continue
  }

  try {
    const output = execSync(`node ${test}`, { cwd: root, encoding: 'utf-8', timeout: 30000 })
    const match = output.match(/(\d+) passed, (\d+) failed/)
    if (match) {
      totalPassed += Number(match[1])
      totalFailed += Number(match[2])
      if (Number(match[2]) > 0) allPassed = false
    }
    const lines = output.trim().split('\n')
    const header = lines[0]
    const summary = lines[lines.length - 1]
    console.log(`  ✓ ${header} — ${summary.trim()}`)
  } catch (e) {
    allPassed = false
    filesFailed++
    console.error(`  ✗ ${test} FAILED`)
    if (e.stdout) {
      // Show stdout to capture any partial test results
      const match = e.stdout.match(/(\d+) passed, (\d+) failed/)
      if (match) {
        totalPassed += Number(match[1])
        totalFailed += Number(match[2])
      }
      console.error(e.stdout.trim().split('\n').slice(-5).join('\n'))
    }
    if (e.stderr) {
      console.error(e.stderr.trim().split('\n').slice(0, 3).join('\n'))
    }
    if (!e.stdout && !e.stderr) {
      console.error(`    ${e.message}`)
    }
  }
}

const skippedNote = skipped > 0 ? `, ${skipped} skipped (network)` : ''
console.log(`\n=== Total: ${totalPassed} passed, ${totalFailed} failed${filesFailed > 0 ? `, ${filesFailed} file(s) errored` : ''}${skippedNote} ===`)

if (noNetwork && skipped > 0) {
  console.log(`    To run all tests: node test/run.js`)
}

if (!allPassed || totalFailed > 0 || filesFailed > 0) {
  process.exit(1)
}
