import fc from 'fast-check'
import fp from '../../src/lib/fun-fp.js'
import { MemoryGraph, TIERS } from '../../src/infra/memory.js'
import { assert, check, summary, eqMaybe, eqEither, runTask, eqTask } from '../lib/assert.js'

const { Maybe, Either, Task, Free } = fp

// Free.of-only programs never invoke the runner
const noRunner = () => { throw new Error('unexpected impure step') }
const runFree = prog => Free.runSync(noRunner)(prog)

async function run() {
  console.log('Property-based tests (fp laws + MemoryGraph invariants)')

  // ─── Maybe: Functor + Monad laws ─────────────────────────────────────
  const mf = x => x > 0 ? Maybe.Just(x + 1) : Maybe.Nothing()
  const mg = x => Maybe.Just(x * 2)

  await Promise.all([
    check('Maybe.Just: functor identity', () =>
      fc.assert(fc.property(fc.integer(), v =>
        eqMaybe(Maybe.Just(v).map(x => x), Maybe.Just(v))
      ))
    ),
    check('Maybe.Just: functor composition', () =>
      fc.assert(fc.property(fc.integer(), v => {
        const f = x => x + 1, g = x => x * 2
        return eqMaybe(Maybe.Just(v).map(f).map(g), Maybe.Just(v).map(x => g(f(x))))
      }))
    ),
    check('Maybe.Nothing: functor laws (map preserves Nothing)', () =>
      fc.assert(fc.property(fc.integer(), () => {
        const f = x => x + 1, g = x => x * 2, n = Maybe.Nothing()
        return n.map(x => x).isNothing() && n.map(f).map(g).isNothing()
      }))
    ),
    check('Maybe: monad left identity — of(a).chain(f) === f(a)', () =>
      fc.assert(fc.property(fc.integer(), a =>
        eqMaybe(Maybe.of(a).chain(mf), mf(a))
      ))
    ),
    check('Maybe: monad right identity — m.chain(of) === m', () =>
      fc.assert(fc.property(fc.boolean(), fc.integer(), (isJust, v) => {
        const m = isJust ? Maybe.Just(v) : Maybe.Nothing()
        return eqMaybe(m.chain(Maybe.of), m)
      }))
    ),
    check('Maybe: monad associativity — m.chain(f).chain(g) === m.chain(x => f(x).chain(g))', () =>
      fc.assert(fc.property(fc.boolean(), fc.integer(), (isJust, v) => {
        const m = isJust ? Maybe.Just(v) : Maybe.Nothing()
        return eqMaybe(m.chain(mf).chain(mg), m.chain(x => mf(x).chain(mg)))
      }))
    ),
  ])

  // ─── Either: Functor + Monad laws ────────────────────────────────────
  const ef = x => x > 0 ? Either.Right(x + 1) : Either.Left('negative')
  const eg = x => Either.Right(x * 2)

  await Promise.all([
    check('Either.Right: functor identity', () =>
      fc.assert(fc.property(fc.integer(), v =>
        eqEither(Either.Right(v).map(x => x), Either.Right(v))
      ))
    ),
    check('Either.Right: functor composition', () =>
      fc.assert(fc.property(fc.integer(), v => {
        const f = x => x + 1, g = x => x * 2
        return eqEither(Either.Right(v).map(f).map(g), Either.Right(v).map(x => g(f(x))))
      }))
    ),
    check('Either.Left: functor preserves Left (map is no-op)', () =>
      fc.assert(fc.property(fc.string(), e =>
        eqEither(Either.Left(e).map(x => x + 1), Either.Left(e))
      ))
    ),
    check('Either: monad left identity — of(a).chain(f) === f(a)', () =>
      fc.assert(fc.property(fc.integer(), a =>
        eqEither(Either.of(a).chain(ef), ef(a))
      ))
    ),
    check('Either: monad right identity — m.chain(of) === m', () =>
      fc.assert(fc.property(fc.boolean(), fc.integer(), fc.string(), (isRight, v, err) => {
        const m = isRight ? Either.Right(v) : Either.Left(err)
        return eqEither(m.chain(Either.of), m)
      }))
    ),
    check('Either: monad associativity — m.chain(f).chain(g) === m.chain(x => f(x).chain(g))', () =>
      fc.assert(fc.property(fc.boolean(), fc.integer(), fc.string(), (isRight, v, err) => {
        const m = isRight ? Either.Right(v) : Either.Left(err)
        return eqEither(m.chain(ef).chain(eg), m.chain(x => ef(x).chain(eg)))
      }))
    ),
  ])

  // ─── Free: Monad + Functor laws (Pure-only programs) ─────────────────
  await Promise.all([
    check('Free: monad left identity — of(a).chain(f) runs to same value as f(a)', () =>
      fc.assert(fc.property(fc.integer(), a => {
        const f = x => Free.of(x + 1)
        return runFree(Free.of(a).chain(f)) === runFree(f(a))
      }))
    ),
    check('Free: monad right identity — p.chain(of) runs to same value as p', () =>
      fc.assert(fc.property(fc.integer(), a => {
        const p = Free.of(a)
        return runFree(p.chain(Free.of)) === runFree(p)
      }))
    ),
    check('Free: monad associativity', () =>
      fc.assert(fc.property(fc.integer(), a => {
        const f = x => Free.of(x + 1)
        const g = x => Free.of(x * 2)
        const p = Free.of(a)
        return runFree(p.chain(f).chain(g)) === runFree(p.chain(x => f(x).chain(g)))
      }))
    ),
    check('Free: functor identity — of(a).map(id) runs to a', () =>
      fc.assert(fc.property(fc.integer(), a =>
        runFree(Free.of(a).map(x => x)) === a
      ))
    ),
    check('Free: functor composition — map(f).map(g) === map(g∘f)', () =>
      fc.assert(fc.property(fc.integer(), a => {
        const f = x => x + 1, g = x => x * 2
        return runFree(Free.of(a).map(f).map(g)) === runFree(Free.of(a).map(x => g(f(x))))
      }))
    ),
  ])

  // ─── Task: Functor + Monad laws (async, run in parallel) ─────────────
  const tf = x => Task.of(x + 1)
  const tg = x => Task.of(x * 2)

  await Promise.all([
    check('Task: functor identity', () =>
      fc.assert(fc.asyncProperty(fc.integer(), async a =>
        eqTask(Task.of(a).map(x => x), Task.of(a))
      ))
    ),
    check('Task: functor composition', () =>
      fc.assert(fc.asyncProperty(fc.integer(), async a => {
        const f = x => x + 1, g = x => x * 2
        return eqTask(Task.of(a).map(f).map(g), Task.of(a).map(x => g(f(x))))
      }))
    ),
    check('Task: monad left identity — of(a).chain(f) resolves same as f(a)', () =>
      fc.assert(fc.asyncProperty(fc.integer(), async a =>
        eqTask(Task.of(a).chain(tf), tf(a))
      ))
    ),
    check('Task: monad right identity — t.chain(of) resolves same as t', () =>
      fc.assert(fc.asyncProperty(fc.integer(), async a =>
        eqTask(Task.of(a).chain(Task.of), Task.of(a))
      ))
    ),
    check('Task: monad associativity', () =>
      fc.assert(fc.asyncProperty(fc.integer(), async a => {
        const t = Task.of(a)
        return eqTask(t.chain(tf).chain(tg), t.chain(x => tf(x).chain(tg)))
      }))
    ),
  ])

  // ─── MemoryGraph: structural invariants ───────────────────────────────
  await Promise.all([
    check('MemoryGraph: working tier — no dedup, each addNode creates a node', () =>
      fc.assert(fc.property(
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 20 }),
        labels => {
          const g = MemoryGraph.create()
          labels.forEach(label => g.addNode({ label, tier: TIERS.WORKING }))
          return g.allNodes().length === labels.length
        }
      ))
    ),
    check('MemoryGraph: episodic dedup — same label+data→1 node regardless of call count', () =>
      fc.assert(fc.property(
        fc.string({ minLength: 1 }),
        fc.integer({ min: 2, max: 10 }),
        (label, n) => {
          const g = MemoryGraph.create()
          const data = { x: 1 }
          for (let i = 0; i < n; i++) g.addNode({ label, type: 'entity', data, tier: TIERS.EPISODIC })
          return g.allNodes().length === 1
        }
      ))
    ),
    check('MemoryGraph: source dedup — distinct sources → separate nodes despite same label', () =>
      fc.assert(fc.property(
        fc.array(fc.string({ minLength: 2 }), { minLength: 2, maxLength: 10 }),
        tools => {
          const unique = [...new Set(tools)]
          if (unique.length < 2) return true
          const g = MemoryGraph.create()
          unique.forEach(tool => g.addNode({ label: 'same', data: {}, tier: TIERS.EPISODIC, source: { tool, toolArgs: {} } }))
          return g.allNodes().length === unique.length
        }
      ))
    ),
    check('MemoryGraph: findNode — every addNode result is findable by id', () =>
      fc.assert(fc.property(
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 15 }),
        labels => {
          const g = MemoryGraph.create()
          const nodes = labels.map(label => g.addNode({ label, tier: TIERS.WORKING }))
          return nodes.every(n => g.findNode(n.id).isJust())
        }
      ))
    ),
    check('MemoryGraph: pruneByTier — retains exactly maxCount newest nodes', () =>
      fc.assert(fc.property(
        fc.integer({ min: 2, max: 30 }),
        fc.integer({ min: 1, max: 29 }),
        (n, maxCount) => {
          if (maxCount >= n) return true
          const g = MemoryGraph.create()
          for (let i = 0; i < n; i++) g.addNode({ label: `node-${i}`, tier: TIERS.EPISODIC })
          g.pruneByTier(TIERS.EPISODIC, maxCount)
          return g.getNodesByTier(TIERS.EPISODIC).length === maxCount
        }
      ))
    ),
    check('MemoryGraph: removeNodes — predicate removes exactly matching nodes', () =>
      fc.assert(fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 19 }),
        (n, expiredCount) => {
          if (expiredCount > n) return true
          const g = MemoryGraph.create()
          const past = Date.now() - 1000
          const future = Date.now() + 60_000
          for (let i = 0; i < expiredCount; i++) {
            g.addNode({ label: `e-${i}`, tier: TIERS.EPISODIC, expiresAt: past })
          }
          for (let i = 0; i < n - expiredCount; i++) {
            g.addNode({ label: `v-${i}`, tier: TIERS.EPISODIC, expiresAt: future })
          }
          const removed = g.removeNodes(node => node.expiresAt != null && node.expiresAt <= Date.now())
          return removed === expiredCount && g.allNodes().length === n - expiredCount
        }
      ))
    ),
    check('MemoryGraph: addEdge — orphan edges cleaned up after removeNodes', () =>
      fc.assert(fc.property(
        fc.integer({ min: 2, max: 10 }),
        n => {
          const g = MemoryGraph.create()
          const nodes = []
          for (let i = 0; i < n; i++) nodes.push(g.addNode({ label: `n-${i}`, tier: TIERS.WORKING }))
          for (let i = 0; i < n - 1; i++) g.addEdge(nodes[i].id, nodes[i + 1].id, 'next')
          g.removeNodes(node => node.id === nodes[0].id)
          return g.allEdges().every(e => e.from !== nodes[0].id && e.to !== nodes[0].id)
        }
      ))
    ),
  ])

  summary()
}

run()
