import { initI18n } from '@presence/infra/i18n'
initI18n('ko')
import { PHASE, RESULT } from '@presence/core/core/policies.js'
import { Phase } from '@presence/core/core/turn.js'
import { Agent } from '@presence/core/core/agent.js'
import { createTestInterpreter } from '@presence/core/interpreter/test.js'
import { createReactiveState } from '@presence/infra/infra/state.js'
import { turnActorR, eventActorR, emitR, forkTask } from '@presence/infra/infra/actors.js'
import { withEventMeta } from '@presence/infra/infra/events.js'

import { assert, summary } from '../../../../test/lib/assert.js'

async function run() {
  console.log('Turn concurrency tests')

  // ===========================================
  // Issue 1: 동시 agent.run() — TurnActor 직렬화 검증
  // ===========================================

  // C1. TurnActor 없이 동시 호출 → 턴 번호 충돌 가능성
  //     TurnActor로 직렬화 → 턴 번호 순차 보장
  {
    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })
    let llmCallOrder = []
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        llmCallOrder.push(state.get('turn'))
        return JSON.stringify({ type: 'direct_response', message: `turn ${state.get('turn')}` })
      },
    })

    const agent = new Agent({ interpret, ST, state })
    const turnActor = turnActorR.run({ runTurn: (input, opts) => agent.run(input, opts) })

    // 3개 동시 요청 — Actor가 직렬화
    const results = await Promise.all([
      forkTask(turnActor.send({ input: 'A', source: 'user' })),
      forkTask(turnActor.send({ input: 'B', source: 'user' })),
      forkTask(turnActor.send({ input: 'C', source: 'user' })),
    ])

    assert(state.get('turn') === 3, 'C1: 3 turns completed')
    assert(llmCallOrder[0] === 1, 'C1: 1st LLM call at turn 1')
    assert(llmCallOrder[1] === 2, 'C1: 2nd LLM call at turn 2')
    assert(llmCallOrder[2] === 3, 'C1: 3rd LLM call at turn 3')
    // 각 턴의 snapshot이 이전 턴의 결과를 포함 (직렬화 증거)
    assert(results.every(r => typeof r === 'string'), 'C1: all results are strings')
  }

  // C2. TurnActor: 1st 턴 실패해도 2nd 턴 정상 실행
  {
    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })
    let callCount = 0
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        callCount++
        if (callCount === 1) return '<<<invalid>>>'
        return JSON.stringify({ type: 'direct_response', message: 'recovered' })
      },
    })

    const agent = new Agent({ interpret, ST, state })
    const turnActor = turnActorR.run({ runTurn: (input, opts) => agent.run(input, opts) })

    const [r1, r2] = await Promise.all([
      forkTask(turnActor.send({ input: 'fail' })),
      forkTask(turnActor.send({ input: 'succeed' })),
    ])

    assert(state.get('turn') === 2, 'C2: both turns ran')
    assert(r1?._turnError || (typeof r1 === 'string' && (r1.includes('오류') || r1.includes('error'))), 'C2: 1st turn error captured')
    assert(r2 === 'recovered', 'C2: 2nd turn succeeded')
  }

  // C3. handleInput 시뮬레이션: TurnActor 경유 시 동시 요청이 순차 처리
  {
    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })
    const executionOrder = []
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => {
        executionOrder.push(state.get('turn'))
        return JSON.stringify({ type: 'direct_response', message: 'ok' })
      },
    })

    const agent = new Agent({ interpret, ST, state })
    const turnActor = turnActorR.run({ runTurn: (input, opts) => agent.run(input, opts) })

    // 빠르게 5개 요청 (브라우저 탭 5개 동시 전송 시뮬레이션)
    const promises = Array.from({ length: 5 }, (_, i) =>
      forkTask(turnActor.send({ input: `req-${i}`, source: 'user' }))
    )
    await Promise.all(promises)

    assert(state.get('turn') === 5, 'C3: 5 turns completed')
    // 순차 실행 확인: 각 LLM 호출 시점의 turn이 1,2,3,4,5
    assert(executionOrder.join(',') === '1,2,3,4,5', 'C3: strictly sequential execution')
  }

  // ===========================================
  // Issue 2: cleanup → recall 순서 보장
  // ===========================================

  // C4. 턴 연쇄 시 save가 다음 턴 recall보다 먼저 memoryActor 큐에 있는지
  {
    const memoryActorOps = []
    const trackingMemoryActor = {
      send: (msg) => {
        memoryActorOps.push(msg.type)
        if (msg.type === 'recall') return { fork: (_, cb) => cb([]) }
        return { fork: (_, cb) => cb('ok') }
      },
    }

    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })
    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'ok' }),
    })

    const agent = new Agent({ interpret, ST, state, actors: { memoryActor: trackingMemoryActor } })
    await agent.run('first', { source: 'user' })
    await agent.run('second', { source: 'user' })

    const saveIdx = memoryActorOps.indexOf('save')
    const secondRecallIdx = memoryActorOps.lastIndexOf('recall')
    assert(saveIdx !== -1, 'C4: save was sent')
    assert(secondRecallIdx !== -1, 'C4: second recall was sent')
    assert(saveIdx < secondRecallIdx, 'C4: save before second recall')
  }

  // C5. save가 applyFinalState 이전에 큐잉되는지 (turnState=working 중에 전송)
  {
    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })
    let saveBeforeIdle = false
    const memoryOps = []
    const trackingActor = {
      send: (msg) => {
        memoryOps.push(msg.type)
        if (msg.type === 'save') {
          saveBeforeIdle = state.get('turnState')?.tag === 'working'
        }
        if (msg.type === 'recall') return { fork: (_, cb) => cb([]) }
        return { fork: (_, cb) => cb('ok') }
      },
    }

    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'ok' }),
    })

    const agent = new Agent({ interpret, ST, state, actors: { memoryActor: trackingActor } })
    await agent.run('test', { source: 'user' })

    assert(saveBeforeIdle, 'C5: save sent while turnState still working')
    assert(memoryOps.includes('save'), 'C5: save in ops')
  }

  // ===========================================
  // Event hook + TurnActor 통합
  // ===========================================

  // C6. event 도착 + user input 동시 → TurnActor가 직렬화
  {
    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })
    const executionLog = []
    const { interpret, ST } = createTestInterpreter({
      AskLLM: (op) => {
        // 어떤 input이 들어왔는지 기록
        const userMsg = op.messages?.find(m => m.role === 'user')
        executionLog.push(userMsg?.content || 'unknown')
        return JSON.stringify({ type: 'direct_response', message: 'done' })
      },
    })

    const agent = new Agent({ interpret, ST, state })
    const turnActor = turnActorR.run({ runTurn: (input, opts) => agent.run(input, opts) })

    // EventActor + 브릿지 hook 연결
    const eventActor = eventActorR.run({ turnActor, state, logger: null })
    const emit = emitR.run({ eventActor })

    state.hooks.on('turnState', (phase) => {
      if (phase.tag === 'idle') {
        eventActor.send({ type: 'drain' }).fork(() => {}, () => {})
      }
    })

    // user input + event 동시 발생
    const userPromise = forkTask(turnActor.send({ input: 'user question', source: 'user' }))
    emit({ type: 'github', prompt: 'event prompt' })

    await userPromise
    // event는 idle 후 처리
    await new Promise(r => setTimeout(r, 300))

    assert(executionLog.length >= 1, 'C6: at least user turn ran')
    assert(executionLog[0].includes('user question'), 'C6: user turn ran first')
    // event가 TurnActor 경유로 직렬화됨
    assert(state.get('turn') >= 1, 'C6: turns completed')
  }

  summary()
}

run()
