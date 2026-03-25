import fp from '../lib/fun-fp.js'
import { TIERS } from './memory.js'
import { MEMORY, HISTORY } from '../core/policies.js'
import { stripTransient } from './persistence.js'
import { findPromotionCandidates, applyPromotions } from './memory-maintenance.js'
import {
  extractForCompaction, buildCompactionPrompt, createSummaryEntry,
} from './history-compaction.js'
import { withEventMeta, eventToPrompt, todoFromEvent, isDuplicate } from './events.js'
import { getA2ATaskStatus } from './a2a-client.js'

const { Actor, Task, Maybe } = fp

// --- Helpers ---

const forkTask = (task) => new Promise((resolve, reject) => task.fork(reject, resolve))

// --- MemoryActor ---
// recall, save, embed, prune, promote, removeWorking 통합
// Actor 큐 직렬화로 순서 보장

const createMemoryActor = ({ graph, embedder, logger }) => Actor({
  init: { graph, embedder, logger },
  handle: (state, msg) => {
    const { graph, embedder, logger } = state
    switch (msg.type) {
      case 'recall':
        return new Task((reject, resolve) =>
          graph.recall(msg.input, { embedder, topK: 10, logger })
            .then(memories => resolve([memories, state]))
            .catch(reject)
        )

      case 'save':
        graph.addNode(msg.node)
        return new Task((reject, resolve) =>
          graph.save()
            .then(() => resolve(['ok', state]))
            .catch(reject)
        )

      case 'embed':
        return new Task((reject, resolve) =>
          graph.embedPending(embedder, { logger })
            .then(count => resolve([count, state]))
            .catch(reject)
        )

      case 'prune': {
        const pruned = graph.pruneByTier(msg.tier, msg.max)
        return [pruned, state]
      }

      case 'promote': {
        const candidates = findPromotionCandidates(graph)
        if (candidates.length > 0) applyPromotions(graph, candidates, logger)
        return [candidates.length, state]
      }

      case 'removeWorking':
        graph.removeNodesByTier(TIERS.WORKING)
        return ['ok', state]

      case 'saveDisk':
        return new Task((reject, resolve) =>
          graph.save()
            .then(() => resolve(['saved', state]))
            .catch(reject)
        )

      default:
        return ['unknown', state]
    }
  },
})

// --- CompactionActor ---
// 히스토리 요약. Task 반환 시 fork 완료까지 다음 메시지 대기 (큐 직렬화).

const createCompactionActor = ({ llm, logger }) => Actor({
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
          if (logger) logger.warn('Compaction failed', { error: e.message })
          resolve(['skip', state])
        })
    })
  },
})

// --- PersistenceActor ---
// self-send trailing flush 패턴: save → debounce → flush
// timer callback이 actor state를 직접 변경하지 않고 flush 메시지를 self-send

const createPersistenceActor = ({ store, debounceMs = 500 }) => {
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
}

// --- applyCompaction ---
// CompactionActor 결과를 현재 history와 merge (caller에서 호출)

const applyCompaction = (reactiveState, { summary, extractedIds }) => {
  const current = reactiveState.get('context.conversationHistory') || []
  const filtered = current.filter(h => !h.id || !extractedIds.has(h.id))
  const merged = [summary, ...filtered]
  const trimmed = merged.length > HISTORY.MAX_CONVERSATION
    ? [merged[0], ...merged.slice(-(HISTORY.MAX_CONVERSATION - 1))]
    : merged
  reactiveState.set('context.conversationHistory', trimmed)
}

// --- TurnActor ---
// 모든 소스(user, event, heartbeat)의 턴 요청을 직렬화.
// 동시 agent.run() 방지 — Actor 큐가 순서 보장.

const createTurnActor = (runTurn) => Actor({
  init: {},
  handle: (_state, { input, source }) =>
    new Task((reject, resolve) => {
      runTurn(input, { source })
        .then(result => resolve([result, _state]))
        .catch(err => resolve([{ _turnError: true, message: err.message }, _state]))
    }),
})

// --- applyTodo ---
// 순수 함수: 이벤트에서 TODO 생성 + state 반영 (isDuplicate 멱등성)
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

