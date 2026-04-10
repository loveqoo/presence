import fp from '@presence/core/lib/fun-fp.js'
import { ActorWrapper } from './actor-wrapper.js'

const { Task, Reader } = fp

class MemoryActor extends ActorWrapper {
  static MSG = Object.freeze({ RECALL: 'recall', SAVE: 'save' })
  static RESULT = Object.freeze({ OK: 'ok', SKIP: 'skip', NO_OP: 'no-op' })

  #memory
  #userId
  #logger

  constructor(memory, userId, opts = {}) {
    const { logger } = opts
    const R = MemoryActor.RESULT
    super({}, (actorState, msg) => {
      switch (msg.type) {
        // 유사 메모리 검색
        case MemoryActor.MSG.RECALL: {
          if (!this.#memory) return [[], actorState]
          return Task.fromPromise(() => this.#memory.search(this.#userId, msg.input))()
            .map(nodes => [nodes, actorState])
            .catchError(err => this.#onRecallError(err, actorState))
        }

        // 대화 턴 저장
        case MemoryActor.MSG.SAVE: {
          if (!this.#memory) return [R.SKIP, actorState]
          const { data } = msg.node || {}
          if (!data?.input) return [R.SKIP, actorState]
          return Task.fromPromise(() => this.#memory.add(this.#userId, data.input, data.output))()
            .map(() => [R.OK, actorState])
            .catchError(err => this.#onSaveError(err, actorState))
        }

        default:
          return [R.NO_OP, actorState]
      }
    })

    this.#memory = memory
    this.#userId = userId
    this.#logger = logger
  }

  #onRecallError(err, actorState) {
    (this.#logger || console).warn('memory recall failed', { error: err.message })
    return Task.of([[], actorState])
  }

  #onSaveError(err, actorState) {
    const R = MemoryActor.RESULT
    ;(this.#logger || console).warn('memory save failed', { error: err.message })
    return Task.of([R.SKIP, actorState])
  }

  recall(input) { return this.send({ type: MemoryActor.MSG.RECALL, input }) }
  save(node) { return this.send({ type: MemoryActor.MSG.SAVE, node }) }
}

const memoryActorR = Reader.asks(({ memory, userId, ...opts }) => new MemoryActor(memory, userId, opts))

export { MemoryActor, memoryActorR }
