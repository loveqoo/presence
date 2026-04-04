import Conf from 'conf'
import { PERSISTENCE } from '@presence/core/core/policies.js'

/**
 * Removes transient keys (prefixed with `_`) from a state snapshot before persisting.
 * @param {object} snap - State snapshot object.
 * @returns {object} Snapshot with transient keys stripped.
 */
// _접두사 키는 일시적 UI 상태 (_streaming, _debug, _toolResults 등)
export const stripTransient = (snap) => {
  const out = {}
  for (const key of Object.keys(snap)) {
    if (!key.startsWith('_')) out[key] = snap[key]
  }
  return out
}

/**
 * Creates a debounced persistence layer backed by Conf (JSON file store).
 * Strips transient (_-prefixed) keys before saving.
 * @param {{ projectName?: string, debounceMs?: number, cwd?: string }} [options]
 * @returns {{ save: Function, saveImmediate: Function, restore: Function, clear: Function, store: object }}
 */
const createPersistence = ({ projectName = 'presence', debounceMs = PERSISTENCE.DEBOUNCE_MS, cwd } = {}) => {
  const confOpts = cwd
    ? { cwd, configName: 'state' }
    : { projectName, configName: 'state' }
  const store = new Conf(confOpts)
  let timer = null

  const save = (state) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        const snap = typeof state.snapshot === 'function' ? state.snapshot() : state
        store.set(PERSISTENCE.STORE_KEY, stripTransient(snap))
      } catch (_) {
        // non-fatal: state will be re-saved on next change
      }
      timer = null
    }, debounceMs)
  }

  const saveImmediate = (state) => {
    if (timer) clearTimeout(timer)
    try {
      const snap = typeof state.snapshot === 'function' ? state.snapshot() : state
      store.set(PERSISTENCE.STORE_KEY, stripTransient(snap))
    } catch (_) {
      // non-fatal: state will be re-saved on next change
    }
    timer = null
  }

  const restore = () => {
    try { return store.get(PERSISTENCE.STORE_KEY, null) }
    catch (_) { return null }
  }

  const clear = () => store.delete(PERSISTENCE.STORE_KEY)

  return { save, saveImmediate, restore, clear, store }
}

/**
 * Assigns stable ids to history entries that lack them (migration for legacy data).
 * @param {object[]} history - Conversation history array.
 * @returns {object[]} History with ids added to any entries that were missing them.
 */
// 순수 함수: id 없는 history 항목에 id 부여
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

export { createPersistence, migrateHistoryIds }
