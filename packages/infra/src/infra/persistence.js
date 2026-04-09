import Conf from 'conf'
import fp from '@presence/core/lib/fun-fp.js'
import { PERSISTENCE } from '@presence/core/core/policies.js'

const { Reader } = fp

// =============================================================================
// Persistence: 디스크 저장소(Conf JSON 파일) 접근.
// Debounced save는 PersistenceActor가 담당 (actors/persistence-actor.js).
// =============================================================================

const SUMMARY_MARKER = '[conversation summary]'

// _접두사 키는 일시적 UI 상태 (_streaming, _debug, _toolResults 등). 저장 전 제거.
const stripTransient = (snapshot) => {
  const persisted = {}
  for (const key of Object.keys(snapshot)) {
    if (!key.startsWith('_')) persisted[key] = snapshot[key]
  }
  return persisted
}

// id 없는 history 항목에 id 부여 (legacy data migration).
const migrateHistoryIds = (history) => {
  if (!Array.isArray(history)) return []
  let sequence = 0
  return history.map(entry => {
    if (entry.id) return entry
    const timestamp = entry.ts || Date.now()
    const prefix = entry.input === SUMMARY_MARKER ? 'summary' : 'h'
    return { ...entry, id: `${prefix}-${timestamp}-${++sequence}` }
  })
}

class Persistence {
  #store

  constructor(store) {
    this.#store = store
  }

  get store() { return this.#store }

  restore() {
    try { return this.#store.get(PERSISTENCE.STORE_KEY, null) }
    catch (_) { return null }
  }

  clear() { this.#store.delete(PERSISTENCE.STORE_KEY) }
}

const createPersistenceR = Reader.asks(({ projectName = 'presence', cwd } = {}) => {
  const confOpts = cwd
    ? { cwd, configName: 'state' }
    : { projectName, configName: 'state' }
  return new Persistence(new Conf(confOpts))
})

// 레거시 브릿지
const createPersistence = (opts = {}) => createPersistenceR.run(opts)

export { Persistence, createPersistenceR, createPersistence, migrateHistoryIds, stripTransient }
