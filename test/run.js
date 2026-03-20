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
  // Phase 1 infra
  'test/infra/logger.test.js',
  'test/infra/persistence.test.js',
  'test/infra/memory.test.js',
  'test/infra/memory-hook.test.js',
  'test/infra/persona.test.js',
  'test/ui/app.test.js',
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
