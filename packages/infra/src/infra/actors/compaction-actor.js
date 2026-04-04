import fp from '@presence/core/lib/fun-fp.js'
import { HISTORY } from '@presence/core/core/policies.js'
import { ActorWrapper } from './actor-wrapper.js'

const { Task, Maybe, Reader } = fp

const SUMMARY_MARKER = '[conversation summary]'

class CompactionActor extends ActorWrapper {
  static MSG = Object.freeze({ CHECK: 'check' })
  static RESULT = Object.freeze({ SKIP: 'skip' })

  constructor(llm, logger) {
    const R = CompactionActor.RESULT
    // CHECK: 대화 이력이 임계치를 넘으면 LLM으로 요약 생성. 미달이면 skip.
    super({}, (actorState, msg) => {
      if (msg.type !== CompactionActor.MSG.CHECK) return [R.SKIP, actorState]

      return Maybe.fold(
        () => [R.SKIP, actorState],
        split => Task.fromPromise(() => llm.chat(this.compactionPrompt(split.extracted)))()
          .map(result => [this.compactionResult(split, result.content, msg.epoch), actorState])
          .catchError(e => {
            ;(logger || console).warn('Compaction failed', { error: e.message })
            return Task.of([R.SKIP, actorState])
          }),
        this.extractForCompaction(msg.history, HISTORY.COMPACTION_THRESHOLD, HISTORY.COMPACTION_KEEP),
      )
    })
  }

  check(history, epoch) { return this.send({ type: CompactionActor.MSG.CHECK, history, epoch }) }

  extractForCompaction(history, threshold, keep) {
    if (!Array.isArray(history) || history.length <= threshold) return Maybe.Nothing()
    if (keep <= 0 || keep >= history.length || keep >= threshold) return Maybe.Nothing()
    return Maybe.Just({
      extracted: history.slice(0, history.length - keep),
      remaining: history.slice(history.length - keep),
    })
  }

  summaryEntry(content) {
    const now = Date.now()
    return {
      id: `summary-${now}-${Math.random().toString(36).slice(2, 8)}`,
      input: SUMMARY_MARKER,
      output: content,
      ts: now,
    }
  }

  compactionPrompt(toCompact) {
    const hasPreviousSummary = toCompact[0]?.input === SUMMARY_MARKER
    const parts = toCompact.map(h => {
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

  compactionResult(split, resultContent, epoch) {
    const summary = this.summaryEntry(resultContent)
    const extractedIds = new Set(
      split.extracted.filter(h => h.id).map(h => h.id),
    )
    return { summary, extractedIds, epoch }
  }
}

const compactionActorR = Reader.asks(({ llm, logger }) => new CompactionActor(llm, logger))

export { CompactionActor, compactionActorR, SUMMARY_MARKER }
