import fp from '../lib/fun-fp.js'
import { TIERS } from './memory.js'
import { MEMORY, HISTORY } from '../core/policies.js'
import { stripTransient } from './persistence.js'
import { findPromotionCandidates, applyPromotions } from './memory-maintenance.js'
import {
  extractForCompaction, buildCompactionPrompt, createSummaryEntry,
} from './history-compaction.js'

const { Actor, Task } = fp

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

export {
  forkTask,
  createMemoryActor,
  createCompactionActor,
  createPersistenceActor,
  applyCompaction,
}
