import fp from '@presence/core/lib/fun-fp.js'
import { ActorWrapper } from './actor-wrapper.js'

const { Task, Reader } = fp
const MEM0_USER_ID = 'default'

class MemoryActor extends ActorWrapper {
  static MSG = Object.freeze({ RECALL: 'recall', SAVE: 'save' })
  static RESULT = Object.freeze({ OK: 'ok', SKIP: 'skip', NO_OP: 'no-op' })

  constructor(mem0, adapter, logger) {
    const R = MemoryActor.RESULT
    super({}, (actorState, msg) => {
      switch (msg.type) {
        // mem0에서 관련 메모리 검색. { label } 배열 반환.
        case MemoryActor.MSG.RECALL: {
          if (!this.mem0) return [[], actorState]
          return Task.fromPromise(() => this.mem0.search(msg.input, { userId: MEM0_USER_ID, limit: 10 }))()
            .map(result => [(result.results || []).map(r => ({ label: r.memory })), actorState])
            .catchError(e => this.onRecallError(e, actorState))
        }

        // 대화 턴을 mem0에 저장. input/output 쌍으로 기록.
        case MemoryActor.MSG.SAVE: {
          if (!this.mem0) return [R.SKIP, actorState]
          const { data } = msg.node || {}
          if (!data?.input) return [R.SKIP, actorState]
          return Task.fromPromise(() => this.mem0.add([
            { role: 'user', content: data.input },
            { role: 'assistant', content: data.output || '' },
          ], { userId: MEM0_USER_ID }))()
            .map(() => {
              if (this.adapter) this.refreshCacheQuietly()
              return [R.OK, actorState]
            })
            .catchError(e => this.onSaveError(e, actorState))
        }

        default:
          return [R.NO_OP, actorState]
      }
    })

    this.mem0 = mem0
    this.adapter = adapter
    this.logger = logger
  }

  onRecallError(err, actorState) {
    (this.logger || console).warn('mem0 recall failed', { error: err.message })
    return Task.of([[], actorState])
  }

  onSaveError(err, actorState) {
    const R = MemoryActor.RESULT
    ;(this.logger || console).warn('mem0 save failed', { error: err.message })
    return Task.of([R.SKIP, actorState])
  }

  refreshCacheQuietly() {
    this.adapter.refreshCache().catch(err =>
      (this.logger || console).warn('mem0 cache refresh failed', { error: err.message }))
  }

  recall(input) { return this.send({ type: MemoryActor.MSG.RECALL, input }) }
  save(node) { return this.send({ type: MemoryActor.MSG.SAVE, node }) }
}

const memoryActorR = Reader.asks(({ mem0, adapter, logger }) => new MemoryActor(mem0, adapter, logger))

export { MemoryActor, memoryActorR }
