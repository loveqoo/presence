import fp from '@presence/core/lib/fun-fp.js'
import { fireAndForget, forkTask } from '@presence/core/lib/task.js'
import { PHASE, STATE_PATH, TODO, TURN_SOURCE } from '@presence/core/core/policies.js'
import { withEventMeta, eventToPrompt, buildTodoReviewPrompt, isDuplicate, todoFromEvent, syncTodosProjection } from '../events.js'
import { ActorWrapper } from './actor-wrapper.js'

const { Task, Maybe, Reader } = fp

class EventActor extends ActorWrapper {
  static MSG = Object.freeze({ ENQUEUE: 'enqueue', DRAIN: 'drain' })
  static RESULT = Object.freeze({
    ENQUEUED: 'enqueued', DRAINED: 'drained', DEAD_LETTER: 'dead-letter',
    NO_OP_EMPTY: 'no-op:empty', NO_OP_IN_FLIGHT: 'no-op:inFlight',
    NO_OP_BUSY: 'no-op:busy', NO_OP_NO_TODOS: 'no-op:no-todos', UNKNOWN: 'unknown',
  })

  #state
  #logger
  #onEventDone
  #userDataStore

  constructor(turnActor, state, opts = {}) {
    const { logger, onEventDone, todoReviewJobName, userDataStore } = opts
    const R = EventActor.RESULT
    // queue: 처리 대기 이벤트. inFlight: 현재 처리 중인 이벤트. deadLetter: 실패한 이벤트.
    super(
      { queue: [], inFlight: null, deadLetter: [], lastProcessed: null },
      (actorState, msg) => {
        switch (msg.type) {
          // 큐에 이벤트 추가. idle 상태면 즉시 drain 시작.
          case EventActor.MSG.ENQUEUE: {
            const next = { ...actorState, queue: [...actorState.queue, msg.event] }
            this.#projectEvents(next)
            const ts = state.get(STATE_PATH.TURN_STATE)
            if (ts && ts.tag === PHASE.IDLE && !actorState.inFlight) {
              fireAndForget(this.drain())
            }
            return [R.ENQUEUED, next]
          }

          // 큐 선두 이벤트를 꺼내 turnActor로 실행. 성공→다음 drain, 실패→deadLetter.
          case EventActor.MSG.DRAIN: {
            if (actorState.queue.length === 0) return [R.NO_OP_EMPTY, actorState]
            if (actorState.inFlight !== null) return [R.NO_OP_IN_FLIGHT, actorState]
            const ts = state.get(STATE_PATH.TURN_STATE)
            if (!ts || ts.tag !== 'idle') return [R.NO_OP_BUSY, actorState]

            const [head, ...rest] = actorState.queue
            const todoResult = this.#resolveTodoReview(head, state, todoReviewJobName)
            if (todoResult.skip) return this.#skipTodoReview(actorState, rest)
            const event = todoResult.event

            const draining = { ...actorState, queue: rest, inFlight: event }
            this.#projectEvents(draining)

            const runEvent = () => forkTask(
              turnActor.run(eventToPrompt(event), { source: TURN_SOURCE.EVENT, allowedTools: event.allowedTools || [] }),
            )

            return Task.fromPromise(runEvent)()
              .map(result => [R.DRAINED, this.#handleDrainSuccess(draining, event, result)])
              .catchError(err => Task.of([R.DEAD_LETTER, this.#handleDrainFailure(draining, event, err)]))
          }

          default:
            return [R.UNKNOWN, actorState]
        }
      },
    )

    this.#state = state
    this.#logger = logger
    this.#onEventDone = onEventDone
    this.#userDataStore = userDataStore
  }

  // --- Public 메시지 API ---
  enqueue(event) { return this.send({ type: EventActor.MSG.ENQUEUE, event }) }
  drain() { return this.send({ type: EventActor.MSG.DRAIN }) }

  emit(event) {
    const enriched = withEventMeta(event)
    fireAndForget(this.enqueue(enriched))
    return enriched
  }

  // --- 내부: 상태 투영 ---
  #projectEvents({ queue, inFlight, deadLetter, lastProcessed }) {
    this.#state.set(STATE_PATH.EVENTS_QUEUE, queue.map(e => ({ ...e })))
    this.#state.set(STATE_PATH.EVENTS_IN_FLIGHT, inFlight ? { ...inFlight } : null)
    this.#state.set(STATE_PATH.EVENTS_DEAD_LETTER, deadLetter.map(e => ({ ...e })))
    if (lastProcessed !== undefined) this.#state.set(STATE_PATH.EVENTS_LAST_PROCESSED, lastProcessed)
  }

  #applyTodo(event) {
    if (!this.#userDataStore) return
    Maybe.fold(
      () => {},
      todo => {
        const existing = this.#userDataStore.list({ category: TODO.CATEGORY })
        if (isDuplicate(existing, event.id)) return
        this.#userDataStore.add(todo)
        syncTodosProjection(this.#state, this.#userDataStore)
      },
      todoFromEvent(event),
    )
  }

  #resolveTodoReview(event, state, todoReviewJobName) {
    const isTodoReview = event.type === 'todo_review' ||
      (todoReviewJobName && event.jobName === todoReviewJobName)
    if (!isTodoReview) return { event, skip: false }
    const pending = this.#userDataStore
      ? this.#userDataStore.list({ category: TODO.CATEGORY, status: TODO.STATUS_READY })
      : []
    if (pending.length === 0) return { event, skip: true }
    return { event: { ...event, prompt: buildTodoReviewPrompt(pending) }, skip: false }
  }

  #handleDrainSuccess(draining, event, result) {
    this.#applyTodo(event)
    if (this.#onEventDone) this.#onEventDone(event, { success: true, result })
    const done = { ...draining, queue: [...draining.queue], inFlight: null, lastProcessed: event }
    this.#projectEvents(done)
    if (done.queue.length > 0) fireAndForget(this.drain())
    return done
  }

  #handleDrainFailure(draining, event, err) {
    const deadLetterEntry = {
      ...event,
      error: err.message || String(err),
      failedAt: Date.now(),
    }
    const failed = {
      ...draining,
      queue: [...draining.queue],
      inFlight: null,
      deadLetter: [...draining.deadLetter, deadLetterEntry],
    }
    this.#projectEvents(failed)
    if (this.#onEventDone) this.#onEventDone(event, { success: false, error: err.message })
    ;(this.#logger || console).warn('Event processing failed', { eventId: event.id, error: err.message })
    if (failed.queue.length > 0) fireAndForget(this.drain())
    return failed
  }

  #skipTodoReview(actorState, rest) {
    const skipped = { ...actorState, queue: rest }
    this.#projectEvents(skipped)
    if (rest.length > 0) fireAndForget(this.drain())
    return [EventActor.RESULT.NO_OP_NO_TODOS, skipped]
  }
}

const eventActorR = Reader.asks(({ turnActor, state, ...opts }) =>
  new EventActor(turnActor, state, opts))

export { EventActor, eventActorR }
