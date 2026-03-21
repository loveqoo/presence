import { createHeartbeat } from '../../src/infra/heartbeat.js'
import { createReactiveState } from '../../src/infra/state.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

async function run() {
  console.log('Heartbeat tests')

  // 1. start → emit 호출
  {
    const emitted = []
    const hb = createHeartbeat({
      emit: (event) => emitted.push(event),
      intervalMs: 30,
      prompt: '테스트 점검',
    })

    hb.start()
    await new Promise(r => setTimeout(r, 80))
    hb.stop()

    assert(emitted.length >= 1, 'heartbeat: emitted at least once')
    assert(emitted[0].type === 'heartbeat', 'heartbeat: type is heartbeat')
    assert(emitted[0].prompt === '테스트 점검', 'heartbeat: prompt passed')
  }

  // 2. stop → 더 이상 emit 안 함
  {
    const emitted = []
    const hb = createHeartbeat({
      emit: (event) => emitted.push(event),
      intervalMs: 20,
    })

    hb.start()
    await new Promise(r => setTimeout(r, 50))
    hb.stop()
    const countAtStop = emitted.length
    await new Promise(r => setTimeout(r, 50))

    assert(emitted.length === countAtStop, 'stop: no more emits after stop')
    assert(!hb.running, 'stop: running is false')
  }

  // 3. 중복 start 방지
  {
    let emitCount = 0
    const hb = createHeartbeat({
      emit: () => emitCount++,
      intervalMs: 20,
    })

    hb.start()
    hb.start()  // 중복
    await new Promise(r => setTimeout(r, 50))
    hb.stop()

    assert(hb.running === false, 'double start: stopped normally')
  }

  // 4. emit 에러 → onError 호출, 계속 실행
  {
    const errors = []
    let emitCount = 0
    const hb = createHeartbeat({
      emit: () => {
        emitCount++
        if (emitCount === 1) throw new Error('emit failed')
      },
      intervalMs: 20,
      onError: (e) => errors.push(e),
    })

    hb.start()
    await new Promise(r => setTimeout(r, 60))
    hb.stop()

    assert(errors.length === 1, 'emit error: onError called')
    assert(errors[0].message === 'emit failed', 'emit error: correct error')
    assert(emitCount >= 2, 'emit error: continued after failure')
  }

  // 5. setTimeout 기반 → 중첩 없음 (self-scheduling)
  {
    let concurrent = 0
    let maxConcurrent = 0
    const hb = createHeartbeat({
      emit: () => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        concurrent--
      },
      intervalMs: 10,
    })

    hb.start()
    await new Promise(r => setTimeout(r, 80))
    hb.stop()

    assert(maxConcurrent <= 1, 'no overlap: max concurrent is 1')
  }

  // 6. 기본값
  {
    const hb = createHeartbeat({ emit: () => {}, intervalMs: 100 })
    assert(!hb.running, 'initial: not running')
    hb.start()
    assert(hb.running, 'after start: running')
    hb.stop()
    assert(!hb.running, 'after stop: not running')
  }

  // 7. coalesce: 큐에 미처리 heartbeat가 있으면 skip
  {
    const state = createReactiveState({
      events: { queue: [{ type: 'heartbeat', prompt: '이전 것' }] },
    })

    const emitted = []
    const hb = createHeartbeat({
      emit: (event) => emitted.push(event),
      state,
      intervalMs: 20,
    })

    hb.start()
    await new Promise(r => setTimeout(r, 60))
    hb.stop()

    assert(emitted.length === 0, 'coalesce: skipped while pending heartbeat in queue')
  }

  // 8. coalesce: 큐가 비면 다시 emit
  {
    const state = createReactiveState({
      events: { queue: [{ type: 'heartbeat' }] },
    })

    const emitted = []
    const hb = createHeartbeat({
      emit: (event) => emitted.push(event),
      state,
      intervalMs: 20,
    })

    hb.start()
    await new Promise(r => setTimeout(r, 30))
    assert(emitted.length === 0, 'coalesce phase 1: skipped')

    // 큐 비우기
    state.set('events.queue', [])
    await new Promise(r => setTimeout(r, 40))
    hb.stop()

    assert(emitted.length >= 1, 'coalesce phase 2: emitted after queue drained')
  }

  // 9. coalesce: 다른 타입 이벤트가 큐에 있으면 heartbeat는 emit
  {
    const state = createReactiveState({
      events: { queue: [{ type: 'webhook', data: 'pr' }] },
    })

    const emitted = []
    const hb = createHeartbeat({
      emit: (event) => emitted.push(event),
      state,
      intervalMs: 20,
    })

    hb.start()
    await new Promise(r => setTimeout(r, 40))
    hb.stop()

    assert(emitted.length >= 1, 'non-heartbeat queue: heartbeat still emitted')
  }

  // 10. coalesce: heartbeat가 처리 중 (inFlight)이면 skip
  {
    const state = createReactiveState({
      events: {
        queue: [],
        inFlight: { type: 'heartbeat', id: 'hb-running' },
      },
    })

    const emitted = []
    const hb = createHeartbeat({
      emit: (event) => emitted.push(event),
      state,
      intervalMs: 20,
    })

    hb.start()
    await new Promise(r => setTimeout(r, 50))
    hb.stop()

    assert(emitted.length === 0, 'inFlight coalesce: skipped while heartbeat processing')
  }

  // 11. inFlight가 다른 타입이면 heartbeat emit 허용
  {
    const state = createReactiveState({
      events: {
        queue: [],
        inFlight: { type: 'webhook', id: 'wh-1' },
      },
    })

    const emitted = []
    const hb = createHeartbeat({
      emit: (event) => emitted.push(event),
      state,
      intervalMs: 20,
    })

    hb.start()
    await new Promise(r => setTimeout(r, 40))
    hb.stop()

    assert(emitted.length >= 1, 'non-heartbeat inFlight: heartbeat still emitted')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
