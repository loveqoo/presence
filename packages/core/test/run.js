import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '../../..')

const tests = [
  'packages/core/test/core/makeOp.test.js',
  'packages/core/test/core/op.test.js',
  'packages/core/test/core/free-integration.test.js',
  'packages/core/test/core/fp-laws.test.js',
  'packages/core/test/core/plan.test.js',
  'packages/core/test/core/prompt.test.js',
  'packages/core/test/core/agent.test.js',
  'packages/core/test/core/assembly.test.js',
  'packages/core/test/core/compaction.test.js',
  'packages/core/test/core/repl.test.js',
  'packages/core/test/core/apply-final-state.test.js',
  'packages/core/test/core/turn-concurrency.test.js',
  'packages/core/test/interpreter/test.test.js',
  'packages/core/test/interpreter/traced.test.js',
  'packages/core/test/interpreter/dryrun.test.js',
  'packages/core/test/interpreter/prod.test.js',
  'packages/core/test/interpreter/delegate.test.js',
]

let allPassed = true
let totalPassed = 0
let totalFailed = 0
let filesFailed = 0

console.log('=== @presence/core Test Suite ===\n')

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
