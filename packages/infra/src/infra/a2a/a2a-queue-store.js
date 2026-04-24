import Database from 'better-sqlite3'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import fp from '@presence/core/lib/fun-fp.js'

const { Reader } = fp

// =============================================================================
// A2aQueueStore — A2A Phase 1 S1 영속 큐 (SQLite)
//
// 같은 유저 내 agent 간 TODO (request/response) 메시지를 저장한다.
// JobStore 패턴 복사 — better-sqlite3 동기 API, PRAGMA user_version migration.
//
// 경로: ~/.presence/users/{u}/memory/a2a-queue.db (JobStore 와 같은 디렉토리).
// 설계: docs/design/a2a-internal.md v3 §4 ~ §6.
//
// S1 에서는 request + pending→processing→completed/failed 만 사용.
// response/correlationId/timeoutMs expire 는 S2 에서 추가.
// =============================================================================

const SCHEMA_VERSION = 1

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS todo_messages (
    id              TEXT PRIMARY KEY,
    from_agent_id   TEXT NOT NULL,
    to_agent_id     TEXT NOT NULL,
    kind            TEXT NOT NULL,
    correlation_id  TEXT,
    payload         TEXT NOT NULL,
    status          TEXT NOT NULL,
    error           TEXT,
    created_at      INTEGER NOT NULL,
    timeout_ms      INTEGER,
    processed_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_todo_to_agent_status ON todo_messages(to_agent_id, status);
  CREATE INDEX IF NOT EXISTS idx_todo_from_agent ON todo_messages(from_agent_id);
`

// 상태 머신 (§6.1):
//   pending → processing → completed
//           ↘ failed / expired / cancelled / orphaned (S2+)
// markProcessing 이 false 를 반환하는 집합 = "이미 처리된 상태 or 처리 대상 아님"
// (processing / completed / failed / expired 또는 row 없음). 드레인에서 skip 안전.
const TODO_STATUS = Object.freeze({
  PENDING:    'pending',
  PROCESSING: 'processing',
  COMPLETED:  'completed',
  FAILED:     'failed',
  EXPIRED:    'expired',
  CANCELLED:  'cancelled',
  ORPHANED:   'orphaned',
})

const TODO_KIND = Object.freeze({
  REQUEST:  'request',
  RESPONSE: 'response',
})

class A2aQueueStore {
  #db

  constructor(dbPath) {
    const dir = dbPath.split('/').slice(0, -1).join('/')
    if (dir) mkdirSync(dir, { recursive: true })
    this.#db = new Database(dbPath)
    this.#db.pragma('journal_mode = WAL')
    this.#db.pragma('foreign_keys = ON')
    this.#migrate()
  }

  // PRAGMA user_version 기반 idempotent migration.
  #migrate() {
    const current = this.#db.pragma('user_version', { simple: true })
    if (current === 0) {
      this.#db.exec(SCHEMA)
      this.#db.pragma(`user_version = ${SCHEMA_VERSION}`)
    }
  }

  // --- Request enqueue ---

  enqueueRequest({ fromAgentId, toAgentId, payload, timeoutMs = null }) {
    if (!fromAgentId || !toAgentId) {
      throw new Error('enqueueRequest: fromAgentId + toAgentId required')
    }
    if (typeof payload !== 'string') {
      throw new Error('enqueueRequest: payload must be string')
    }
    const now = Date.now()
    const id = randomUUID()
    this.#db.prepare(`
      INSERT INTO todo_messages (id, from_agent_id, to_agent_id, kind, payload, status, created_at, timeout_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, fromAgentId, toAgentId, TODO_KIND.REQUEST, payload, TODO_STATUS.PENDING, now, timeoutMs)
    return this.getMessage(id)
  }

  // --- 상태 전이 ---

  // pending → processing 전이. 성공 시 true.
  // false 집합: 이미 processing/completed/failed/expired 이거나 row 없음.
  // 드레인 경로에서 false = "이미 처리된 상태, skip 안전".
  markProcessing(id) {
    const now = Date.now()
    const result = this.#db.prepare(`
      UPDATE todo_messages SET status = ?, processed_at = ?
      WHERE id = ? AND status = ?
    `).run(TODO_STATUS.PROCESSING, now, id, TODO_STATUS.PENDING)
    return result.changes > 0
  }

  // processing → completed 전이. 다른 상태면 false.
  markCompleted(id) {
    const result = this.#db.prepare(`
      UPDATE todo_messages SET status = ?
      WHERE id = ? AND status = ?
    `).run(TODO_STATUS.COMPLETED, id, TODO_STATUS.PROCESSING)
    return result.changes > 0
  }

  // pending | processing → failed. error 저장.
  markFailed(id, error) {
    const result = this.#db.prepare(`
      UPDATE todo_messages SET status = ?, error = ?
      WHERE id = ? AND status IN (?, ?)
    `).run(TODO_STATUS.FAILED, error ?? null, id, TODO_STATUS.PENDING, TODO_STATUS.PROCESSING)
    return result.changes > 0
  }

  // --- 조회 ---

  getMessage(id) {
    const row = this.#db.prepare('SELECT * FROM todo_messages WHERE id = ?').get(id)
    return row ? A2aQueueStore.#rowToMessage(row) : null
  }

  listByRecipient(toAgentId, { status } = {}) {
    const stmt = status
      ? this.#db.prepare('SELECT * FROM todo_messages WHERE to_agent_id = ? AND status = ? ORDER BY created_at ASC')
      : this.#db.prepare('SELECT * FROM todo_messages WHERE to_agent_id = ? ORDER BY created_at ASC')
    const rows = status ? stmt.all(toAgentId, status) : stmt.all(toAgentId)
    return rows.map(A2aQueueStore.#rowToMessage)
  }

  close() { this.#db.close() }

  static #rowToMessage(row) {
    return {
      id: row.id,
      fromAgentId: row.from_agent_id,
      toAgentId: row.to_agent_id,
      kind: row.kind,
      correlationId: row.correlation_id,
      payload: row.payload,
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
      timeoutMs: row.timeout_ms,
      processedAt: row.processed_at,
    }
  }
}

const createA2aQueueStoreR = Reader.asks(({ dbPath }) => new A2aQueueStore(dbPath))
const createA2aQueueStore = (dbPath) => createA2aQueueStoreR.run({ dbPath })
const defaultA2aQueueDbPath = (memoryPath) => join(memoryPath, 'a2a-queue.db')

export {
  A2aQueueStore,
  createA2aQueueStoreR,
  createA2aQueueStore,
  defaultA2aQueueDbPath,
  TODO_STATUS,
  TODO_KIND,
}
