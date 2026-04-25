import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { createA2aQueueStore, TODO_STATUS, TODO_KIND } from '@presence/infra/infra/a2a/a2a-queue-store.js'
import { dispatchResponse } from '@presence/infra/infra/a2a/a2a-response-dispatcher.js'
import { EVENT_TYPE } from '@presence/core/core/policies.js'
import { assert, summary } from '../../../test/lib/assert.js'

const makeTmpDir = () => {
  const dir = join(tmpdir(), `presence-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const AGENT_SENDER = 'alice/planner'
const AGENT_RECEIVER = 'alice/worker'

const makeSenderSession = (enqueueImpl) => ({
  kind: 'ok',
  entry: {
    type: 'agent',
    session: { agentId: AGENT_SENDER, actors: { eventActor: { enqueue: enqueueImpl } } },
  },
})

const mockSessionManager = (routing) => ({ findSenderSession: () => routing })

const run = async () => {
  console.log('A2A Response Dispatcher tests')

  // RD1. sender=ok → response row 'completed' + a2a_response event enqueue + enqueued=true
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const request = store.enqueueRequest({ fromAgentId: AGENT_SENDER, toAgentId: AGENT_RECEIVER, payload: 'q' })

    const enqueued = []
    const senderRouting = makeSenderSession((event) => ({
      fork: (_reject, resolve) => { enqueued.push(event); resolve('ok') },
    }))

    const result = await dispatchResponse({
      a2aQueueStore: store,
      sessionManager: mockSessionManager(senderRouting),
      logger: null,
      request,
      status: TODO_STATUS.COMPLETED,
      payload: 'answer',
    })

    assert(result.enqueued === true, 'RD1: enqueued=true')
    assert(typeof result.responseId === 'string', 'RD1: responseId')
    assert(enqueued.length === 1, 'RD1: a2a_response event 1 회 enqueue')
    assert(enqueued[0].type === EVENT_TYPE.A2A_RESPONSE, 'RD1: event type')
    assert(enqueued[0].correlationId === request.id, 'RD1: correlationId 설정')
    assert(enqueued[0].payload === 'answer', 'RD1: payload 전달')
    const row = store.getMessage(result.responseId)
    assert(row.kind === TODO_KIND.RESPONSE, 'RD1: row.kind=response')
    assert(row.status === TODO_STATUS.COMPLETED, 'RD1: row.status=completed')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // RD2. sender=not-registered → response row 'orphaned' + event 미발행
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const request = store.enqueueRequest({ fromAgentId: AGENT_SENDER, toAgentId: AGENT_RECEIVER, payload: 'q' })

    const enqueued = []
    const result = await dispatchResponse({
      a2aQueueStore: store,
      sessionManager: mockSessionManager({ kind: 'not-registered', entry: null }),
      logger: null,
      request,
      status: TODO_STATUS.COMPLETED,
      payload: 'answer',
    })

    assert(result.enqueued === false, 'RD2: enqueued=false')
    assert(result.reason === 'not-registered', 'RD2: reason=not-registered')
    assert(enqueued.length === 0, 'RD2: event 미발행')
    const row = store.getMessage(result.responseId)
    assert(row.status === TODO_STATUS.ORPHANED, 'RD2: row.status=orphaned')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // RD3. sender=ambiguous → orphaned
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const request = store.enqueueRequest({ fromAgentId: AGENT_SENDER, toAgentId: AGENT_RECEIVER, payload: 'q' })
    const result = await dispatchResponse({
      a2aQueueStore: store,
      sessionManager: mockSessionManager({ kind: 'ambiguous', entry: null }),
      logger: null,
      request,
      status: TODO_STATUS.COMPLETED,
      payload: 'x',
    })
    assert(result.enqueued === false && result.reason === 'ambiguous', 'RD3: ambiguous → orphaned')
    const row = store.getMessage(result.responseId)
    assert(row.status === TODO_STATUS.ORPHANED, 'RD3: row.status=orphaned')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // RD4. sender session 에 eventActor 없음 → markOrphaned
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const request = store.enqueueRequest({ fromAgentId: AGENT_SENDER, toAgentId: AGENT_RECEIVER, payload: 'q' })
    const result = await dispatchResponse({
      a2aQueueStore: store,
      sessionManager: mockSessionManager({ kind: 'ok', entry: { type: 'agent', session: { agentId: AGENT_SENDER } } }),
      logger: null,
      request,
      status: TODO_STATUS.COMPLETED,
      payload: 'x',
    })
    assert(result.enqueued === false && result.reason === 'no-event-actor', 'RD4: no-event-actor')
    const row = store.getMessage(result.responseId)
    assert(row.status === TODO_STATUS.ORPHANED, 'RD4: markOrphaned 호출')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // RD5. sender eventActor.enqueue task fork reject → markOrphaned, reason='enqueue-failed'
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const request = store.enqueueRequest({ fromAgentId: AGENT_SENDER, toAgentId: AGENT_RECEIVER, payload: 'q' })
    const failRouting = makeSenderSession(() => ({
      fork: (reject) => reject(new Error('actor-stale')),
    }))
    const result = await dispatchResponse({
      a2aQueueStore: store,
      sessionManager: mockSessionManager(failRouting),
      logger: null,
      request,
      status: TODO_STATUS.COMPLETED,
      payload: 'x',
    })
    assert(result.enqueued === false && result.reason === 'enqueue-failed', 'RD5: enqueue-failed')
    const row = store.getMessage(result.responseId)
    assert(row.status === TODO_STATUS.ORPHANED, 'RD5: markOrphaned (race 방어)')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // RD extra. status='failed' 경로 — error 전파 확인
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const request = store.enqueueRequest({ fromAgentId: AGENT_SENDER, toAgentId: AGENT_RECEIVER, payload: 'q' })
    const captured = []
    const senderRouting = makeSenderSession((event) => ({
      fork: (_reject, resolve) => { captured.push(event); resolve('ok') },
    }))
    const result = await dispatchResponse({
      a2aQueueStore: store,
      sessionManager: mockSessionManager(senderRouting),
      logger: null,
      request,
      status: TODO_STATUS.FAILED,
      payload: null,
      error: 'agent-error',
    })
    assert(result.enqueued === true, 'RDx: failed 경로도 enqueued')
    assert(captured[0].status === TODO_STATUS.FAILED, 'RDx: event.status=failed')
    assert(captured[0].error === 'agent-error', 'RDx: event.error 전파')
    const row = store.getMessage(result.responseId)
    assert(row.status === TODO_STATUS.FAILED && row.error === 'agent-error', 'RDx: row error 저장')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  summary()
}

run().catch(err => { console.error(err); process.exit(1) })
