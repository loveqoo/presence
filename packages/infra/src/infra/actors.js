import fp from '@presence/core/lib/fun-fp.js'
import { HISTORY } from '@presence/core/core/policies.js'
const MEM0_USER_ID = 'default'
import { stripTransient } from './persistence.js'
import {
  extractForCompaction, buildCompactionPrompt, createSummaryEntry,
} from './history-compaction.js'
import { withEventMeta, eventToPrompt, buildTodoReviewPrompt, todoFromEvent, isDuplicate } from './events.js'
import { getA2ATaskStatus } from './a2a-client.js'

const { Actor, Task, Maybe, Reader } = fp

// --- Helpers (순수, Reader 대상 아님) ---

const forkTask = (task) => new Promise((resolve, reject) => task.fork(reject, resolve))

const applyCompaction = (reactiveState, { summary, extractedIds }) => {
  const current = reactiveState.get('context.conversationHistory') || []
  const filtered = current.filter(h => !h.id || !extractedIds.has(h.id))
  const merged = [summary, ...filtered]
  const trimmed = merged.length > HISTORY.MAX_CONVERSATION
    ? [merged[0], ...merged.slice(-(HISTORY.MAX_CONVERSATION - 1))]
    : merged
  reactiveState.set('context.conversationHistory', trimmed)
}

const applyTodo = (state, event) => {
  Maybe.fold(
    () => {},
    todo => {
      const todos = state.get('todos') || []
      if (isDuplicate(todos, event.id)) return
      state.set('todos', [...todos, todo])
    },
    todoFromEvent(event),
  )
}

const projectEvents = (state, { queue, inFlight, deadLetter, lastProcessed }) => {
  state.set('events.queue', queue.map(e => ({ ...e })))
  state.set('events.inFlight', inFlight ? { ...inFlight } : null)
  state.set('events.deadLetter', deadLetter.map(e => ({ ...e })))
  if (lastProcessed !== undefined) state.set('events.lastProcessed', lastProcessed)
}

// =============================================================================
// Reader 기반 Actor Factory
// =============================================================================

// --- MemoryActor: Reader({ mem0, adapter, logger } → Actor) ---

const memoryActorR = Reader.asks(({ mem0, adapter, logger }) => Actor({
  init: { mem0, adapter, logger },
  handle: (state, msg) => {
    const { mem0, adapter, logger } = state

    switch (msg.type) {
      case 'recall': {
        if (!mem0) return [[], state]
        return new Task((reject, resolve) =>
          mem0.search(msg.input, { userId: MEM0_USER_ID, limit: 10 })
            .then(result => {
              const memories = (result.results || []).map(r => ({ label: r.memory }))
              resolve([memories, state])
            })
            .catch(e => {
              ;(logger || console).warn('mem0 recall failed', { error: e.message })
              resolve([[], state])
            })
        )
      }

      case 'save': {
        if (!mem0) return ['skip', state]
        const { data } = msg.node || {}
        if (!data?.input) return ['skip', state]
        return new Task((reject, resolve) =>
          mem0.add([
            { role: 'user', content: data.input },
            { role: 'assistant', content: data.output || '' },
          ], { userId: MEM0_USER_ID })
            .then(() => {
              if (adapter) adapter._refreshCache().catch(() => {})
              resolve(['ok', state])
            })
            .catch(e => {
              ;(logger || console).warn('mem0 save failed', { error: e.message })
              resolve(['skip', state])
            })
        )
      }

      default:
        return ['no-op', state]
    }
  },
}))

// --- CompactionActor: Reader({ llm, logger } → Actor) ---

const compactionActorR = Reader.asks(({ llm, logger }) => Actor({
  init: {},
  handle: (state, msg) => {
    if (msg.type !== 'check') return ['skip', state]
    const split = extractForCompaction(
      msg.history, HISTORY.COMPACTION_THRESHOLD, HISTORY.COMPACTION_KEEP,
    )
    if (!split) return ['skip', state]

    return new Task((reject, resolve) => {
      const prompt = buildCompactionPrompt(split.extracted)
      llm.chat(prompt)
        .then(result => {
          const summary = createSummaryEntry(result.content)
          const extractedIds = new Set(
            split.extracted.filter(h => h.id).map(h => h.id),
          )
          resolve([{ summary, extractedIds, epoch: msg.epoch }, state])
        })
        .catch(e => {
          ;(logger || console).warn('Compaction failed', { error: e.message })
          resolve(['skip', state])
        })
    })
  },
}))

// --- PersistenceActor: Reader({ store, debounceMs } → Actor) ---
// self-referential closure는 Reader.asks 내부에 유지

