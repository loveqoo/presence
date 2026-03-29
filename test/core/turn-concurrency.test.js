import { initI18n } from '@presence/infra/i18n'
initI18n('ko')
import {
  createAgentTurn, safeRunTurn, createAgent,
  PHASE, RESULT, Phase,
} from '@presence/core/core/agent.js'
import { createTestInterpreter } from '@presence/core/interpreter/test.js'
import { createReactiveState } from '@presence/infra/infra/state.js'
import { turnActorR, memoryActorR, eventActorR, emitR, forkTask } from '@presence/infra/infra/actors.js'
import { createMemoryGraph } from '@presence/infra/infra/memory.js'
import { withEventMeta } from '@presence/infra/infra/events.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { assert, summary } from '../lib/assert.js'

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

    const agent = createAgent({ interpret, ST, state })
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

    const agent = createAgent({ interpret, ST, state })
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

    const agent = createAgent({ interpret, ST, state })
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

  // C4. 턴 연쇄 시 cleanup이 recall보다 먼저 memoryActor 큐에 있는지
  {
    const tmpDir = mkdtempSync(join(tmpdir(), 'presence-conc-'))
    try {
      const memory = await createMemoryGraph(join(tmpDir, 'mem'))
      const memoryActorOps = []
      // memoryActor 래핑: 메시지 순서 기록
      const realMemoryActor = memoryActorR.run({ graph: memory, embedder: null, logger: null })
      const trackingMemoryActor = {
        send: (msg) => {
          memoryActorOps.push(msg.type)
          return realMemoryActor.send(msg)
        },
      }

      const state = createReactiveState({
        turnState: Phase.idle(), lastTurn: null, turn: 0,
        context: { memories: [], conversationHistory: [] },
      })
      const { interpret, ST } = createTestInterpreter({
        AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'ok' }),
      })

      const execute = safeRunTurn({ interpret, ST }, state, {
        memoryActor: trackingMemoryActor,
      })
      const agent = createAgent({ interpret, ST, state, execute })

      // 1st 턴
      await agent.run('first', { source: 'user' })

      // idle hook에서 2nd 턴 자동 시작 시뮬레이션
      const execute2 = safeRunTurn({ interpret, ST }, state, {
        memoryActor: trackingMemoryActor,
      })
      const agent2 = createAgent({ interpret, ST, state, execute: execute2 })
      await agent2.run('second', { source: 'user' })

      // memoryActor에서 1st 턴의 removeWorking이 2nd 턴의 recall보다 먼저인지
      const removeIdx = memoryActorOps.indexOf('removeWorking')
      const secondRecallIdx = memoryActorOps.lastIndexOf('recall')
      assert(removeIdx !== -1, 'C4: removeWorking was sent')
      assert(secondRecallIdx !== -1, 'C4: second recall was sent')
      assert(removeIdx < secondRecallIdx, 'C4: removeWorking before second recall')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // C5. cleanup이 applyFinalState 이전에 큐잉되는지 (구조 검증)
  //     finalState에서 lastTurn을 읽으므로 reactive state 미커밋 상태에서도 동작
  {
    const state = createReactiveState({
      turnState: Phase.idle(), lastTurn: null, turn: 0,
      context: { memories: [], conversationHistory: [] },
    })
    let cleanupBeforeIdle = false
    const memoryOps = []
    const trackingActor = {
      send: (msg) => {
        memoryOps.push(msg.type)
        // idle hook 전에 cleanup이 왔는지 확인
        if (msg.type === 'removeWorking') {
          cleanupBeforeIdle = state.get('turnState')?.tag === 'working'
        }
        return { fork: (_, cb) => cb('ok') }
      },
    }

    const { interpret, ST } = createTestInterpreter({
      AskLLM: () => JSON.stringify({ type: 'direct_response', message: 'ok' }),
    })

    const execute = safeRunTurn({ interpret, ST }, state, { memoryActor: trackingActor })
    const agent = createAgent({ interpret, ST, state, execute })
    await agent.run('test', { source: 'user' })

    assert(cleanupBeforeIdle, 'C5: removeWorking sent while turnState still working')
    assert(memoryOps.includes('removeWorking'), 'C5: removeWorking in ops')
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

    const agent = createAgent({ interpret, ST, state })
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
