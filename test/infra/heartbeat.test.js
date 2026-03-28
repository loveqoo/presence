import { createHeartbeat } from '@presence/infra/infra/heartbeat.js'
import { createReactiveState } from '@presence/infra/infra/state.js'
import { createEventActor, createTurnActor, forkTask } from '@presence/infra/infra/actors.js'
import { Phase } from '@presence/core/core/agent.js'
import { assert, summary } from '../lib/assert.js'

// 테스트용: EventActor 내부 큐 enqueue를 추적하는 mock eventActor
const createMockEventActor = () => {
  const enqueued = []
  let _state = { queue: [], inFlight: null, deadLetter: [], lastProcessed: null }
  return {
    enqueued,
    send: (msg) => ({
      fork: (_, resolve) => {
        if (msg.type === 'enqueue') {
          enqueued.push(msg.event)
          _state = { ..._state, queue: [..._state.queue, msg.event] }
        }
        resolve('ok')
      },
    }),
    getState: () => _state,
    _clearQueue: () => { _state = { ..._state, queue: [] } },
    _setInFlight: (v) => { _state = { ..._state, inFlight: v } },
  }
}

async function run() {
  console.log('Heartbeat tests')

  // 1. start → eventActor.enqueue 호출
  {
    const mockActor = createMockEventActor()
    const hb = createHeartbeat({
      eventActor: mockActor,
      intervalMs: 30,
      prompt: '테스트 점검',
    })

    hb.start()
    await new Promise(r => setTimeout(r, 80))
    hb.stop()

    assert(mockActor.enqueued.length >= 1, 'heartbeat: enqueued at least once')
    assert(mockActor.enqueued[0].type === 'heartbeat', 'heartbeat: type is heartbeat')
    assert(mockActor.enqueued[0].prompt === '테스트 점검', 'heartbeat: prompt passed')
  }

  // 2. stop → 더 이상 emit 안 함
  {
    const mockActor = createMockEventActor()
    const hb = createHeartbeat({
      eventActor: mockActor,
      intervalMs: 20,
    })

    hb.start()
    await new Promise(r => setTimeout(r, 50))
    hb.stop()
    const countAtStop = mockActor.enqueued.length
    await new Promise(r => setTimeout(r, 50))

    assert(mockActor.enqueued.length === countAtStop, 'stop: no more enqueues after stop')
    assert(!hb.running, 'stop: running is false')
  }

  // 3. 중복 start 방지
  {
    const mockActor = createMockEventActor()
    const hb = createHeartbeat({
      eventActor: mockActor,
      intervalMs: 20,
    })

    hb.start()
    hb.start()  // 중복
    await new Promise(r => setTimeout(r, 50))
    hb.stop()

    assert(hb.running === false, 'double start: stopped normally')
  }

  // 4. eventActor.send 에러 → onError 호출, 계속 실행
  {
    const errors = []
    let sendCount = 0
    const mockActor = {
      send: () => ({
        fork: (_, resolve) => {
          sendCount++
          if (sendCount === 1) throw new Error('send failed')
          resolve('ok')
        },
      }),
      getState: () => ({ queue: [], inFlight: null }),
    }

    const hb = createHeartbeat({
      eventActor: mockActor,
      intervalMs: 20,
      onError: (e) => errors.push(e),
    })

    hb.start()
    await new Promise(r => setTimeout(r, 60))
    hb.stop()

    assert(errors.length === 1, 'send error: onError called')
    assert(errors[0].message === 'send failed', 'send error: correct error')
    assert(sendCount >= 2, 'send error: continued after failure')
  }

  // 5. setTimeout 기반 → 중첩 없음 (self-scheduling)
  {
    let concurrent = 0
    let maxConcurrent = 0
    const mockActor = {
      send: () => ({
        fork: (_, resolve) => {
          concurrent++
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          concurrent--
          resolve('ok')
        },
      }),
      getState: () => ({ queue: [], inFlight: null }),
    }

    const hb = createHeartbeat({
      eventActor: mockActor,
      intervalMs: 10,
    })

    hb.start()
    await new Promise(r => setTimeout(r, 80))
    hb.stop()

    assert(maxConcurrent <= 1, 'no overlap: max concurrent is 1')
  }

  // 6. 기본값
  {
    const mockActor = createMockEventActor()
    const hb = createHeartbeat({ eventActor: mockActor, intervalMs: 100 })
    assert(!hb.running, 'initial: not running')
    hb.start()
    assert(hb.running, 'after start: running')
    hb.stop()
    assert(!hb.running, 'after stop: not running')
  }

  // 7. coalesce: Actor 큐에 미처리 heartbeat가 있으면 skip
  {
    const mockActor = createMockEventActor()
    // 큐에 heartbeat 넣기
    mockActor.send({ type: 'enqueue', event: { type: 'heartbeat', prompt: '이전 것', id: 'hb-old', receivedAt: 1 } })
      .fork(() => {}, () => {})

    const hb = createHeartbeat({
      eventActor: mockActor,
      intervalMs: 20,
    })

    const countBefore = mockActor.enqueued.length
    hb.start()
    await new Promise(r => setTimeout(r, 60))
    hb.stop()

    assert(mockActor.enqueued.length === countBefore, 'coalesce: skipped while pending heartbeat in queue')
  }

  // 8. coalesce: 큐가 비면 다시 emit
  {
    const mockActor = createMockEventActor()
    // 큐에 heartbeat 넣기
    mockActor.send({ type: 'enqueue', event: { type: 'heartbeat', id: 'hb-x', receivedAt: 1 } })
      .fork(() => {}, () => {})

    const hb = createHeartbeat({
      eventActor: mockActor,
      intervalMs: 20,
    })

    const countBefore = mockActor.enqueued.length
    hb.start()
    await new Promise(r => setTimeout(r, 30))
    assert(mockActor.enqueued.length === countBefore, 'coalesce phase 1: skipped')

    // 큐 비우기
    mockActor._clearQueue()
    await new Promise(r => setTimeout(r, 40))
    hb.stop()

    assert(mockActor.enqueued.length > countBefore, 'coalesce phase 2: enqueued after queue drained')
  }

  // 9. coalesce: 다른 타입 이벤트가 큐에 있으면 heartbeat는 emit
  {
    const mockActor = createMockEventActor()
    // 큐에 비-heartbeat 넣기
    mockActor.send({ type: 'enqueue', event: { type: 'webhook', data: 'pr', id: 'wh-1', receivedAt: 1 } })
      .fork(() => {}, () => {})

    const countBefore = mockActor.enqueued.length
    const hb = createHeartbeat({
      eventActor: mockActor,
      intervalMs: 20,
    })

    hb.start()
    await new Promise(r => setTimeout(r, 40))
    hb.stop()

    assert(mockActor.enqueued.length > countBefore, 'non-heartbeat queue: heartbeat still enqueued')
  }

  // 10. coalesce: heartbeat가 처리 중 (inFlight)이면 skip
  {
    const mockActor = createMockEventActor()
    mockActor._setInFlight({ type: 'heartbeat', id: 'hb-running' })

    const hb = createHeartbeat({
      eventActor: mockActor,
      intervalMs: 20,
    })

    const countBefore = mockActor.enqueued.length
    hb.start()
    await new Promise(r => setTimeout(r, 50))
    hb.stop()

    assert(mockActor.enqueued.length === countBefore, 'inFlight coalesce: skipped while heartbeat processing')
  }

  // 11. inFlight가 다른 타입이면 heartbeat emit 허용
  {
    const mockActor = createMockEventActor()
    mockActor._setInFlight({ type: 'webhook', id: 'wh-1' })

    const countBefore = mockActor.enqueued.length
    const hb = createHeartbeat({
      eventActor: mockActor,
      intervalMs: 20,
    })

    hb.start()
    await new Promise(r => setTimeout(r, 40))
    hb.stop()

    assert(mockActor.enqueued.length > countBefore, 'non-heartbeat inFlight: heartbeat still enqueued')
  }

  summary()
}

run()
