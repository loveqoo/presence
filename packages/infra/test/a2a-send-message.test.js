import fp from '@presence/core/lib/fun-fp.js'
import { runFreeWithStateT } from '@presence/core/lib/runner.js'
import { Interpreter } from '@presence/core/interpreter/compose.js'
import { sendA2aMessageR, SendA2aMessage } from '@presence/core/core/op.js'
import { sendA2aInterpreterR, SEND_A2A_ERROR } from '@presence/infra/interpreter/send-a2a-message.js'
import { assert, summary } from '../../../test/lib/assert.js'

const { Task, StateT, Maybe } = fp
const ST = StateT(Task)

const AGENT_A = 'alice/planner'
const AGENT_B = 'alice/worker'
const AGENT_OTHER_USER = 'bob/worker'

// --- mock helpers ---

const mockAgentRegistry = (entries) => ({
  get: (agentId) => {
    const hit = entries[agentId]
    if (hit === undefined) return Maybe.Nothing()
    return Maybe.Just(hit)
  },
})

const mockSessionManager = (routingMap) => ({
  findAgentSession: (agentId) => routingMap[agentId] ?? { kind: 'not-registered', entry: null },
})

const mockQueueStore = () => {
  const rows = new Map()
  let seq = 0
  return {
    rows,
    enqueueRequest: (opts) => {
      const id = `msg-${++seq}`
      const msg = { id, status: 'pending', ...opts }
      rows.set(id, msg)
      return msg
    },
    enqueueRequestBounded: (opts, maxPending) => {
      const id = `msg-${++seq}`
      let cnt = 0
      for (const r of rows.values()) {
        if (r.toAgentId === opts.toAgentId && r.status === 'pending' && (r.kind ?? 'request') === 'request') cnt++
      }
      if (cnt >= maxPending) {
        const failed = { id, status: 'failed', error: 'queue-full', ...opts }
        rows.set(id, failed); return failed
      }
      const msg = { id, status: 'pending', ...opts }
      rows.set(id, msg); return msg
    },
    markFailed: (id, error) => {
      const row = rows.get(id); if (!row) return false
      row.status = 'failed'; row.error = error; return true
    },
    markProcessing: (id) => { const row = rows.get(id); if (!row || row.status !== 'pending') return false; row.status = 'processing'; return true },
    markCompleted: (id) => { const row = rows.get(id); if (!row || row.status !== 'processing') return false; row.status = 'completed'; return true },
    getMessage: (id) => rows.get(id) ?? null,
  }
}

const mockEventActor = (onEnqueue = () => {}) => ({
  enqueue: (event) => ({
    fork: (_reject, resolve) => { onEnqueue(event); resolve('ok') },
  }),
})

const mockSessionEntry = (agentId, eventActor) => ({
  entry: {
    type: 'agent',
    session: { agentId, actors: { eventActor } },
  },
  kind: 'ok',
})

// 인터프리터 돌림 헬퍼
const runSendA2aMessage = async ({ to, payload, timeoutMs, env }) => {
  const program = sendA2aMessageR.run({ to, payload, timeoutMs })
  const interpreter = sendA2aInterpreterR.run({ ST, ...env })
  const composed = Interpreter.compose(ST, interpreter)
  const [result] = await runFreeWithStateT(composed, ST)(program)({})
  return result
}

