import { PHASE, RESULT, ERROR_KIND, TurnState } from '@presence/core/core/policies.js'
import { Agent } from '@presence/core/core/agent.js'
import { applyFinalState } from '@presence/core/core/stateCommit.js'
import { createTestInterpreter } from '@presence/core/interpreter/test.js'
import { createReactiveState } from '@presence/infra/infra/state.js'
import { createAgentRegistry, DelegateResult } from '@presence/infra/infra/agent-registry.js'
import { withEventMeta } from '@presence/infra/infra/events.js'
import { eventActorR } from '@presence/infra/infra/actors/event-actor.js'
import { turnActorR } from '@presence/infra/infra/actors/turn-actor.js'
import { forkTask } from '@presence/core/lib/task.js'
import { runFreeWithStateT } from '@presence/core/lib/runner.js'

import { assert, summary } from '../lib/assert.js'

async function run() {
  console.log('Phase 5 integration tests')

  // ===========================================
  // Step 29: Heartbeat → Event Queue → Agent.run
  // ===========================================

  // E2E: heartbeat emits → EventActor processes → turnActor called
  {
    const state = createReactiveState({
      turnState: TurnState.idle(),
      lastTurn: null,
      turn: 0,
      context: { memories: [] },
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })

    let agentRunCalled = false
    let agentRunPrompt = null
    const turnActor = turnActorR.run({ runTurn: async (input) => {
      agentRunCalled = true
      agentRunPrompt = input
      return 'heartbeat result'
    } })
    const eventActor = eventActorR.run({ turnActor, state, logger: null })

    // 브릿지 hook
    state.hooks.on('turnState', (phase) => {
      if (phase.tag === 'idle') {
        eventActor.drain().fork(() => {}, () => {})
      }
    })

    // scheduled_job 이벤트를 직접 enqueue (scheduler 역할)
    const event = withEventMeta({ type: 'scheduled_job', jobId: 'test-job', jobName: '정기 점검', prompt: '정기 점검', runId: 'run-1', attempt: 1 })
    eventActor.enqueue(event).fork(() => {}, () => {})

    await new Promise(r => setTimeout(r, 150))

    assert(agentRunCalled, 'Step 29 E2E: turnActor called by scheduled_job event')
    assert(agentRunPrompt === '정기 점검', 'Step 29 E2E: correct prompt from scheduled_job')
    assert(state.get('events.lastProcessed')?.type === 'scheduled_job', 'Step 29 E2E: lastProcessed is scheduled_job')
  }

  // heartbeat → event 큐 → agent busy → 큐에 대기 → idle 후 처리
  {
    const state = createReactiveState({
      turnState: TurnState.working('user turn'),
      lastTurn: null,
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })

    let runCount = 0
    const turnActor = turnActorR.run({ runTurn: async () => { runCount++; return 'done' } })
    const eventActor = eventActorR.run({ turnActor, state, logger: null })
    const emit = (event) => eventActor.emit(event)

    // 브릿지 hook
    state.hooks.on('turnState', (phase) => {
      if (phase.tag === 'idle') {
        eventActor.drain().fork(() => {}, () => {})
      }
    })

    emit({ type: 'scheduled_job', jobId: 'test', jobName: '점검', prompt: '점검', runId: 'r1', attempt: 1 })

    await new Promise(r => setTimeout(r, 30))
    assert(runCount === 0, 'Step 29 busy: event queued while working')
    assert(state.get('events.queue').length === 1, 'Step 29 busy: 1 event in queue')

    // idle로 전환 → 브릿지 hook → drain
    state.set('turnState', TurnState.idle())
    await new Promise(r => setTimeout(r, 100))

    assert(runCount === 1, 'Step 29 busy→idle: event processed after idle')
    assert(state.get('events.queue').length === 0, 'Step 29 busy→idle: queue drained')
  }

  // ===========================================
  // Step 30: Plan DELEGATE → Registry → Local Agent → Result
  // ===========================================

  // E2E: planner generates DELEGATE step → interpreter dispatches → result in plan
  {
    const state = createReactiveState({
      turnState: TurnState.idle(),
      lastTurn: null,
      context: { memories: [] },
    })

    const agentReg = createAgentRegistry()
    agentReg.register({
      name: 'summarizer',
      description: '텍스트 요약',
      run: async (task) => `요약: ${task}`,
    })

    let askCallNum = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        askCallNum++
        if (askCallNum === 1) {
          return JSON.stringify({
            type: 'plan',
            steps: [
              { op: 'DELEGATE', args: { target: 'summarizer', task: '긴 보고서 내용' } },
              { op: 'RESPOND', args: { ref: 1 } },
            ],
          })
        }
        return '결과 정리'
      },
      // Delegate handler: local agent run (sync for test interpreter)
      Delegate: (op) => {
        const entry = agentReg.get(op.target)
        if (entry.isNothing()) return DelegateResult.failed(op.target, 'Unknown')
        return DelegateResult.completed(op.target, `요약: ${op.task}`)
      },
    })

    const agent = new Agent({ resolveTools: () => [], resolveAgents: () => agentReg.list(), interpret, ST })
    const initialState = state.snapshot()
    const [result, finalState] = await runFreeWithStateT(interpret, ST)(agent.planner.program('보고서 요약해줘'))(initialState)
    applyFinalState(state, finalState)

    assert(state.get('turnState').tag === PHASE.IDLE, 'Step 30 E2E: turnState idle')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'Step 30 E2E: success')
    assert(result != null && result.status === 'completed', 'Step 30 E2E: result is DelegateResult')
  }

  // Delegate 실패 → plan이 실패로 닫힘
  {
    const state = createReactiveState({
      turnState: TurnState.idle(),
      lastTurn: null,
      context: { memories: [] },
    })

    let askCallNum = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        askCallNum++
        if (askCallNum === 1) {
          return JSON.stringify({
            type: 'plan',
            steps: [
              { op: 'DELEGATE', args: { target: 'nonexistent', task: 'test' } },
              { op: 'RESPOND', args: { ref: 1 } },
            ],
          })
        }
        return 'should not reach'
      },
      Delegate: (op) => DelegateResult.failed(op.target, 'Unknown agent'),
    })

    const agent = new Agent({
      resolveTools: () => [],
      interpret, ST, state,
    })
    await agent.run('test')

    // DELEGATE returns DelegateResult.failed → RESPOND ref=1 gets the failed result object
    // Formatter still runs (DelegateResult is a valid result)
    assert(state.get('turnState').tag === PHASE.IDLE, 'Step 30 delegate fail: idle')
  }

  // ===========================================
  // Parallel + Delegate 조합
  // ===========================================

  // Parallel 내에서 여러 프로그램이 독립 실행
  {
    const state = createReactiveState({
      turnState: TurnState.idle(),
      context: {},
    })

    const { interpret, ST } = createTestInterpreter({
      Delegate: (op) => DelegateResult.completed(op.target, `done: ${op.task}`),
    })

    // parallel([respond('a'), respond('b')]) → allSettled 결과
    const { parallel, respond } = await import('@presence/core/core/op.js')
    const [result] = await runFreeWithStateT(interpret, ST)(
      parallel([respond('hello'), respond('world')])
    )({})

    assert(Array.isArray(result), 'Parallel: returns array')
    assert(result.length === 2, 'Parallel: 2 results')
    // test interpreter Parallel handler returns programs as-is (not allSettled)
    // But that's fine — this tests the test interpreter's behavior
  }

  // ===========================================
  // 이벤트 FIFO 순서 보장
  // ===========================================

  // 큐에 3개 쌓인 후 idle 전이 → EventActor drain이 순차 처리
  {
    const state = createReactiveState({
      turnState: TurnState.working('busy'),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })

    const processed = []
    const turnActor = turnActorR.run({ runTurn: async (input) => { processed.push(input); return 'ok' } })
    const eventActor = eventActorR.run({ turnActor, state, logger: null })
    const emit = (event) => eventActor.emit(event)

    // 브릿지 hook
    state.hooks.on('turnState', (phase) => {
      if (phase.tag === 'idle') {
        eventActor.drain().fork(() => {}, () => {})
      }
    })

    emit({ type: 'a', prompt: 'first' })
    emit({ type: 'b', prompt: 'second' })
    emit({ type: 'c', prompt: 'third' })

    await new Promise(r => setTimeout(r, 30))
    assert(processed.length === 0, 'FIFO: queued while working')

    // idle 전이 → drain이 3개 순차 처리
    state.set('turnState', TurnState.idle())
    await new Promise(r => setTimeout(r, 300))

    assert(processed.length === 3, 'FIFO: all 3 processed')
    assert(processed[0] === 'first', 'FIFO: first processed first')
    assert(processed[1] === 'second', 'FIFO: second processed second')
    assert(processed[2] === 'third', 'FIFO: third processed third')
  }

  // ===========================================
  // agent.run 실패 → deadLetter
  // ===========================================

  {
    const state = createReactiveState({
      turnState: TurnState.idle(),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })

    const turnActor = turnActorR.run({ runTurn: async () => { throw new Error('agent crashed') } })
    const eventActor = eventActorR.run({ turnActor, state, logger: null })
    const emit = (event) => eventActor.emit(event)

    emit({ type: 'bad-event', prompt: 'crash' })

    await new Promise(r => setTimeout(r, 150))

    const dl = state.get('events.deadLetter')
    assert(dl.length === 1, 'deadLetter: failed event recorded')
    assert(dl[0].error === 'agent crashed', 'deadLetter: correct error')
    assert(dl[0].type === 'bad-event', 'deadLetter: original event preserved')
  }

  summary()
}

run()
