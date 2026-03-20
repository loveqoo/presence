import { createMemoryGraph, TIERS } from '../../src/infra/memory.js'
import { existsSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

async function run() {
  console.log('Graph memory tests')

  // 1. Add node + find
  {
    const g = await createMemoryGraph()
    const node = g.addNode({ label: '우리집' })
    assert(node.id !== undefined, 'addNode: has id')
    assert(node.label === '우리집', 'addNode: correct label')

    const found = g.findNode(node.id)
    assert(found !== null && found.label === '우리집', 'findNode: found by id')
  }

  // 2. Add edge + query
  {
    const g = await createMemoryGraph()
    const house = g.addNode({ label: '우리집' })
    const seoul = g.addNode({ label: '서울' })
    g.addEdge(house.id, seoul.id, '위치')

    const results = g.query({ from: house.id, relation: '위치' })
    assert(results.length === 1, 'query: 1 result')
    assert(results[0].label === '서울', 'query: correct target')
  }

  // 3. Multi-hop query (depth=2)
  {
    const g = await createMemoryGraph()
    const house = g.addNode({ label: '우리집' })
    const restaurantA = g.addNode({ label: 'A식당' })
    const restaurantB = g.addNode({ label: 'B식당' })
    const gangnam = g.addNode({ label: '서울 강남' })

    g.addEdge(house.id, restaurantA.id, '주변맛집')
    g.addEdge(house.id, restaurantB.id, '주변맛집')
    g.addEdge(restaurantA.id, gangnam.id, '위치')

    // depth=1: only direct neighbors
    const d1 = g.query({ from: house.id, relation: '주변맛집', depth: 1 })
    assert(d1.length === 2, 'depth=1: 2 restaurants')

    // depth=2: restaurants + their connections (without relation filter)
    const d2 = g.query({ from: house.id, depth: 2 })
    const labels = d2.map(n => n.label).sort()
    assert(labels.includes('A식당'), 'depth=2: includes A식당')
    assert(labels.includes('서울 강남'), 'depth=2: includes 서울 강남')
  }

  // 4. recall by text
  {
    const g = await createMemoryGraph()
    const house = g.addNode({ label: '우리집' })
    const restaurantA = g.addNode({ label: 'A식당' })
    g.addEdge(house.id, restaurantA.id, '주변맛집')

    const results = g.recall('우리집 맛집')
    const labels = results.map(n => n.label)
    assert(labels.includes('우리집'), 'recall: includes 우리집')
    assert(labels.includes('A식당'), 'recall: includes connected A식당')
  }

  // 5. Tier management
  {
    const g = await createMemoryGraph()
    g.addNode({ label: 'working-data', tier: TIERS.WORKING })
    g.addNode({ label: 'past-chat', tier: TIERS.EPISODIC })
    g.addNode({ label: 'fact', tier: TIERS.SEMANTIC })

    assert(g.getNodesByTier(TIERS.WORKING).length === 1, 'tier: 1 working')
    assert(g.getNodesByTier(TIERS.SEMANTIC).length === 1, 'tier: 1 semantic')

    g.removeNodesByTier(TIERS.WORKING)
    assert(g.getNodesByTier(TIERS.WORKING).length === 0, 'removeByTier: working cleared')
    assert(g.allNodes().length === 2, 'removeByTier: others remain')
  }

  // 6. Promote node
  {
    const g = await createMemoryGraph()
    const node = g.addNode({ label: 'temp', tier: TIERS.EPISODIC })
    g.promoteNode(node.id, TIERS.SEMANTIC)
    assert(g.findNode(node.id).tier === TIERS.SEMANTIC, 'promote: episodic → semantic')
  }

  // 7. Persistence with lowdb
  {
    const dbPath = join(tmpdir(), `presence-mem-test-${Date.now()}`, 'graph.json')

    const g1 = await createMemoryGraph(dbPath)
    const n1 = g1.addNode({ label: 'persistent' })
    g1.addEdge(n1.id, n1.id, 'self')
    await g1.save()

    assert(existsSync(dbPath), 'persistence: file created')

    // Reload
    const g2 = await createMemoryGraph(dbPath)
    assert(g2.allNodes().length === 1, 'persistence: nodes restored')
    assert(g2.allNodes()[0].label === 'persistent', 'persistence: correct data')
    assert(g2.allEdges().length === 1, 'persistence: edges restored')

    rmSync(dirname(dbPath), { recursive: true, force: true })
  }

  // 8. Empty graph query
  {
    const g = await createMemoryGraph()
    const results = g.query({ from: 'nonexistent', relation: 'any' })
    assert(results.length === 0, 'empty query: returns []')
  }

  // 9. recall empty text
  {
    const g = await createMemoryGraph()
    assert(g.recall('').length === 0, 'recall empty: returns []')
    assert(g.recall(null).length === 0, 'recall null: returns []')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