const run = async () => {
  console.log('SendA2aMessage interpreter tests')

  // ST1. 정상 경로 — enqueueRequest + eventActor.enqueue 호출, accepted=true
  {
    const store = mockQueueStore()
    const enqueued = []
    const receiverActor = mockEventActor(e => enqueued.push(e))
    const session = mockSessionEntry(AGENT_B, receiverActor)
    const result = await runSendA2aMessage({
      to: AGENT_B, payload: 'hello',
      env: {
        a2aQueueStore: store,
        agentRegistry: mockAgentRegistry({ [AGENT_B]: { archived: false } }),
        sessionManager: mockSessionManager({ [AGENT_B]: session }),
        currentAgentId: AGENT_A,
      },
    })
    assert(result.accepted === true, 'ST1: accepted=true')
    assert(typeof result.requestId === 'string', 'ST1: requestId 발급')
    assert(store.rows.size === 1, 'ST1: queue row 1개')
    assert(enqueued.length === 1 && enqueued[0].type === 'a2a_request', 'ST1: receiver eventActor enqueue 호출')
    assert(enqueued[0].requestId === result.requestId, 'ST1: requestId 전달')
  }

  // ST2. 크로스 유저 거부 — queue 무변, requestId=null
  {
    const store = mockQueueStore()
    const result = await runSendA2aMessage({
      to: AGENT_OTHER_USER, payload: 'x',
      env: {
        a2aQueueStore: store,
        agentRegistry: mockAgentRegistry({}),
        sessionManager: mockSessionManager({}),
        currentAgentId: AGENT_A,
      },
    })
    assert(result.accepted === false, 'ST2: accepted=false')
    assert(result.error === SEND_A2A_ERROR.OWNERSHIP_DENIED, 'ST2: ownership-denied')
    assert(result.requestId === null, 'ST2: requestId=null')
    assert(store.rows.size === 0, 'ST2: queue 무변')
  }

  // ST3. dual-homed default — AGENT session 으로 라우팅 (UserSession 영향 없음)
  {
    const store = mockQueueStore()
    const enqueued = []
    const agentActor = mockEventActor(e => enqueued.push(e))
    const defaultId = 'alice/default'
    // AGENT session 만 라우팅 결과에 포함 (findAgentSession 이 이미 type=AGENT 필터)
    const agentSession = mockSessionEntry(defaultId, agentActor)
    const result = await runSendA2aMessage({
      to: defaultId, payload: 'assignment',
      env: {
        a2aQueueStore: store,
        agentRegistry: mockAgentRegistry({ [defaultId]: { archived: false } }),
        sessionManager: mockSessionManager({ [defaultId]: agentSession }),
        currentAgentId: AGENT_A,
      },
    })
    assert(result.accepted === true, 'ST3: dual-homed default → accepted')
    assert(enqueued.length === 1, 'ST3: AGENT session 에만 enqueue')
  }

  // ST4. not-registered — findAgentSession 0 매치
  {
    const store = mockQueueStore()
    const result = await runSendA2aMessage({
      to: 'alice/ghost', payload: 'x',
      env: {
        a2aQueueStore: store,
        agentRegistry: mockAgentRegistry({}),
        sessionManager: mockSessionManager({}),
        currentAgentId: AGENT_A,
      },
    })
    assert(result.accepted === false, 'ST4: rejected')
    assert(result.error === SEND_A2A_ERROR.NOT_REGISTERED, 'ST4: not-registered')
    assert(store.rows.size === 0, 'ST4: queue 무변')
  }

  // ST5. archived → queue 에 fail row 남김 (audit)
  {
    const store = mockQueueStore()
    const session = mockSessionEntry(AGENT_B, mockEventActor())
    const result = await runSendA2aMessage({
      to: AGENT_B, payload: 'x',
      env: {
        a2aQueueStore: store,
        agentRegistry: mockAgentRegistry({ [AGENT_B]: { archived: true } }),
        sessionManager: mockSessionManager({ [AGENT_B]: session }),
        currentAgentId: AGENT_A,
      },
    })
    assert(result.accepted === false, 'ST5: rejected')
    assert(result.error === SEND_A2A_ERROR.ARCHIVED, 'ST5: target-archived')
    assert(typeof result.requestId === 'string', 'ST5: requestId 발급 (audit)')
    const row = store.getMessage(result.requestId)
    assert(row.status === 'failed', 'ST5: row.status=failed')
    assert(row.error === SEND_A2A_ERROR.ARCHIVED, 'ST5: row.error audit')
  }

  // ST6. ambiguous — 2 AGENT session 매치 (방어)
  {
    const store = mockQueueStore()
    const result = await runSendA2aMessage({
      to: AGENT_B, payload: 'x',
      env: {
        a2aQueueStore: store,
        agentRegistry: mockAgentRegistry({ [AGENT_B]: { archived: false } }),
        sessionManager: mockSessionManager({ [AGENT_B]: { kind: 'ambiguous', entry: null } }),
        currentAgentId: AGENT_A,
      },
    })
    assert(result.accepted === false, 'ST6: rejected')
    assert(result.error === SEND_A2A_ERROR.SESSION_AMBIGUOUS, 'ST6: session-routing-ambiguous')
    assert(store.rows.size === 0, 'ST6: queue 무변')
  }

  // ST7. enqueue 실패 — eventActor.enqueue task reject → queue row failed
  {
    const store = mockQueueStore()
    const failingActor = {
      enqueue: () => ({ fork: (reject) => reject(new Error('actor-down')) }),
    }
    const session = { kind: 'ok', entry: { type: 'agent', session: { agentId: AGENT_B, actors: { eventActor: failingActor } } } }
    const result = await runSendA2aMessage({
      to: AGENT_B, payload: 'x',
      env: {
        a2aQueueStore: store,
        agentRegistry: mockAgentRegistry({ [AGENT_B]: { archived: false } }),
        sessionManager: mockSessionManager({ [AGENT_B]: session }),
        currentAgentId: AGENT_A,
      },
    })
    assert(result.accepted === false, 'ST7: rejected')
    assert(result.error === SEND_A2A_ERROR.ENQUEUE_FAILED, 'ST7: queue-enqueue-failed')
    assert(typeof result.requestId === 'string', 'ST7: requestId 발급')
    const row = store.getMessage(result.requestId)
    assert(row.status === 'failed', 'ST7: row failed')
  }

  // ST8. qualified form 위반 — assertValidAgentId throw 잡아 invalid-agent-id
  {
    const store = mockQueueStore()
    const result = await runSendA2aMessage({
      to: 'not-a-qualified-id', payload: 'x',
      env: {
        a2aQueueStore: store,
        agentRegistry: mockAgentRegistry({}),
        sessionManager: mockSessionManager({}),
        currentAgentId: AGENT_A,
      },
    })
    assert(result.accepted === false, 'ST8: rejected')
    assert(result.error === SEND_A2A_ERROR.INVALID_AGENT_ID, 'ST8: invalid-agent-id')
    assert(store.rows.size === 0, 'ST8: queue 무변')
  }

  // ST9. receiver session 에 eventActor 없음 — target-session-not-found
  {
    const store = mockQueueStore()
    const session = { kind: 'ok', entry: { type: 'agent', session: { agentId: AGENT_B } } } // actors 없음
    const result = await runSendA2aMessage({
      to: AGENT_B, payload: 'x',
      env: {
        a2aQueueStore: store,
        agentRegistry: mockAgentRegistry({ [AGENT_B]: { archived: false } }),
        sessionManager: mockSessionManager({ [AGENT_B]: session }),
        currentAgentId: AGENT_A,
      },
    })
    assert(result.accepted === false, 'ST9: rejected')
    assert(result.error === SEND_A2A_ERROR.SESSION_NOT_FOUND, 'ST9: target-session-not-found')
    const row = store.getMessage(result.requestId)
    assert(row.status === 'failed', 'ST9: row failed (audit)')
  }

  // ST10. registry-missing — sessionManager.findAgentSession = ok 이지만 agentRegistry.get = Nothing
  //       (session/registry divergence 방어 — a2a-internal.md §4.2 숨은 불변식)
  {
    const store = mockQueueStore()
    const session = mockSessionEntry(AGENT_B, mockEventActor())
    const result = await runSendA2aMessage({
      to: AGENT_B, payload: 'x',
      env: {
        a2aQueueStore: store,
        agentRegistry: mockAgentRegistry({}), // registry 비어있음
        sessionManager: mockSessionManager({ [AGENT_B]: session }),
        currentAgentId: AGENT_A,
      },
    })
    assert(result.accepted === false, 'ST10: rejected')
    assert(result.error === SEND_A2A_ERROR.REGISTRY_MISSING, 'ST10: registry-missing')
    assert(result.requestId === null, 'ST10: requestId=null (row 생성 전)')
    assert(store.rows.size === 0, 'ST10: queue 무변')
  }

  // ST extra. a2aQueueStore 미주입 fallback — 인프라 미제공 환경 (test interpreter)
  {
    const result = await runSendA2aMessage({
      to: AGENT_B, payload: 'x',
      env: {
        a2aQueueStore: null,
        agentRegistry: mockAgentRegistry({}),
        sessionManager: null,
        currentAgentId: AGENT_A,
      },
    })
    assert(result.accepted === false, 'STx: a2a 미주입 → rejected')
    assert(result.error === SEND_A2A_ERROR.NOT_REGISTERED, 'STx: not-registered 로 통합')
  }

  // --- 큐 상한 enforcement (S4 §6.5) ---

  // ST-qf2: receiver 의 pending 상한 (A2A.QUEUE_MAX_PER_AGENT) 도달 시
  //   다음 SendA2aMessage → accepted=false, error='queue-full', requestId 발급, row.status='failed'
  {
    const store = mockQueueStore()
    const enqueued = []
    const receiverActor = mockEventActor(e => enqueued.push(e))
    const session = mockSessionEntry(AGENT_B, receiverActor)
    const env = {
      a2aQueueStore: store,
      agentRegistry: mockAgentRegistry({ [AGENT_B]: { agentId: AGENT_B, archived: false } }),
      sessionManager: mockSessionManager({ [AGENT_B]: session }),
      currentAgentId: AGENT_A,
    }
    // 100 회 정상 enqueue
    for (let i = 0; i < 100; i++) {
      const r = await runSendA2aMessage({ to: AGENT_B, payload: `p${i}`, env })
      assert(r.accepted === true, `ST-qf2: ${i} 정상`)
      // receiver 가 markProcessing 못하게 mock receiverActor 가 받기만 함 — pending 유지
    }
    // 101 번째는 거부
    const overflow = await runSendA2aMessage({ to: AGENT_B, payload: 'overflow', env })
    assert(overflow.accepted === false, 'ST-qf2: 101 번째 거부')
    assert(overflow.error === SEND_A2A_ERROR.QUEUE_FULL, 'ST-qf2: error=queue-full')
    assert(typeof overflow.requestId === 'string', 'ST-qf2: requestId 발급 (audit)')
    const overflowRow = store.getMessage(overflow.requestId)
    assert(overflowRow.status === 'failed', 'ST-qf2: row.status=failed')
    assert(overflowRow.error === 'queue-full', 'ST-qf2: row.error=queue-full')
    // receiver 의 eventActor 에 101 번째는 enqueue 안 됨
    assert(enqueued.length === 100, 'ST-qf2: receiver 측 enqueue 는 정확히 100 회')
  }

  // ST-qf3: 같은 receiver 99 + 다른 receiver 100 → 다른 receiver 영향 없음
  {
    const store = mockQueueStore()
    const enqueuedB = []
    const enqueuedC = []
    const sessionB = mockSessionEntry(AGENT_B, mockEventActor(e => enqueuedB.push(e)))
    const AGENT_C = 'alice/c'
    const sessionC = mockSessionEntry(AGENT_C, mockEventActor(e => enqueuedC.push(e)))
    const env = {
      a2aQueueStore: store,
      agentRegistry: mockAgentRegistry({
        [AGENT_B]: { agentId: AGENT_B, archived: false },
        [AGENT_C]: { agentId: AGENT_C, archived: false },
      }),
      sessionManager: mockSessionManager({ [AGENT_B]: sessionB, [AGENT_C]: sessionC }),
      currentAgentId: AGENT_A,
    }
    for (let i = 0; i < 99; i++) await runSendA2aMessage({ to: AGENT_B, payload: `b${i}`, env })
    for (let i = 0; i < 100; i++) {
      const r = await runSendA2aMessage({ to: AGENT_C, payload: `c${i}`, env })
      assert(r.accepted === true, `ST-qf3: AGENT_C ${i} 정상 (independent)`)
    }
    assert(enqueuedC.length === 100, 'ST-qf3: AGENT_C 100 건 모두 enqueue')
    // AGENT_B 는 99 → 다음도 정상 가능
    const r = await runSendA2aMessage({ to: AGENT_B, payload: 'b99', env })
    assert(r.accepted === true, 'ST-qf3: AGENT_B 100 번째도 정상 (한도 도달 직전)')
  }

  summary()
}

run().catch(err => { console.error(err); process.exit(1) })
