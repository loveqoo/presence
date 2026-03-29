import { createChildManager } from '@presence/orchestrator/child-manager'
import { assert, summary } from '../lib/assert.js'

async function run() {
  console.log('ChildManager unit tests')

  const logs = []
  const logger = {
    info: (...args) => logs.push(['info', args.join(' ')]),
    warn: (...args) => logs.push(['warn', args.join(' ')]),
    error: (...args) => logs.push(['error', args.join(' ')]),
  }

  // --- createChildManager 생성 ---
  {
    const mgr = createChildManager({ logger, presenceDir: '/tmp/test' })
    assert(typeof mgr.forkInstance === 'function', 'createChildManager: has forkInstance')
    assert(typeof mgr.stopInstance === 'function', 'createChildManager: has stopInstance')
    assert(typeof mgr.restartInstance === 'function', 'createChildManager: has restartInstance')
    assert(typeof mgr.getStatus === 'function', 'createChildManager: has getStatus')
    assert(typeof mgr.listStatus === 'function', 'createChildManager: has listStatus')
    assert(typeof mgr.shutdownAll === 'function', 'createChildManager: has shutdownAll')
  }

  // --- listStatus 초기 상태 ---
  {
    const mgr = createChildManager({ logger, presenceDir: '/tmp/test' })
    const list = mgr.listStatus()
    assert(Array.isArray(list), 'listStatus: returns array')
    assert(list.length === 0, 'listStatus: empty initially')
  }

  // --- getStatus 존재하지 않는 인스턴스 ---
  {
    const mgr = createChildManager({ logger, presenceDir: '/tmp/test' })
    const status = mgr.getStatus('nonexistent')
    assert(status === null, 'getStatus: null for unknown id')
  }

  // --- stopInstance 존재하지 않는 인스턴스 ---
  {
    const mgr = createChildManager({ logger, presenceDir: '/tmp/test' })
    await mgr.stopInstance('nonexistent') // should not throw
    assert(true, 'stopInstance: no-op for unknown id')
  }

  // --- restartInstance 존재하지 않는 인스턴스 ---
  {
    const mgr = createChildManager({ logger, presenceDir: '/tmp/test' })
    const result = await mgr.restartInstance('nonexistent')
    assert(result === null, 'restartInstance: null for unknown id')
  }

  summary()
}

run()
