import fp from '@presence/core/lib/fun-fp.js'
import { EVENT_TYPE, STATE_PATH, TurnState } from '@presence/core/core/policies.js'
import { eventActorR } from '@presence/infra/infra/actors/event-actor.js'
import { turnActorR } from '@presence/infra/infra/actors/turn-actor.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { createA2aQueueStore, TODO_STATUS } from '@presence/infra/infra/a2a/a2a-queue-store.js'
import { dispatchResponse } from '@presence/infra/infra/a2a/a2a-response-dispatcher.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { assert, summary } from '../../../test/lib/assert.js'

const { Task } = fp
const delay = (ms) => new Promise(r => setTimeout(r, ms))

const makeTmpDir = () => {
  const dir = join(tmpdir(), `presence-a2a-recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const AGENT_SENDER = 'alice/planner'
const AGENT_RECEIVER = 'alice/worker'

// recovery 본체를 user-context.js 의 메서드로 호출하는 대신 동등 로직을 헬퍼로 제공
//   (UserContext 의 인프라 부담 없이 recovery 알고리즘만 검증 — UserContext.recoverA2aQueue
//    의 본체와 동일한 절차).
const runRecovery = async ({ a2aQueueStore, sessionManager, logger }) => {
  const limit = 1000
  const procRows = a2aQueueStore.listByStatus('processing', { kind: 'request', limit })
  for (const row of procRows) {
    if (!a2aQueueStore.markFailed(row.id, 'server-restart')) continue
    await dispatchResponse({
      a2aQueueStore, sessionManager, logger,
      request: row, status: 'failed', payload: null, error: 'server-restart',
    })
  }
  const pendingRows = a2aQueueStore.listByStatus('pending', { kind: 'request', limit })
  for (const row of pendingRows) {
    const routing = sessionManager.findAgentSession(row.toAgentId)
    if (routing.kind === 'ok') {
      const evActor = routing.entry?.session?.actors?.eventActor
      const ok = !evActor ? false : await new Promise((resolve) => {
        try {
          evActor.enqueue({
            id: row.id, type: EVENT_TYPE.A2A_REQUEST, prompt: row.payload,
            fromAgentId: row.fromAgentId, toAgentId: row.toAgentId, requestId: row.id,
            category: row.category ?? 'todo', receivedAt: Date.now(),
          }).fork(() => resolve(false), () => resolve(true))
        } catch (_) { resolve(false) }
      })
      if (!ok) {
        if (a2aQueueStore.markFailed(row.id, 'server-restart-enqueue-failed')) {
          await dispatchResponse({
            a2aQueueStore, sessionManager, logger,
            request: row, status: 'failed', payload: null, error: 'server-restart-enqueue-failed',
          })
        }
      }
    } else {
      if (a2aQueueStore.markFailed(row.id, 'server-restart-target-missing')) {
        await dispatchResponse({
          a2aQueueStore, sessionManager, logger,
          request: row, status: 'failed', payload: null, error: 'server-restart-target-missing',
        })
      }
    }
  }
}

// 단순 sender session — eventActor.enqueue 만 mock (a2a_response 받음)
const mockSender = (received) => ({
  kind: 'ok',
  entry: {
    type: 'agent',
    session: {
      agentId: AGENT_SENDER,
      actors: {
        eventActor: {
          enqueue: (event) => ({
            fork: (_reject, resolve) => { received.push(event); resolve('ok') },
          }),
        },
      },
    },
  },
})

const senderManager = (routing) => ({
  findAgentSession: () => ({ kind: 'not-registered', entry: null }),
  findSenderSession: () => routing,
})

// 실제 EventActor 인스턴스로 receiver 구성 (SR3 — drain 까지 검증)
const setupRealReceiver = ({ a2aQueueStore, turnFn }) => {
  const state = createOriginState({
    turnState: TurnState.idle(),
    context: { conversationHistory: [], memories: [], recentToolResults: [], budgetWarning: null },
    events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    todos: [],
  })
  const turnActor = turnActorR.run({ runTurn: turnFn })
  const eventActor = eventActorR.run({
    turnActor, state, logger: null, userDataStore: null, a2aQueueStore,
  })
  return { state, eventActor }
}

const receiverManagerWithSender = ({ receiverEventActor, senderRouting }) => ({
  findAgentSession: (agentId) => agentId === AGENT_RECEIVER
    ? { kind: 'ok', entry: { type: 'agent', session: { agentId: AGENT_RECEIVER, actors: { eventActor: receiverEventActor } } } }
    : { kind: 'not-registered', entry: null },
  findSenderSession: () => senderRouting,
})

const run = async () => {
  console.log('A2A recovery tests')

  // SR1: processing row + sender 등록 → markFailed + sender 의 eventActor 에 a2a_response 'failed/server-restart' 진입
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const req = store.enqueueRequest({ fromAgentId: AGENT_SENDER, toAgentId: AGENT_RECEIVER, payload: 'q' })
    store.markProcessing(req.id)
    const senderEvents = []
    await runRecovery({ a2aQueueStore: store, sessionManager: senderManager(mockSender(senderEvents)), logger: null })
    assert(store.getMessage(req.id).status === TODO_STATUS.FAILED, 'SR1: row.status=failed')
    assert(store.getMessage(req.id).error === 'server-restart', 'SR1: row.error=server-restart')
    assert(senderEvents.length === 1, 'SR1: sender eventActor 1 회 enqueue')
    assert(senderEvents[0].type === EVENT_TYPE.A2A_RESPONSE, 'SR1: a2a_response event type')
    assert(senderEvents[0].error === 'server-restart', 'SR1: event.error=server-restart')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // SR2: processing row + sender 부재 → markFailed + response row.status='orphaned'
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const req = store.enqueueRequest({ fromAgentId: AGENT_SENDER, toAgentId: AGENT_RECEIVER, payload: 'q' })
    store.markProcessing(req.id)
    const sm = senderManager({ kind: 'not-registered', entry: null })
    await runRecovery({ a2aQueueStore: store, sessionManager: sm, logger: null })
    assert(store.getMessage(req.id).status === TODO_STATUS.FAILED, 'SR2: row.status=failed')
    // dispatchResponse 가 sender 부재 시 orphaned response row 생성
    const orphans = store.listByStatus(TODO_STATUS.ORPHANED)
    assert(orphans.length === 1 && orphans[0].correlationId === req.id, 'SR2: response row orphaned')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // SR3: pending row + receiver 등록 → 실제 EventActor 에 enqueue + drain 까지 (markProcessing 호출 확인)
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const req = store.enqueueRequest({ fromAgentId: AGENT_SENDER, toAgentId: AGENT_RECEIVER, payload: 'do work' })
    let turnCalled = 0
    const { eventActor } = setupRealReceiver({
      a2aQueueStore: store,
      turnFn: async () => { turnCalled++; return 'done' },
    })
    const sm = receiverManagerWithSender({
      receiverEventActor: eventActor,
      senderRouting: mockSender([]),
    })
    await runRecovery({ a2aQueueStore: store, sessionManager: sm, logger: null })
    await delay(80)
    const after = store.getMessage(req.id)
    // receiver drain 이 markProcessing 한 후 turn 실행 + markCompleted 까지 가능 (mock turn 즉시 완료)
    assert(turnCalled >= 1, 'SR3: receiver turn 실제 실행됨')
    assert([TODO_STATUS.PROCESSING, TODO_STATUS.COMPLETED].includes(after.status),
      `SR3: drain 결과 row.status=processing 또는 completed (실제: ${after.status})`)
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // SR3b: 멱등성 — recovery 두 번 연속. 두 번째에서 같은 row 가 'processing' 분기로 (또는 final) → 중복 enqueue 안 됨
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const req = store.enqueueRequest({ fromAgentId: AGENT_SENDER, toAgentId: AGENT_RECEIVER, payload: 'idem' })
    let enqueueCount = 0
    const fakeReceiver = {
      enqueue: (event) => ({
        fork: (_reject, resolve) => {
          enqueueCount++
          // mock: enqueue 후 즉시 markProcessing 호출 (실제 EventActor drain 흉내)
          store.markProcessing(event.id)
          resolve('ok')
        },
      }),
    }
    const sm = {
      findAgentSession: (agentId) => agentId === AGENT_RECEIVER
        ? { kind: 'ok', entry: { type: 'agent', session: { agentId: AGENT_RECEIVER, actors: { eventActor: fakeReceiver } } } }
        : { kind: 'not-registered', entry: null },
      findSenderSession: () => mockSender([]),
    }
    await runRecovery({ a2aQueueStore: store, sessionManager: sm, logger: null })
    assert(enqueueCount === 1, 'SR3b: 첫 recovery 1 회 enqueue')
    assert(store.getMessage(req.id).status === TODO_STATUS.PROCESSING, 'SR3b: 첫 recovery 후 processing')
    // 두 번째 recovery — pending 에 안 잡히고 (status=processing), processing 분기로 들어가 markFailed('server-restart')
    await runRecovery({ a2aQueueStore: store, sessionManager: sm, logger: null })
    assert(enqueueCount === 1, 'SR3b: 두 번째 recovery 는 receiver 측 추가 enqueue 없음 (pending 분기 미진입)')
    // 단 두 번째 recovery 가 processing 분기를 실행 → markFailed('server-restart')
    assert(store.getMessage(req.id).status === TODO_STATUS.FAILED, 'SR3b: 두 번째 recovery 후 failed (processing 분기)')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // SR4: pending row + receiver 부재 → markFailed('server-restart-target-missing') + sender response 발행
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const req = store.enqueueRequest({ fromAgentId: AGENT_SENDER, toAgentId: AGENT_RECEIVER, payload: 'q' })
    const senderEvents = []
    const sm = {
      findAgentSession: () => ({ kind: 'not-registered', entry: null }),
      findSenderSession: () => mockSender(senderEvents),
    }
    await runRecovery({ a2aQueueStore: store, sessionManager: sm, logger: null })
    assert(store.getMessage(req.id).status === TODO_STATUS.FAILED, 'SR4: row.status=failed')
    assert(store.getMessage(req.id).error === 'server-restart-target-missing', 'SR4: row.error=server-restart-target-missing')
    assert(senderEvents.length === 1, 'SR4: sender 1 회 enqueue')
    assert(senderEvents[0].error === 'server-restart-target-missing', 'SR4: event.error 전파')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // SR5: 빈 db 에서 recovery 호출 시 no-op
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const sm = {
      findAgentSession: () => ({ kind: 'not-registered', entry: null }),
      findSenderSession: () => ({ kind: 'not-registered', entry: null }),
    }
    await runRecovery({ a2aQueueStore: store, sessionManager: sm, logger: null })
    assert(store.listByStatus('failed').length === 0, 'SR5: 빈 db no-op')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // SR6: 동시 mixed (processing 1 + pending 2) → 모두 정확 처리
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const procReq = store.enqueueRequest({ fromAgentId: AGENT_SENDER, toAgentId: AGENT_RECEIVER, payload: 'p1' })
    store.markProcessing(procReq.id)
    const pendOk = store.enqueueRequest({ fromAgentId: AGENT_SENDER, toAgentId: AGENT_RECEIVER, payload: 'p2' })
    const AGENT_OTHER = 'alice/missing'
    const pendMissing = store.enqueueRequest({ fromAgentId: AGENT_SENDER, toAgentId: AGENT_OTHER, payload: 'p3' })
    const senderEvents = []
    const fakeReceiver = {
      enqueue: () => ({ fork: (_r, resolve) => resolve('ok') }),
    }
    const sm = {
      findAgentSession: (agentId) => agentId === AGENT_RECEIVER
        ? { kind: 'ok', entry: { type: 'agent', session: { agentId: AGENT_RECEIVER, actors: { eventActor: fakeReceiver } } } }
        : { kind: 'not-registered', entry: null },
      findSenderSession: () => mockSender(senderEvents),
    }
    await runRecovery({ a2aQueueStore: store, sessionManager: sm, logger: null })
    assert(store.getMessage(procReq.id).status === TODO_STATUS.FAILED, 'SR6: processing → failed')
    assert(store.getMessage(procReq.id).error === 'server-restart', 'SR6: processing error=server-restart')
    assert(store.getMessage(pendOk.id).status === TODO_STATUS.PENDING, 'SR6: pending+receiver-ok → pending 유지 (재진입)')
    assert(store.getMessage(pendMissing.id).status === TODO_STATUS.FAILED, 'SR6: pending+missing → failed')
    assert(store.getMessage(pendMissing.id).error === 'server-restart-target-missing', 'SR6: missing error 코드')
    // sender response 는 processing 1 + pending-missing 1 = 2 회 발행
    assert(senderEvents.length === 2, 'SR6: sender response 2 회 (processing + missing)')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  summary()
}

run().catch(err => { console.error(err); process.exit(1) })
