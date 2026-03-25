import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const tests = [
  'test/core/makeOp.test.js',
  'test/core/op.test.js',
  'test/infra/state.test.js',
  'test/infra/hook.test.js',
  'test/infra/reactiveState.test.js',
  'test/interpreter/test.test.js',
  'test/core/free-integration.test.js',
  'test/core/plan.test.js',
  'test/core/prompt.test.js',
  'test/infra/tools.test.js',
  'test/core/agent.test.js',
  'test/core/assembly.test.js',
  // Phase 1 infra
  'test/infra/logger.test.js',
  'test/infra/persistence.test.js',
  'test/infra/memory.test.js',
  'test/infra/embedding.test.js',
  'test/infra/mcp.test.js',
  'test/infra/mcp-sse.test.js',
  'test/infra/memory-hook.test.js',
  'test/infra/actors.test.js',
  'test/infra/agent-registry.test.js',
  'test/infra/a2a-client.test.js',
  'test/infra/events.test.js',
  'test/infra/heartbeat.test.js',
  'test/infra/local-tools.test.js',
  'test/infra/config.test.js',
  'test/infra/persona.test.js',
  'test/ui/app.test.js',
  'test/ui/interactive.test.js',
  // History compaction
  'test/core/compaction.test.js',
  // Phase 2
  'test/infra/llm.test.js',
  'test/interpreter/prod.test.js',
  'test/interpreter/traced.test.js',
  'test/interpreter/dryrun.test.js',
  'test/infra/input.test.js',
  'test/core/repl.test.js',
  // Phase 5 integration
  'test/integration/phase5.test.js',
  // Regression
  'test/regression/llm-output.test.js',
  'test/regression/tool-defense.test.js',
  'test/regression/plan-fuzz.test.js',
  'test/regression/e2e-scenario.test.js',
  // E2E bootstrap
  'test/e2e/bootstrap.test.js',
  // Server
  'test/server/server.test.js',
]

let allPassed = true
let totalPassed = 0
let totalFailed = 0
let filesFailed = 0

console.log('=== Presence Test Suite ===\n')

for (const test of tests) {
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

console.log(`\n=== Total: ${totalPassed} passed, ${totalFailed} failed${filesFailed > 0 ? `, ${filesFailed} file(s) errored` : ''} ===`)

if (!allPassed || totalFailed > 0 || filesFailed > 0) {
  process.exit(1)
}
