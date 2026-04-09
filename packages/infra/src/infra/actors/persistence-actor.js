import fp from '@presence/core/lib/fun-fp.js'
import { fireAndForget } from '@presence/core/lib/task.js'
import { PERSISTENCE } from '@presence/core/core/policies.js'
import { stripTransient } from '../persistence.js'
import { ActorWrapper } from './actor-wrapper.js'

const { Reader } = fp

class PersistenceActor extends ActorWrapper {
  static MSG = Object.freeze({ SAVE: 'save', FLUSH: 'flush' })
  static RESULT = Object.freeze({ FLUSHED: 'flushed', DEFERRED: 'deferred', SKIP: 'skip' })

  #store
  #logger

  constructor(store, opts = {}) {
    const { logger, debounceMs = PERSISTENCE.DEBOUNCE_MS } = opts
    let timer = null
    const R = PersistenceActor.RESULT

    super({}, (actorState, msg) => {
      // 즉시 디스크 기록. 디바운스 타이머가 있으면 취소.
      if (msg.type === PersistenceActor.MSG.FLUSH) {
        if (timer) { clearTimeout(timer); timer = null }
        if (msg.snapshot) this.#flushToDisk(msg.snapshot)
        return [R.FLUSHED, actorState]
      }
      if (msg.type !== PersistenceActor.MSG.SAVE) return [R.SKIP, actorState]

      // 디바운스 저장. 연속 호출 시 마지막 snapshot만 flush.
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        fireAndForget(this.flush(msg.snapshot))
      }, debounceMs)
      return [R.DEFERRED, actorState]
    })

    this.#store = store
    this.#logger = logger
  }

  // --- Public 메시지 API ---
  save(snapshot) { return this.send({ type: PersistenceActor.MSG.SAVE, snapshot }) }
  flush(snapshot) { return this.send({ type: PersistenceActor.MSG.FLUSH, snapshot }) }

  // --- 내부: 디스크 기록 ---
  #flushToDisk(snapshot) {
    try { this.#store.set(PERSISTENCE.STORE_KEY, stripTransient(snapshot)) } catch (err) {
      (this.#logger || console).warn('Persistence flush failed', { error: err.message })
    }
  }
}

const persistenceActorR = Reader.asks(({ store, ...opts }) => new PersistenceActor(store, opts))

export { PersistenceActor, persistenceActorR }
