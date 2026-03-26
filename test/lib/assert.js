import fp from '../../src/lib/fun-fp.js'

const { Maybe, Either, Task } = fp

let passed = 0
let failed = 0

const assert = (condition, msg) => {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

const assertDeepEqual = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), msg)

const check = async (label, run) => {
  try { await run(); assert(true, label) }
  catch (e) { assert(false, `${label} — ${e.message}`) }
}

const summary = () => {
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

// ── FP equality helpers ────────────────────────────────────────────────

const eqMaybe = (a, b) =>
  (a.isNothing() && b.isNothing()) ||
  (a.isJust() && b.isJust() && a.value === b.value)

const eqEither = (a, b) =>
  (a.isLeft() && b.isLeft() && a.value === b.value) ||
  (a.isRight() && b.isRight() && a.value === b.value)

const runTask = t => new Promise((res, rej) => t.fork(rej, res))

const eqTask = async (a, b) => {
  const [ra, rb] = await Promise.all([runTask(a), runTask(b)])
  return ra === rb
}

export { assert, assertDeepEqual, check, summary, eqMaybe, eqEither, runTask, eqTask }
