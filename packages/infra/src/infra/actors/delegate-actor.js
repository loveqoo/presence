import fp from '@presence/core/lib/fun-fp.js'
import { fireAndForget } from '@presence/core/lib/task.js'
import { DELEGATE, STATE_PATH } from '@presence/core/core/policies.js'
import { withEventMeta } from '../events.js'
import { getA2ATaskStatus } from '../a2a-client.js'
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

  constructor(state, eventActor, opts = {}) {
    const {
      agentRegistry, logger, fetchFn,
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
          const ts = state.get(STATE_PATH.TURN_STATE)
          if (!ts || ts.tag !== 'idle') return [R.NO_OP_BUSY, actorState]
          const pending = state.get(STATE_PATH.DELEGATES_PENDING) || []
          if (pending.length === 0) return [R.NO_OP_EMPTY, actorState]

          const polling = { ...actorState, polling: true }
          return Task.fromPromise(() => Promise.all(pending.map(entry => this.pollEntry(entry))))()
            .map(settled => this.applyPollResults(state, polling, settled))
            .catchError(() => Task.of([R.POLL_ERROR, { ...polling, polling: false }]))
        }

        default:
          return [R.UNKNOWN, actorState]
      }
    })

    this.state = state
    this.eventActor = eventActor
    this.agentRegistry = agentRegistry
    this.logger = logger
    this.fetchFn = fetchFn
  }

  applyPollResults(state, polling, settled) {
    const R = DelegateActor.RESULT
    settled.filter(r => r.done).forEach(r => this.enqueueResult(r.entry, r.result))
    state.set(STATE_PATH.DELEGATES_PENDING, settled.filter(r => !r.done).map(r => r.entry))
    return [R.POLLED, { ...polling, polling: false }]
  }

  async pollEntry(entry) {
    const endpoint = this.resolveEndpoint(entry)
    if (!endpoint) return { entry, done: false }
    const result = await getA2ATaskStatus(entry.target, endpoint, entry.taskId, { fetchFn: this.fetchFn })
    return { entry, result, done: result.status === 'completed' || result.status === 'failed' }
  }

  resolveEndpoint(entry) {
    return Maybe.fold(
      () => entry.endpoint,
      agent => agent.endpoint || entry.endpoint,
      this.agentRegistry ? this.agentRegistry.get(entry.target) : Maybe.Nothing(),
    )
  }

  start() { return this.send({ type: DelegateActor.MSG.START }) }
  stop() { return this.send({ type: DelegateActor.MSG.STOP }) }
  poll() { return this.send({ type: DelegateActor.MSG.POLL }) }

  enqueueResult(entry, result) {
    const enriched = withEventMeta({
      type: 'delegate_result',
      target: entry.target,
      taskId: entry.taskId,
      result,
    })
    fireAndForget(this.eventActor.enqueue(enriched))
    ;(this.logger || console).info(`Delegate ${result.status}: ${entry.target}/${entry.taskId}`)
  }
}

const delegateActorR = Reader.asks(({ state, eventActor, ...opts }) =>
  new DelegateActor(state, eventActor, opts))

export { DelegateActor, delegateActorR }