const persistenceActorR = Reader.asks(({ store, debounceMs = 500 }) => {
  let actor
  let timer = null

  actor = Actor({
    init: {},
    handle: (state, msg) => {
      if (msg.type === 'flush') {
        if (timer) { clearTimeout(timer); timer = null }
        if (msg.snapshot) {
          try { store.set('agentState', stripTransient(msg.snapshot)) } catch (_) {}
        }
        return ['flushed', state]
      }
      if (msg.type !== 'save') return ['skip', state]

      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        actor.send({ type: 'flush', snapshot: msg.snapshot }).fork(() => {}, () => {})
      }, debounceMs)
      return ['deferred', state]
    },
  })

  return actor
})

// --- TurnActor: Reader({ runTurn } → Actor) ---

const turnActorR = Reader.asks(({ runTurn }) => Actor({
  init: {},
  handle: (_state, { input, source, allowedTools }) =>
    new Task((reject, resolve) => {
      runTurn(input, { source, allowedTools: allowedTools || [] })
        .then(result => resolve([result, _state]))
        .catch(err => resolve([{ _turnError: true, message: err.message }, _state]))
    }),
}))

// --- EventActor: Reader({ turnActor, state, logger, onEventDone, todoReviewJobName } → Actor) ---
// self-referential closure는 Reader.asks 내부에 유지

const eventActorR = Reader.asks(({ turnActor, state, logger, onEventDone, todoReviewJobName }) => {
  let actor

  actor = Actor({
    init: { queue: [], inFlight: null, deadLetter: [], lastProcessed: null },
    handle: (s, msg) => {
      switch (msg.type) {
        case 'enqueue': {
          const next = { ...s, queue: [...s.queue, msg.event] }
          projectEvents(state, next)
          const ts = state.get('turnState')
          if (ts && ts.tag === 'idle' && !s.inFlight) {
            actor.send({ type: 'drain' }).fork(() => {}, () => {})
          }
          return ['enqueued', next]
        }

        case 'drain': {
          if (s.queue.length === 0) return ['no-op:empty', s]
          if (s.inFlight !== null) return ['no-op:inFlight', s]
          const ts = state.get('turnState')
          if (!ts || ts.tag !== 'idle') return ['no-op:busy', s]

          let [event, ...rest] = s.queue

          const isTodoReview = event.type === 'todo_review' ||
            (todoReviewJobName && event.jobName === todoReviewJobName)
          if (isTodoReview) {
            const pending = (state.get('todos') || []).filter(t => !t.done)
            if (pending.length === 0) {
              const skipped = { ...s, queue: rest }
              projectEvents(state, skipped)
              if (rest.length > 0) actor.send({ type: 'drain' }).fork(() => {}, () => {})
              return ['no-op:no-todos', skipped]
            }
            event = { ...event, prompt: buildTodoReviewPrompt(pending) }
          }

          const draining = { ...s, queue: rest, inFlight: event }
          projectEvents(state, draining)

          return new Task((reject, resolve) => {
            forkTask(turnActor.send({ input: eventToPrompt(event), source: 'event', allowedTools: event.allowedTools || [] }))
              .then(result => {
                if (result?._turnError) throw new Error(result.message)
                applyTodo(state, event)
                if (onEventDone) onEventDone(event, { success: true, result })
                const done = { ...draining, queue: [...draining.queue], inFlight: null, lastProcessed: event }
                projectEvents(state, done)
                if (done.queue.length > 0) {
                  actor.send({ type: 'drain' }).fork(() => {}, () => {})
                }
                resolve(['drained', done])
              })
              .catch(err => {
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
                projectEvents(state, failed)
                if (onEventDone) onEventDone(event, { success: false, error: err.message })
                ;(logger || console).warn('Event processing failed', { eventId: event.id, error: err.message })
                if (failed.queue.length > 0) {
                  actor.send({ type: 'drain' }).fork(() => {}, () => {})
                }
                resolve(['dead-letter', failed])
              })
          })
        }

        default:
          return ['unknown', s]
      }
    },
  })

  return actor
})

// --- createEmit: Reader({ eventActor } → (event) → enrichedEvent) ---

const emitR = Reader.asks(({ eventActor }) => (event) => {
  const enriched = withEventMeta(event)
  eventActor.send({ type: 'enqueue', event: enriched }).fork(() => {}, () => {})
  return enriched
})

// --- BudgetActor: Reader({ state } → Actor) ---

