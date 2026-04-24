import fp from '@presence/core/lib/fun-fp.js'
import { EVENT_TYPE } from '@presence/core/core/policies.js'
import { eventActorR } from '@presence/infra/infra/actors/event-actor.js'
import { turnActorR } from '@presence/infra/infra/actors/turn-actor.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { createA2aQueueStore } from '@presence/infra/infra/a2a/a2a-queue-store.js'
import { withEventMeta } from '@presence/infra/infra/events.js'
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

  summary()
}

run().catch(err => { console.error(err); process.exit(1) })
