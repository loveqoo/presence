import Conf from 'conf'
import { PERSISTENCE } from '@presence/core/core/policies.js'

// =============================================================================
// Persistence: 디스크 저장소(Conf JSON 파일) 접근.
// Debounced save는 PersistenceActor가 담당 (actors/persistence-actor.js).
// =============================================================================

// _접두사 키는 일시적 UI 상태 (_streaming, _debug, _toolResults 등). 저장 전 제거.
const stripTransient = (snap) => {
  const out = {}
  for (const key of Object.keys(snap)) {
    if (!key.startsWith('_')) out[key] = snap[key]
  }
  return out
}

const createPersistence = (opts = {}) => {
  const { projectName = 'presence', cwd } = opts
  const confOpts = cwd
    ? { cwd, configName: 'state' }
    : { projectName, configName: 'state' }
  const store = new Conf(confOpts)

  const restore = () => {
    try { return store.get(PERSISTENCE.STORE_KEY, null) }
    catch (_) { return null }
  }

  const clear = () => store.delete(PERSISTENCE.STORE_KEY)

  return { store, restore, clear }
}

// id 없는 history 항목에 id 부여 (legacy data migration).
const migrateHistoryIds = (history) => {
  if (!Array.isArray(history)) return []
  let counter = 0
  return history.map(entry => {
    if (entry.id) return entry
    const ts = entry.ts || Date.now()
    const isSummary = entry.input === '[conversation summary]'
    return { ...entry, id: isSummary ? `summary-${ts}-${++counter}` : `h-${ts}-${++counter}` }
  })
}

export { createPersistence, migrateHistoryIds, stripTransient }