const budgetActorR = Reader.asks(({ state }) => Actor({
  init: { lastWarnedTurn: -1 },
  handle: (s, msg) => {
    if (msg.type !== 'check') return ['skip', s]
    const { debug, turn } = msg
    if (!debug?.assembly) return ['no-op', s]
    if (turn === s.lastWarnedTurn) return ['no-op', s]

    const { budget, used, historyDropped } = debug.assembly
    if (budget === Infinity) return ['no-op', s]
    const pct = Math.round(used / budget * 100)

    if (historyDropped > 0) {
      state.set('_budgetWarning', { type: 'history_dropped', dropped: historyDropped, pct })
      return ['warned', { lastWarnedTurn: turn }]
    }
    if (pct >= 90) {
      state.set('_budgetWarning', { type: 'high_usage', pct })
      return ['warned', { lastWarnedTurn: turn }]
    }
    if (state.get('_budgetWarning') != null) state.set('_budgetWarning', null)
    return ['ok', s]
  },
}))

// --- DelegateActor: Reader({ state, eventActor, agentRegistry, logger, fetchFn, pollIntervalMs } → Actor) ---
// self-referential closure + timer는 Reader.asks 내부에 유지

const delegateActorR = Reader.asks(({ state, eventActor, agentRegistry, logger, fetchFn, pollIntervalMs = 10_000 }) => {
  let actor
  let timer = null

  const resolveEndpoint = (entry) =>
    Maybe.fold(
      () => entry.endpoint,
      agent => agent.endpoint || entry.endpoint,
      agentRegistry ? agentRegistry.get(entry.target) : Maybe.Nothing(),
    )

  actor = Actor({
    init: { running: false, polling: false },
    handle: (s, msg) => {
      switch (msg.type) {
        case 'start': {
          if (s.running) return ['already-running', s]
          const next = { ...s, running: true }
          timer = setTimeout(() => {
            actor.send({ type: 'tick' }).fork(() => {}, () => {})
          }, pollIntervalMs)
          return ['started', next]
        }

        case 'stop': {
          if (timer) { clearTimeout(timer); timer = null }
          return ['stopped', { ...s, running: false, polling: false }]
        }

        case 'tick': {
          if (!s.running) return ['no-op:stopped', s]
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => {
            actor.send({ type: 'tick' }).fork(() => {}, () => {})
          }, pollIntervalMs)
          actor.send({ type: 'poll' }).fork(() => {}, () => {})
          return ['ticked', s]
        }

        case 'poll': {
          if (s.polling) return ['no-op:polling', s]
          const ts = state.get('turnState')
          if (!ts || ts.tag !== 'idle') return ['no-op:busy', s]
          const pending = state.get('delegates.pending') || []
          if (pending.length === 0) return ['no-op:empty', s]

          const polling = { ...s, polling: true }

          return new Task((reject, resolve) => {
            const pollEntry = async (entry) => {
              const endpoint = resolveEndpoint(entry)
              if (!endpoint) return { entry, done: false }
              const result = await getA2ATaskStatus(entry.target, endpoint, entry.taskId, { fetchFn })
              return { entry, result, done: result.status === 'completed' || result.status === 'failed' }
            }

            Promise.all(pending.map(pollEntry))
              .then(settled => {
                settled
                  .filter(r => r.done)
                  .forEach(r => {
                    const enriched = withEventMeta({
                      type: 'delegate_result',
                      target: r.entry.target,
                      taskId: r.entry.taskId,
                      result: r.result,
                    })
                    eventActor.send({ type: 'enqueue', event: enriched }).fork(() => {}, () => {})
                    ;(logger || console).info(`Delegate ${r.result.status}: ${r.entry.target}/${r.entry.taskId}`)
                  })
                state.set('delegates.pending', settled.filter(r => !r.done).map(r => r.entry))
                resolve(['polled', { ...polling, polling: false }])
              })
              .catch(() => {
                resolve(['poll-error', { ...polling, polling: false }])
              })
          })
        }

        default:
          return ['unknown', s]
      }
    },
  })

  return actor
})

// =============================================================================
// 레거시 브릿지: createX(deps) === xR.run(deps)
// =============================================================================

const createMemoryActor = (deps) => memoryActorR.run(deps)
const createCompactionActor = (deps) => compactionActorR.run(deps)
const createPersistenceActor = (deps) => persistenceActorR.run(deps)
const createTurnActor = (runTurn) => turnActorR.run({ runTurn })
const createEventActor = (deps) => eventActorR.run(deps)
const createEmit = (eventActor) => emitR.run({ eventActor })
const createBudgetActor = (deps) => budgetActorR.run(deps)
const createDelegateActor = (deps) => delegateActorR.run(deps)

export {
  // Reader 기반 (신규)
  memoryActorR,
  compactionActorR,
  persistenceActorR,
  turnActorR,
  eventActorR,
  emitR,
  budgetActorR,
  delegateActorR,

  // 순수 헬퍼 (변경 없음)
  forkTask,
  applyCompaction,
  applyTodo,

  // 레거시 브릿지
  createMemoryActor,
  createCompactionActor,
  createPersistenceActor,
  createTurnActor,
  createEventActor,
  createEmit,
  createBudgetActor,
  createDelegateActor,
}
