import fp from '@presence/core/lib/fun-fp.js'
import { EVENT_TYPE, STATE_PATH, HISTORY_ENTRY_TYPE } from '@presence/core/core/policies.js'
import { eventActorR } from '@presence/infra/infra/actors/event-actor.js'
import { turnActorR } from '@presence/infra/infra/actors/turn-actor.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { createA2aQueueStore, TODO_STATUS } from '@presence/infra/infra/a2a/a2a-queue-store.js'
import { dispatchResponse } from '@presence/infra/infra/a2a/a2a-response-dispatcher.js'
import { withEventMeta } from '@presence/infra/infra/events.js'
import { TurnLifecycle } from '@presence/core/core/turn-lifecycle.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { TurnState } from '@presence/core/core/policies.js'
import { assert, summary } from '../../../test/lib/assert.js'

const { Task } = fp

const delay = (ms) => new Promise(r => setTimeout(r, ms))

const makeTmpDir = () => {
  const dir = join(tmpdir(), `presence-a2a-integ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

// EventActor + SessionActors.handleEventDone 의 TODO_REQUEST 분기를 통합 검증.
// 실제 session 을 띄우는 대신 receiver 쪽 eventActor 만 a2aQueueStore 연동으로 구성.
const setupReceiver = ({ a2aQueueStore, turnFn, onEventDone }) => {
  const state = createOriginState({
    turnState: TurnState.idle(),
    context: { conversationHistory: [], memories: [], recentToolResults: [], budgetWarning: null },
    events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    todos: [],
  })
  const turnActor = turnActorR.run({ runTurn: turnFn })
  const eventActor = eventActorR.run({
    turnActor, state, logger: null, userDataStore: null, a2aQueueStore, onEventDone,
  })
  return { state, eventActor }
}

const run = async () => {
  console.log('A2A integration tests')

  // AI1. 정상 경로 — pending → processing → completed, turn 호출 1회
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const msg = store.enqueueRequest({ fromAgentId: 'alice/planner', toAgentId: 'alice/worker', payload: '조사' })

    let turnCalled = 0
    let turnPrompt = null
    const turnFn = async (prompt) => { turnCalled++; turnPrompt = prompt; return 'done' }

    // SessionActors.handleEventDone 분기를 인라인으로 재현:
    const { eventActor } = setupReceiver({
      a2aQueueStore: store,
      turnFn,
      onEventDone: (event, { success, error }) => {
        if (event.type !== EVENT_TYPE.TODO_REQUEST) return
        if (success) store.markCompleted(event.requestId)
        else store.markFailed(event.requestId, String(error ?? 'agent-error'))
      },
    })

    const event = withEventMeta({
      id: msg.id, type: EVENT_TYPE.TODO_REQUEST, prompt: '조사',
      fromAgentId: 'alice/planner', toAgentId: 'alice/worker', requestId: msg.id,
    })
    await new Promise((resolve) => { eventActor.enqueue(event).fork(() => {}, resolve) })
    await delay(100)

    assert(turnCalled === 1, 'AI1: turn 1회 호출')
    assert(turnPrompt === '조사', 'AI1: prompt forwarded')
    const final = store.getMessage(msg.id)
    assert(final.status === 'completed', 'AI1: row completed')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // AI2. turn 실패 — pending → processing → failed, error 기록
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const msg = store.enqueueRequest({ fromAgentId: 'alice/planner', toAgentId: 'alice/worker', payload: 'x' })

    const turnFn = async () => { throw new Error('agent-failure') }
    const { eventActor } = setupReceiver({
      a2aQueueStore: store,
      turnFn,
      onEventDone: (event, { success, error }) => {
        if (event.type !== EVENT_TYPE.TODO_REQUEST) return
        if (success) store.markCompleted(event.requestId)
        else store.markFailed(event.requestId, String(error ?? 'agent-error'))
      },
    })

    const event = withEventMeta({
      id: msg.id, type: EVENT_TYPE.TODO_REQUEST, prompt: 'x',
      fromAgentId: 'alice/planner', toAgentId: 'alice/worker', requestId: msg.id,
    })
    await new Promise((resolve) => { eventActor.enqueue(event).fork(() => {}, resolve) })
    await delay(100)

    const final = store.getMessage(msg.id)
    assert(final.status === 'failed', 'AI2: row failed')
    assert(final.error && final.error.includes('agent-failure'), 'AI2: error 문자열 보존')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // AI3. 중복 event drain — markProcessing=false → skip, turn 1회만 실행
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const msg = store.enqueueRequest({ fromAgentId: 'alice/planner', toAgentId: 'alice/worker', payload: 'x' })
    // 이미 processing 상태로 강제 전이 — 두 번째 drain 이 중복으로 간주됨
    store.markProcessing(msg.id)

    let turnCalled = 0
    const turnFn = async () => { turnCalled++; return 'done' }
    const { eventActor } = setupReceiver({
      a2aQueueStore: store,
      turnFn,
      onEventDone: () => {},
    })

    const event = withEventMeta({
      id: msg.id, type: EVENT_TYPE.TODO_REQUEST, prompt: 'x',
      fromAgentId: 'alice/planner', toAgentId: 'alice/worker', requestId: msg.id,
    })
    await new Promise((resolve) => { eventActor.enqueue(event).fork(() => {}, resolve) })
    await delay(100)

    assert(turnCalled === 0, 'AI3: 중복 event → turn 미호출 (skip)')
    const final = store.getMessage(msg.id)
    assert(final.status === 'processing', 'AI3: 상태 변화 없음 (기존 processing 유지)')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // --- S2: AI4~AI6 + EA1~EA3 ---

  // sender-side eventActor + turnLifecycle 설정 helper (S2)
  const setupSender = ({ turnLifecycle } = {}) => {
    const state = createOriginState({
      turnState: TurnState.idle(),
      context: { conversationHistory: [], memories: [], recentToolResults: [], budgetWarning: null },
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })
    const turnActor = turnActorR.run({ runTurn: async () => 'unused' })
    const eventActor = eventActorR.run({
      turnActor, state, logger: null, userDataStore: null,
      turnLifecycle: turnLifecycle ?? new TurnLifecycle(),
    })
    return { state, eventActor }
  }

  const AGENT_SENDER = 'alice/planner'
  const AGENT_RECEIVER = 'alice/worker'

  // AI4. 정상 경로 — receiver turn 완료 → sender 에게 SYSTEM entry + response row 'completed'
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const request = store.enqueueRequest({ fromAgentId: AGENT_SENDER, toAgentId: AGENT_RECEIVER, payload: '조사' })
    store.markProcessing(request.id)

    const sender = setupSender()
    const sessionManager = {
      findSenderSession: () => ({
        kind: 'ok',
        entry: { type: 'agent', session: { agentId: AGENT_SENDER, actors: { eventActor: sender.eventActor } } },
      }),
    }

    // receiver completion 시뮬레이션 (handleEventDone 대신 직접 markCompleted + dispatchResponse)
    store.markCompleted(request.id)
    const result = await dispatchResponse({
      a2aQueueStore: store, sessionManager, logger: null,
      request, status: 'completed', payload: '조사 완료',
    })
    assert(result.enqueued === true, 'AI4: response enqueue 성공')

    // sender event drain 기다림
    await delay(150)

    const history = sender.state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY) || []
    const systemEntry = history.find(e => e.type === HISTORY_ENTRY_TYPE.SYSTEM && e.tag === 'a2a-response')
    assert(systemEntry !== undefined, 'AI4: sender conversationHistory 에 SYSTEM entry 추가')
    assert(String(systemEntry.content).includes('조사 완료'), 'AI4: payload 가 content 에 포함')
    const respRow = store.getMessage(result.responseId)
    assert(respRow.status === TODO_STATUS.COMPLETED, 'AI4: response row status=completed')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // AI5. expire clock 시뮬레이션 — pending > timeout → expired + sender SYSTEM entry
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const request = store.enqueueRequest({ fromAgentId: AGENT_SENDER, toAgentId: AGENT_RECEIVER, payload: 'q' })
    // markExpired 직접 호출 (실제 UserContext tick 의 효과 시뮬)
    assert(store.markExpired(request.id) === true, 'AI5: markExpired true')

    const sender = setupSender()
    const sessionManager = {
      findSenderSession: () => ({
        kind: 'ok',
        entry: { type: 'agent', session: { agentId: AGENT_SENDER, actors: { eventActor: sender.eventActor } } },
      }),
    }
    const result = await dispatchResponse({
      a2aQueueStore: store, sessionManager, logger: null,
      request, status: 'expired', payload: null, error: 'timeout',
    })
    assert(result.enqueued === true, 'AI5: expired response enqueue 성공')

    await delay(150)
    const history = sender.state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY) || []
    const systemEntry = history.find(e => e.type === HISTORY_ENTRY_TYPE.SYSTEM && e.tag === 'a2a-response')
    assert(systemEntry !== undefined, 'AI5: sender 에 expired SYSTEM entry')
    assert(String(systemEntry.content).includes('타임아웃'), 'AI5: 타임아웃 문구')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // AI6. sender 부재 → response 'orphaned' + event 미발행
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const request = store.enqueueRequest({ fromAgentId: AGENT_SENDER, toAgentId: AGENT_RECEIVER, payload: 'q' })
    store.markProcessing(request.id)
    store.markCompleted(request.id)

    const sessionManager = {
      findSenderSession: () => ({ kind: 'not-registered', entry: null }),
    }
    const result = await dispatchResponse({
      a2aQueueStore: store, sessionManager, logger: null,
      request, status: 'completed', payload: '결과',
    })
    assert(result.enqueued === false, 'AI6: sender 없음 → enqueued=false')
    assert(result.reason === 'not-registered', 'AI6: reason=not-registered')
    const respRow = store.getMessage(result.responseId)
    assert(respRow.status === TODO_STATUS.ORPHANED, 'AI6: response row status=orphaned')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // EA1. todo_response drain → turn 미호출 + SYSTEM entry 추가
  {
    const sender = setupSender()
    let turnCalled = 0
    // turnActor 내부를 계측하는 대신, TurnLifecycle 의 SYSTEM entry 추가 여부 + queue 비움을 확인
    const event = withEventMeta({
      id: 'r-1', type: EVENT_TYPE.TODO_RESPONSE,
      correlationId: 'req-1', fromAgentId: AGENT_RECEIVER, toAgentId: AGENT_SENDER,
      status: 'completed', payload: 'done',
    })
    await new Promise(resolve => sender.eventActor.enqueue(event).fork(() => {}, resolve))
    await delay(100)

    const history = sender.state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY) || []
    assert(history.length === 1, 'EA1: SYSTEM entry 1개 추가')
    assert(history[0].type === HISTORY_ENTRY_TYPE.SYSTEM && history[0].tag === 'a2a-response', 'EA1: 태그 정확')
    assert(String(history[0].content).includes('done'), 'EA1: content 에 payload 포함')
  }

  // EA2. drain 후 queue 정상 배수 — 두 번째 이벤트도 처리
  {
    const sender = setupSender()
    const makeEvent = (id, payload) => withEventMeta({
      id, type: EVENT_TYPE.TODO_RESPONSE,
      correlationId: `req-${id}`, fromAgentId: AGENT_RECEIVER, toAgentId: AGENT_SENDER,
      status: 'completed', payload,
    })
    await new Promise(resolve => sender.eventActor.enqueue(makeEvent('e1', 'first')).fork(() => {}, resolve))
    await new Promise(resolve => sender.eventActor.enqueue(makeEvent('e2', 'second')).fork(() => {}, resolve))
    await delay(200)

    const history = sender.state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY) || []
    assert(history.length === 2, 'EA2: 두 이벤트 모두 drain (queue 정상 배수)')
    const contents = history.map(h => String(h.content))
    assert(contents.some(c => c.includes('first')), 'EA2: first payload 반영')
    assert(contents.some(c => c.includes('second')), 'EA2: second payload 반영')
  }

  // EA3. turnLifecycle 미주입 + todo_response → warn 로그 + drain 계속 (fallback)
  {
    const state = createOriginState({
      turnState: TurnState.idle(),
      context: { conversationHistory: [], memories: [], recentToolResults: [], budgetWarning: null },
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })
    const warns = []
    const logger = { warn: (msg) => warns.push(msg), info: () => {}, error: () => {} }
    const turnActor = turnActorR.run({ runTurn: async () => 'unused' })
    // turnLifecycle 미주입
    const eventActor = eventActorR.run({ turnActor, state, logger, userDataStore: null })

    const event = withEventMeta({
      id: 'r-no-lifecycle', type: EVENT_TYPE.TODO_RESPONSE,
      correlationId: 'req-x', fromAgentId: AGENT_RECEIVER, toAgentId: AGENT_SENDER,
      status: 'completed', payload: 'x',
    })
    await new Promise(resolve => eventActor.enqueue(event).fork(() => {}, resolve))
    await delay(100)

    assert(warns.some(w => /turnLifecycle missing/i.test(w)), 'EA3: turnLifecycle missing warn 로그')
    const history = state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY) || []
    assert(history.length === 0, 'EA3: SYSTEM entry 추가 안 됨 (fallback)')
    const queue = state.get(STATE_PATH.EVENTS_QUEUE) || []
    assert(queue.length === 0, 'EA3: queue 비움 (drain 진행)')
  }

  summary()
}

run().catch(err => { console.error(err); process.exit(1) })
