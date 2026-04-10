import { mkdir, writeFile, rm } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { createHarness } from './harness.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FRAMES_ROOT = path.resolve(__dirname, '../../../../docs/ux/frames/mock')

const DEFAULT_STEP_TIMEOUT_MS = 3000

const withTimeout = (promise, ms, label) => {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`step timeout ${ms}ms: ${label}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const sanitize = (label) =>
  label
    .replace(/[\s\/]+/g, '-')
    .replace(/[^\w가-힣\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'step'

const runScenario = async (scenario, harness) => {
  const results = []
  for (let index = 0; index < scenario.steps.length; index++) {
    const step = scenario.steps[index]
    const label = step.label || `step-${index + 1}`
    const timeoutMs = step.timeout ?? scenario.timeout ?? DEFAULT_STEP_TIMEOUT_MS
    const result = { index: index + 1, label, status: 'pending', frame: '', error: null }

    try {
      await withTimeout(Promise.resolve().then(() => step.action(harness)), timeoutMs, label)
      result.frame = harness.frame()
      if (typeof step.assert === 'function') {
        const assertion = step.assert(result.frame, harness)
        if (assertion === false) {
          result.status = 'assertion-failed'
          result.error = `assertion failed at "${label}"`
        } else {
          result.status = 'ok'
        }
      } else {
        result.status = 'ok'
      }
    } catch (err) {
      result.status = 'error'
      result.error = err.message
      try { result.frame = harness.frame() } catch {}
    }

    results.push(result)
    if (result.status === 'error') break
  }
  return results
}

const writeFrameFile = async (dir, result) => {
  const filename = `${String(result.index).padStart(2, '0')}-${sanitize(result.label)}.txt`
  const header = [
    `# step ${result.index}: ${result.label}`,
    `# status: ${result.status}`,
    result.error ? `# error: ${result.error}` : null,
    '',
    '',
  ].filter(line => line != null).join('\n')
  await writeFile(path.join(dir, filename), header + (result.frame ?? ''))
}

const writeReadme = async (dir, scenario, results) => {
  const ok = results.filter(r => r.status === 'ok').length
  const total = results.length
  const lines = [
    `# ${scenario.name}`,
    '',
    scenario.description ?? '',
    '',
    `**결과**: ${ok}/${total} 단계 통과`,
    '',
    '| # | 단계 | 상태 | 오류 |',
    '|---|------|------|------|',
    ...results.map(r => `| ${r.index} | ${r.label} | ${r.status} | ${r.error ?? ''} |`),
    '',
    '각 단계의 프레임은 같은 디렉토리의 `NN-*.txt` 파일에 저장되어 있습니다.',
    '',
  ]
  await writeFile(path.join(dir, 'README.md'), lines.join('\n'))
}

const saveFrames = async (scenario, results) => {
  const dir = path.join(FRAMES_ROOT, scenario.name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  for (const r of results) await writeFrameFile(dir, r)
  await writeReadme(dir, scenario, results)
  return dir
}

const runScenarios = async (scenarios) => {
  let hadError = false
  for (const scenario of scenarios) {
    process.stdout.write(`▶ ${scenario.name}\n`)
    const harness = await createHarness(scenario.setup ?? {})
    let results
    try {
      results = await runScenario(scenario, harness)
    } finally {
      harness.unmount()
    }
    const dir = await saveFrames(scenario, results)
    const ok = results.filter(r => r.status === 'ok').length
    const assertionFails = results.filter(r => r.status === 'assertion-failed')
    const errors = results.filter(r => r.status === 'error')
    if (errors.length > 0) hadError = true

    process.stdout.write(`  ${ok}/${results.length} ok → ${path.relative(process.cwd(), dir)}\n`)
    for (const r of assertionFails) process.stdout.write(`    ⚠ assertion: ${r.label}\n`)
    for (const r of errors) process.stdout.write(`    ✗ error: ${r.label} — ${r.error}\n`)
  }
  return !hadError
}

export { runScenarios, runScenario, saveFrames, withTimeout, FRAMES_ROOT }
