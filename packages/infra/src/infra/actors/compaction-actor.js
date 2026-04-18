import fp from '@presence/core/lib/fun-fp.js'
import { HISTORY } from '@presence/core/core/policies.js'
import { isTurnEntry } from '@presence/core/core/history-writer.js'
import { ActorWrapper } from './actor-wrapper.js'

const { Task, Maybe, Reader } = fp

const SUMMARY_MARKER = '[conversation summary]'

// INV-SYS-1: SYSTEM entry 는 compaction 임계치 카운트와 prompt 모두에서 배제.

const extractForCompaction = (history, threshold, keep) => {
  if (!Array.isArray(history)) return Maybe.Nothing()
  // turn entry 만 카운트. SYSTEM 이 섞여도 임계치 왜곡 없음.
  const turnCount = history.reduce((n, e) => n + (isTurnEntry(e) ? 1 : 0), 0)
  if (turnCount <= threshold) return Maybe.Nothing()
  if (keep <= 0 || keep >= history.length || keep >= threshold) return Maybe.Nothing()
  return Maybe.Just({
    extracted: history.slice(0, history.length - keep),
    remaining: history.slice(history.length - keep),
  })
}

const summaryEntry = (content) => {
  const now = Date.now()
  return {
    id: `summary-${now}-${Math.random().toString(36).slice(2, 8)}`,
    input: SUMMARY_MARKER,
    output: content,
    ts: now,
  }
}

const compactionPrompt = (toCompact) => {
  // SYSTEM entry 는 compaction prompt 에 포함하지 않음 (INV-SYS-1).
  const turnsOnly = toCompact.filter(isTurnEntry)
  const hasPreviousSummary = turnsOnly[0]?.input === SUMMARY_MARKER
  const parts = turnsOnly.map(h => {
    if (h.input === SUMMARY_MARKER) return `[Previous Summary]\n${h.output}`
    return `User: ${h.input}\nAssistant: ${h.output}`
  })

  const systemPrompt = hasPreviousSummary
    ? '이전 요약과 새 대화 기록을 통합하여 하나의 맥락 요약으로 작성하세요. 이전 요약의 핵심 내용을 보존하면서 새 대화의 사실과 결정 사항을 추가하세요. 3~5문장.'
    : '다음 대화 기록을 간결한 맥락 요약으로 작성하세요. 핵심 사실, 결정 사항, 이전 대화의 맥락을 보존하세요. 3~5문장.'

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: parts.join('\n---\n') },
    ],
  }
}

const compactionResult = (split, resultContent, epoch) => {
  const summary = summaryEntry(resultContent)
  const extractedIds = new Set(
    split.extracted.filter(h => h.id).map(h => h.id),
  )
  return { summary, extractedIds, epoch }
}

class CompactionActor extends ActorWrapper {
  static MSG = Object.freeze({ CHECK: 'check' })
  static RESULT = Object.freeze({ SKIP: 'skip' })

  #logger

  constructor(llm, opts = {}) {
    const { logger } = opts
    const R = CompactionActor.RESULT
    // CHECK: 대화 이력이 임계치를 넘으면 LLM으로 요약 생성. 미달이면 skip.
    super({}, (actorState, msg) => {
      if (msg.type !== CompactionActor.MSG.CHECK) return [R.SKIP, actorState]

      return Maybe.fold(
        () => [R.SKIP, actorState],
        split => Task.fromPromise(() => llm.chat(compactionPrompt(split.extracted)))()
          .map(result => [compactionResult(split, result.content, msg.epoch), actorState])
          .catchError(e => {
            ;(this.#logger || console).warn('Compaction failed', { error: e.message })
            return Task.of([R.SKIP, actorState])
          }),
        extractForCompaction(msg.history, HISTORY.COMPACTION_THRESHOLD, HISTORY.COMPACTION_KEEP),
      )
    })

    this.#logger = logger
  }

  check(history, epoch) { return this.send({ type: CompactionActor.MSG.CHECK, history, epoch }) }
}

const compactionActorR = Reader.asks(({ llm, ...opts }) => new CompactionActor(llm, opts))

export { CompactionActor, compactionActorR, SUMMARY_MARKER, extractForCompaction, summaryEntry, compactionPrompt, compactionResult }
