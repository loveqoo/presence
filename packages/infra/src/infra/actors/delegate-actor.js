import fp from '@presence/core/lib/fun-fp.js'
import { fireAndForget } from '@presence/core/lib/task.js'
import { DELEGATE, PHASE, STATE_PATH } from '@presence/core/core/policies.js'
import { withEventMeta } from '../events.js'
import { A2AClient } from '../agents/a2a-client.js'
import { ActorWrapper } from './actor-wrapper.js'

const { Task, Maybe, Reader } = fp

class DelegateActor extends ActorWrapper {
  static MSG = Object.freeze({ START: 'start', STOP: 'stop', TICK: 'tick', POLL: 'poll' })
  static RESULT = Object.freeze({
    STARTED: 'started', STOPPED: 'stopped', TICKED: 'ticked',
    POLLED: 'polled', POLL_ERROR: 'poll-error', ALREADY_RUNNING: 'already-running',
    NO_OP_STOPPED: 'no-op:stopped', NO_OP_POLLING: 'no-op:polling',
    NO_OP_BUSY: 'no-op:busy', NO_OP_EMPTY: 'no-op:empty', UNKNOWN: 'unknown',
  })

  #state
  #eventActor
  #agentRegistry
  #logger
  #a2a
  #delegateRuntime

  constructor(state, eventActor, opts = {}) {
    const {
      agentRegistry, logger, fetchFn, delegateRuntime,
      pollIntervalMs = DELEGATE.POLL_INTERVAL_MS,
    } = opts
    let timer = null

    const scheduleNextTick = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        fireAndForget(this.send({ type: DelegateActor.MSG.TICK }))
      }, pollIntervalMs)
    }

    const R = DelegateActor.RESULT
    // running: 폴링 루프 활성 여부. polling: 현재 폴링 진행 중 여부.
    super({ running: false, polling: false }, (actorState, msg) => {
      switch (msg.type) {
        // 폴링 루프 시작. 주기적으로 tick을 자신에게 전송.
        case DelegateActor.MSG.START: {
          if (actorState.running) return [R.ALREADY_RUNNING, actorState]
          scheduleNextTick()
          return [R.STARTED, { ...actorState, running: true }]
        }

        // 폴링 루프 중지. 타이머 해제.
        case DelegateActor.MSG.STOP: {
          if (timer) { clearTimeout(timer); timer = null }
          return [R.STOPPED, { ...actorState, running: false, polling: false }]
        }

        // 타이머 콜백. 다음 tick 예약 후 poll 실행.
        case DelegateActor.MSG.TICK: {
          if (!actorState.running) return [R.NO_OP_STOPPED, actorState]
          scheduleNextTick()
          fireAndForget(this.poll())
          return [R.TICKED, actorState]
        }

        // 위임 태스크 상태 조회. 완료된 것은 eventActor에 결과 전달, 나머지는 pending 유지.
        case DelegateActor.MSG.POLL: {
          if (actorState.polling) return [R.NO_OP_POLLING, actorState]
          const ts = this.#state.get(STATE_PATH.TURN_STATE)
          if (!ts || ts.tag !== PHASE.IDLE) return [R.NO_OP_BUSY, actorState]
          const pending = this.#state.get(STATE_PATH.DELEGATES_PENDING) || []
          if (pending.length === 0) return [R.NO_OP_EMPTY, actorState]

          const polling = { ...actorState, polling: true }
          return Task.fromPromise(() => Promise.all(pending.map(entry => this.#pollEntry(entry))))()
            .map(settled => this.#applyPollResults(polling, settled))
            .catchError(() => Task.of([R.POLL_ERROR, { ...polling, polling: false }]))
        }

        default:
          return [R.UNKNOWN, actorState]
      }
    })

    this.#state = state
    this.#eventActor = eventActor
    this.#agentRegistry = agentRegistry
    this.#logger = logger
    this.#a2a = new A2AClient({ fetchFn })
    this.#delegateRuntime = delegateRuntime
  }

  // --- Public 메시지 API ---
  start() { return this.send({ type: DelegateActor.MSG.START }) }
  stop() { return this.send({ type: DelegateActor.MSG.STOP }) }
  poll() { return this.send({ type: DelegateActor.MSG.POLL }) }

  // --- 내부: Poll 결과 적용 ---
  #applyPollResults(polling, settled) {
    const R = DelegateActor.RESULT
    const doneEntries = settled.filter(r => r.done)
    doneEntries.forEach(r => this.#enqueueResult(r.entry, r.result))
    // Phase 12b: 각 완료 항목당 delegateFSM runtime 에 resolve/fail 전이 알림.
    // runtime 이 pending count 를 추적해 SessionFSM 축 일관성 유지.
    if (this.#delegateRuntime) {
      for (const r of doneEntries) {
        const type = r.result && typeof r.result.isFailed === 'function' && r.result.isFailed() ? 'fail' : 'resolve'
        this.#delegateRuntime.submit({ type })
      }
    }
    this.#state.set(STATE_PATH.DELEGATES_PENDING, settled.filter(r => !r.done).map(r => r.entry))
    return [R.POLLED, { ...polling, polling: false }]
  }

  async #pollEntry(entry) {
    const endpoint = this.#resolveEndpoint(entry)
    if (!endpoint) return { entry, done: false }
    const result = await this.#a2a.getTaskStatus(entry.target, endpoint, entry.taskId)
    return { entry, result, done: result.isTerminal() }
  }

  #resolveEndpoint(entry) {
    return Maybe.fold(
      () => entry.endpoint,
      agent => agent.endpoint || entry.endpoint,
      this.#agentRegistry ? this.#agentRegistry.get(entry.target) : Maybe.Nothing(),
    )
  }

  #enqueueResult(entry, result) {
    const enriched = withEventMeta({
      type: 'delegate_result',
      target: entry.target,
      taskId: entry.taskId,
      result,
    })
    fireAndForget(this.#eventActor.enqueue(enriched))
    ;(this.#logger || console).info(`Delegate ${result.status}: ${entry.target}/${entry.taskId}`)
  }
}

const delegateActorR = Reader.asks(({ state, eventActor, ...opts }) =>
  new DelegateActor(state, eventActor, opts))

export { DelegateActor, delegateActorR }
