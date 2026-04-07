import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { mkdirSync } from 'fs'

// =============================================================================
// UserDataStore: 유저 레벨 구조화된 데이터 저장소.
// 단일 테이블 user_data — category/status로 분류, payload에 JSON.
// =============================================================================

const ORDER_MAP = Object.freeze({
  created_at_asc: 'created_at ASC',
  created_at_desc: 'created_at DESC',
  updated_at_asc: 'updated_at ASC',
  updated_at_desc: 'updated_at DESC',
})

const parsePayload = (raw) => {
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}

const toRecord = (row) => ({
  id: row.id,
  category: row.category,
  status: row.status,
  title: row.title,
  payload: parsePayload(row.payload),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

class UserDataStore {
  #db

  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.#db = new Database(dbPath)
    this.#db.pragma('journal_mode = WAL')
    this.#db.pragma('foreign_keys = ON')
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS user_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT,
        payload TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    // 인덱스 (이미 존재하면 무시)
    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS idx_user_data_category_status ON user_data(category, status)
    `)
  }

  list({ category, status, limit, orderBy } = {}) {
    const conditions = []
    const params = {}
    if (category) { conditions.push('category = @category'); params.category = category }
    if (status) { conditions.push('status = @status'); params.status = status }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const order = ORDER_MAP[orderBy] || 'created_at ASC'
    const limitClause = limit ? `LIMIT ${Number(limit)}` : ''

    const rows = this.#db.prepare(`SELECT * FROM user_data ${where} ORDER BY ${order} ${limitClause}`).all(params)
    return rows.map(toRecord)
  }

  get(id) {
    const row = this.#db.prepare('SELECT * FROM user_data WHERE id = ?').get(id)
    return row ? toRecord(row) : null
  }

  add({ category, status, title, payload }) {
    const now = Date.now()
    const payloadStr = payload ? JSON.stringify(payload) : null
    const result = this.#db.prepare(
      'INSERT INTO user_data (category, status, title, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(category, status, title || null, payloadStr, now, now)
    return this.get(result.lastInsertRowid)
  }

  update(id, changes) {
    const sets = []
    const params = { id }
    if (changes.status !== undefined) { sets.push('status = @status'); params.status = changes.status }
    if (changes.title !== undefined) { sets.push('title = @title'); params.title = changes.title }
    if (changes.payload !== undefined) { sets.push('payload = @payload'); params.payload = JSON.stringify(changes.payload) }
    if (sets.length === 0) return false
    sets.push('updated_at = @updatedAt')
    params.updatedAt = Date.now()
    const result = this.#db.prepare(`UPDATE user_data SET ${sets.join(', ')} WHERE id = @id`).run(params)
    return result.changes > 0
  }

  remove(id) {
    const result = this.#db.prepare('DELETE FROM user_data WHERE id = ?').run(id)
    return result.changes > 0
  }

  close() {
    this.#db.close()
  }
}

const defaultUserDataDbPath = (memoryPath) => join(memoryPath, 'user-data.db')

export { UserDataStore, defaultUserDataDbPath }
