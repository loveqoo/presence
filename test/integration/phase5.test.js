import { createAgentTurn, createAgent, safeRunTurn, PHASE, RESULT, Phase, ErrorInfo, ERROR_KIND } from '../../src/core/agent.js'
import { createTestInterpreter } from '../../src/interpreter/test.js'
import { createReactiveState } from '../../src/infra/state.js'
import { createAgentRegistry, DelegateResult } from '../../src/infra/agent-registry.js'
import { createEventReceiver, wireEventHooks } from '../../src/infra/events.js'
import { createHeartbeat } from '../../src/infra/heartbeat.js'
import { Free } from '../../src/core/op.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

async function run() {
  console.log('Phase 5 integration tests')

  // ===========================================
  // Step 29: Heartbeat → Event Queue → Agent.run
  // ===========================================

  // E2E: heartbeat emits → event hook processes → agent.run called
  {
    const state = createReactiveState({
      turnState: Phase.idle(),
      lastTurn: null,
      turn: 0,
      context: { memories: [] },
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    })

    let agentRunCalled = false
    let agentRunPrompt = null
    const mockAgent = {
      run: async (input) => {
        agentRunCalled = true
        agentRunPrompt = input
        return 'heartbeat result'
      },
    }

    wireEventHooks({ state, agent: mockAgent })

    const { emit } = createEventReceiver(state)
    const heartbeat = createHeartbeat({
      emit,
      state,
      intervalMs: 20,
      prompt: '정기 점검',
    })

    heartbeat.start()
    await new Promise(r => setTimeout(r, 80))
    heartbeat.stop()

    assert(agentRunCalled, 'Step 29 E2E: agent.run called by heartbeat event')
    assert(agentRunPrompt === '정기 점검', 'Step 29 E2E: correct prompt from heartbeat')
    assert(state.get('events.lastProcessed')?.type === 'heartbeat', 'Step 29 E2E: lastProcessed is heartbeat')
  }

  // heartbeat → event 큐 → agent busy → 큐에 대기 → idle 후 처리
  {
    const state = createReactiveState({
      turnState: Phase.working('user turn'),
      lastTurn: null,
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    })

    let runCount = 0
    const mockAgent = { run: async () => { runCount++; return 'done' } }

    wireEventHooks({ state, agent: mockAgent })

    const { emit } = createEventReceiver(state)
    emit({ type: 'heartbeat', prompt: '점검' })

    await new Promise(r => setTimeout(r, 30))
    assert(runCount === 0, 'Step 29 busy: event queued while working')
    assert(state.get('events.queue').length === 1, 'Step 29 busy: 1 event in queue')

    // idle로 전환 → 큐 처리
    state.set('turnState', Phase.idle())
    await new Promise(r => setTimeout(r, 50))

    assert(runCount === 1, 'Step 29 busy→idle: event processed after idle')
    assert(state.get('events.queue').length === 0, 'Step 29 busy→idle: queue drained')
  }

  // ===========================================
  // Step 30: Plan DELEGATE → Registry → Local Agent → Result
  // ===========================================

  // E2E: planner generates DELEGATE step → interpreter dispatches → result in plan
  {
    const state = createReactiveState({
      turnState: Phase.idle(),
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
    const { interpreter } = createTestInterpreter({
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
      // Delegate handler: local agent run
      Delegate: (op) => {
        const entry = agentReg.get(op.target)
        if (entry.isNothing()) return DelegateResult.failed(op.target, 'Unknown')
        return entry.value.run(op.task).then(output =>
          DelegateResult.completed(op.target, output)
        )
      },
    }, state)

    const turn = createAgentTurn({ tools: [], agents: agentReg.list() })
    const result = await Free.runWithTask(interpreter)(turn('보고서 요약해줘'))

    assert(state.get('turnState').tag === PHASE.IDLE, 'Step 30 E2E: turnState idle')
    assert(state.get('lastTurn').tag === RESULT.SUCCESS, 'Step 30 E2E: success')
    assert(typeof result === 'string', 'Step 30 E2E: result is string')
  }

  // Delegate 실패 → plan이 실패로 닫힘
  {
    const state = createReactiveState({
      turnState: Phase.idle(),
      lastTurn: null,
      context: { memories: [] },
    })

    let askCallNum = 0
    const { interpreter } = createTestInterpreter({
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
    }, state)

    const agent = createAgent({
      buildTurn: createAgentTurn({ tools: [] }),
      interpreter, state,
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
      turnState: Phase.idle(),
      context: {},
    })

    const { interpreter } = createTestInterpreter({
      Delegate: (op) => DelegateResult.completed(op.target, `done: ${op.task}`),
    }, state)

    // parallel([respond('a'), respond('b')]) → allSettled 결과
    const { parallel, respond } = await import('../../src/core/op.js')
    const result = await Free.runWithTask(interpreter)(
      parallel([respond('hello'), respond('world')])
    )

    assert(Array.isArray(result), 'Parallel: returns array')
    assert(result.length === 2, 'Parallel: 2 results')
    // test interpreter Parallel handler returns programs as-is (not allSettled)
    // But that's fine — this tests the test interpreter's behavior
  }

  // ===========================================
  // 이벤트 FIFO 순서 보장
  // ===========================================

  // 큐에 3개 쌓인 후 idle 전이마다 하나씩 처리
  {
    const state = createReactiveState({
      turnState: Phase.working('busy'),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    })

    const processed = []
    const mockAgent = {
      run: async (input) => { processed.push(input); return 'ok' },
    }

    wireEventHooks({ state, agent: mockAgent })

    const { emit } = createEventReceiver(state)
    emit({ type: 'a', prompt: 'first' })
    emit({ type: 'b', prompt: 'second' })
    emit({ type: 'c', prompt: 'third' })

    assert(processed.length === 0, 'FIFO: queued while working')

    // idle 전이 → 첫 번째 처리
    state.set('turnState', Phase.idle())
    await new Promise(r => setTimeout(r, 30))
    assert(processed.length === 1, 'FIFO: 1st processed on idle')
    assert(processed[0] === 'first', 'FIFO: first processed first')

    // 다시 idle → 두 번째
    state.set('turnState', Phase.idle())
    await new Promise(r => setTimeout(r, 30))
    assert(processed.length === 2, 'FIFO: 2nd processed')
    assert(processed[1] === 'second', 'FIFO: second processed second')

    // 다시 idle → 세 번째
    state.set('turnState', Phase.idle())
    await new Promise(r => setTimeout(r, 30))
    assert(processed.length === 3, 'FIFO: 3rd processed')
    assert(processed[2] === 'third', 'FIFO: third processed third')
  }

  // ===========================================
  // agent.run 실패 → deadLetter
  // ===========================================

  {
    const state = createReactiveState({
      turnState: Phase.idle(),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    })

    const mockAgent = {
      run: async () => { throw new Error('agent crashed') },
    }

    wireEventHooks({ state, agent: mockAgent })

    const { emit } = createEventReceiver(state)
    emit({ type: 'bad-event', prompt: 'crash' })

    await new Promise(r => setTimeout(r, 50))

    const dl = state.get('events.deadLetter')
    assert(dl.length === 1, 'deadLetter: failed event recorded')
    assert(dl[0].error === 'agent crashed', 'deadLetter: correct error')
    assert(dl[0].type === 'bad-event', 'deadLetter: original event preserved')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