// --- EventActor ---
// wireEventHooks + wireTodoHooks + createEventReceiver 흡수.
// Actor 큐가 processing 플래그를 대체 (직렬화 보장).
// Source of truth: Actor 내부 상태. ReactiveState.events.*는 projection/cache.

const projectEvents = (state, { queue, inFlight, deadLetter, lastProcessed }) => {
  state.set('events.queue', queue.map(e => ({ ...e })))
  state.set('events.inFlight', inFlight ? { ...inFlight } : null)
  state.set('events.deadLetter', deadLetter.map(e => ({ ...e })))
  if (lastProcessed !== undefined) state.set('events.lastProcessed', lastProcessed)
}

const createEventActor = ({ turnActor, state, logger }) => {
  let actor

  actor = Actor({
    init: { queue: [], inFlight: null, deadLetter: [], lastProcessed: null },
    handle: (s, msg) => {
      switch (msg.type) {
        case 'enqueue': {
          const next = { ...s, queue: [...s.queue, msg.event] }
          projectEvents(state, next)
          // idle이면 자체 drain 전송
          const ts = state.get('turnState')
          if (ts && ts.tag === 'idle' && !s.inFlight) {
            actor.send({ type: 'drain' }).fork(() => {}, () => {})
          }
          return ['enqueued', next]
        }

        case 'drain': {
          // idempotency: 큐 비었거나 inFlight이거나 not-idle → no-op
          if (s.queue.length === 0) return ['no-op:empty', s]
          if (s.inFlight !== null) return ['no-op:inFlight', s]
          const ts = state.get('turnState')
          if (!ts || ts.tag !== 'idle') return ['no-op:busy', s]

          const [event, ...rest] = s.queue
          const draining = { ...s, queue: rest, inFlight: event }
          projectEvents(state, draining)

          return new Task((reject, resolve) => {
            forkTask(turnActor.send({ input: eventToPrompt(event), source: 'event' }))
              .then(result => {
                if (result?._turnError) throw new Error(result.message)
                applyTodo(state, event)
                const done = { ...draining, queue: [...draining.queue], inFlight: null, lastProcessed: event }
                // queue는 drain 중에 enqueue로 변경되었을 수 있으므로 Actor state에서 읽지 않음
                // (Actor 직렬화이므로 drain 완료 전 enqueue는 큐에 대기)
                projectEvents(state, done)
                // 큐에 남아있으면 자체 drain
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
                if (logger) logger.warn('Event processing failed', { eventId: event.id, error: err.message })
                // 실패해도 큐에 남은 이벤트 계속 처리
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
}

// --- createEmit ---
// fire-and-forget wrapper. enriched event를 동기 반환.
const createEmit = (eventActor) => (event) => {
  const enriched = withEventMeta(event)
  eventActor.send({ type: 'enqueue', event: enriched }).fork(() => {}, () => {})
  return enriched
}

// --- BudgetActor ---
// wireBudgetWarning 흡수. 가장 얇은 Actor.

const createBudgetActor = ({ state }) => Actor({
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
    // 정상 턴 → 이전 경고 해제
    if (state.get('_budgetWarning') != null) state.set('_budgetWarning', null)
    return ['ok', s]
  },
})

// --- DelegateActor ---
// wireDelegatePolling 흡수. self-send 타이머 패턴 (PersistenceActor와 동일).

const createDelegateActor = ({ state, eventActor, agentRegistry, logger, fetchFn, pollIntervalMs = 10_000 }) => {
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
          // 최초 tick 예약
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
          // 다음 타이머 예약
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => {
            actor.send({ type: 'tick' }).fork(() => {}, () => {})
          }, pollIntervalMs)
          // poll 호출 (Actor 큐 경유)
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
                    if (logger) logger.info(`Delegate ${r.result.status}: ${r.entry.target}/${r.entry.taskId}`)
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
}

export {
  forkTask,
  createMemoryActor,
  createCompactionActor,
  createPersistenceActor,
  createTurnActor,
  applyCompaction,
  createEventActor,
  createEmit,
  applyTodo,
  createBudgetActor,
  createDelegateActor,
}
