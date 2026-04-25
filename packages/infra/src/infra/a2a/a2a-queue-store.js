import Database from 'better-sqlite3'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import fp from '@presence/core/lib/fun-fp.js'
import { A2A } from '@presence/core/core/policies.js'

const { Reader } = fp

// =============================================================================
// A2aQueueStore — A2A Phase 1 S1 영속 큐 (SQLite)
//
// 같은 유저 내 agent 간 A2A (request/response) 메시지를 저장한다.
// JobStore 패턴 복사 — better-sqlite3 동기 API, PRAGMA user_version migration.
//
// 경로: ~/.presence/users/{u}/memory/a2a-queue.db (JobStore 와 같은 디렉토리).
// 설계: docs/design/a2a-internal.md v8 §4 ~ §6.
//
// v2 (2026-04-25): 테이블명 todo_messages → a2a_messages, category 컬럼 추가.
//   category 는 분류 필드 (기본 'todo'). 현재 'todo' 하나만 사용되지만
//   프리미티브는 범용 — 'question'/'report'/'announcement' 등 자유 확장 가능.
// =============================================================================

const SCHEMA_VERSION = 2

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS a2a_messages (
    id              TEXT PRIMARY KEY,
    from_agent_id   TEXT NOT NULL,
    to_agent_id     TEXT NOT NULL,
    kind            TEXT NOT NULL,
    correlation_id  TEXT,
    category        TEXT NOT NULL DEFAULT 'todo',
    payload         TEXT NOT NULL,
    status          TEXT NOT NULL,
    error           TEXT,
    created_at      INTEGER NOT NULL,
    timeout_ms      INTEGER,
    processed_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_a2a_to_agent_status ON a2a_messages(to_agent_id, status);
  CREATE INDEX IF NOT EXISTS idx_a2a_from_agent ON a2a_messages(from_agent_id);
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
  //   0 → 2: 신규 DB. SCHEMA 로 a2a_messages 테이블 생성.
  //   1 → 2: 기존 todo_messages 를 a2a_messages 로 rename + category 컬럼 추가.
  //          DEFAULT 'todo' 로 기존 row 자동 백필.
  #migrate() {
    const current = this.#db.pragma('user_version', { simple: true })
    if (current === 0) {
      this.#db.exec(SCHEMA)
      this.#db.pragma(`user_version = ${SCHEMA_VERSION}`)
      return
    }
    if (current === 1) {
      this.#db.exec(`
        ALTER TABLE todo_messages RENAME TO a2a_messages;
        ALTER TABLE a2a_messages ADD COLUMN category TEXT NOT NULL DEFAULT 'todo';
      `)
      this.#db.pragma('user_version = 2')
    }
  }

  // --- Request enqueue ---

  enqueueRequest({ fromAgentId, toAgentId, payload, timeoutMs = null, category = 'todo' }) {
    if (!fromAgentId || !toAgentId) {
      throw new Error('enqueueRequest: fromAgentId + toAgentId required')
    }
    if (typeof payload !== 'string') {
      throw new Error('enqueueRequest: payload must be string')
    }
    const now = Date.now()
    const id = randomUUID()
    this.#db.prepare(`
      INSERT INTO a2a_messages (id, from_agent_id, to_agent_id, kind, category, payload, status, created_at, timeout_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, fromAgentId, toAgentId, TODO_KIND.REQUEST, category, payload, TODO_STATUS.PENDING, now, timeoutMs)
    return this.getMessage(id)
  }

  // S4 §6.5 — 큐 상한 enforcement. 트랜잭션 내부 COUNT + INSERT 원자화 (race-free).
  //   초과 시 row 는 status='failed', error='queue-full' 로 INSERT — audit 보존.
  //   caller (interpreter) 가 반환된 row.status 보고 분기.
  enqueueRequestBounded(opts, maxPending) {
    if (!opts.fromAgentId || !opts.toAgentId) {
      throw new Error('enqueueRequestBounded: fromAgentId + toAgentId required')
    }
    if (typeof opts.payload !== 'string') {
      throw new Error('enqueueRequestBounded: payload must be string')
    }
    const insertedId = this.#db.transaction(() => {
      const now = Date.now()
      const id = randomUUID()
      const timeoutMs = opts.timeoutMs ?? null
      const category = opts.category ?? 'todo'
      const cnt = this.#db.prepare(
        `SELECT COUNT(*) AS n FROM a2a_messages WHERE to_agent_id = ? AND status = ? AND kind = ?`,
      ).get(opts.toAgentId, TODO_STATUS.PENDING, TODO_KIND.REQUEST).n
      if (cnt >= maxPending) {
        this.#db.prepare(`
          INSERT INTO a2a_messages (id, from_agent_id, to_agent_id, kind, category, payload, status, error, created_at, timeout_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, opts.fromAgentId, opts.toAgentId, TODO_KIND.REQUEST, category, opts.payload, TODO_STATUS.FAILED, 'queue-full', now, timeoutMs)
        return id
      }
      this.#db.prepare(`
        INSERT INTO a2a_messages (id, from_agent_id, to_agent_id, kind, category, payload, status, created_at, timeout_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, opts.fromAgentId, opts.toAgentId, TODO_KIND.REQUEST, category, opts.payload, TODO_STATUS.PENDING, now, timeoutMs)
      return id
    })()
    return this.getMessage(insertedId)
  }

  // --- 상태 전이 ---

  // pending → processing 전이. 성공 시 true.
  // false 집합: 이미 processing/completed/failed/expired 이거나 row 없음.
  // 드레인 경로에서 false = "이미 처리된 상태, skip 안전".
  markProcessing(id) {
    const now = Date.now()
    const result = this.#db.prepare(`
      UPDATE a2a_messages SET status = ?, processed_at = ?
      WHERE id = ? AND status = ?
    `).run(TODO_STATUS.PROCESSING, now, id, TODO_STATUS.PENDING)
    return result.changes > 0
  }

  // processing → completed 전이. 다른 상태면 false.
  markCompleted(id) {
    const result = this.#db.prepare(`
      UPDATE a2a_messages SET status = ?
      WHERE id = ? AND status = ?
    `).run(TODO_STATUS.COMPLETED, id, TODO_STATUS.PROCESSING)
    return result.changes > 0
  }

  // pending | processing → failed. error 저장.
  markFailed(id, error) {
    const result = this.#db.prepare(`
      UPDATE a2a_messages SET status = ?, error = ?
      WHERE id = ? AND status IN (?, ?)
    `).run(TODO_STATUS.FAILED, error ?? null, id, TODO_STATUS.PENDING, TODO_STATUS.PROCESSING)
    return result.changes > 0
  }

  // --- S2 확장: response 발행 ---

  // response row 생성 — kind='response'. status 는 즉시 final (pending 단계 없음).
  // correlationId 로 원본 request 와 연결. error/category 는 분류·진단 필드라 opts 로 분리.
  enqueueResponse({ correlationId, fromAgentId, toAgentId, payload, status }, opts = {}) {
    const { error = null, category = 'todo' } = opts
    if (!fromAgentId || !toAgentId) {
      throw new Error('enqueueResponse: fromAgentId + toAgentId required')
    }
    if (!correlationId) {
      throw new Error('enqueueResponse: correlationId required')
    }
    const finalStatuses = [TODO_STATUS.COMPLETED, TODO_STATUS.FAILED, TODO_STATUS.EXPIRED, TODO_STATUS.ORPHANED]
    if (!finalStatuses.includes(status)) {
      throw new Error(`enqueueResponse: status must be one of ${finalStatuses.join('|')} (got ${status})`)
    }
    const now = Date.now()
    const id = randomUUID()
    this.#db.prepare(`
      INSERT INTO a2a_messages (id, from_agent_id, to_agent_id, kind, correlation_id, category, payload, status, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, fromAgentId, toAgentId, TODO_KIND.RESPONSE, correlationId, category, payload ?? '', status, error, now)
    return this.getMessage(id)
  }

  // --- S2 확장: expire ---

  // pending/processing 중 timeout 초과 request row.
  // timeout_ms null 인 row 는 정책 기본값 (A2A.DEFAULT_TIMEOUT_MS) 적용.
  listExpired(now = Date.now()) {
    const defaultTimeout = A2A.DEFAULT_TIMEOUT_MS
    const rows = this.#db.prepare(`
      SELECT * FROM a2a_messages
      WHERE kind = ?
        AND status IN (?, ?)
        AND created_at + COALESCE(timeout_ms, ?) < ?
      ORDER BY created_at ASC
    `).all(TODO_KIND.REQUEST, TODO_STATUS.PENDING, TODO_STATUS.PROCESSING, defaultTimeout, now)
    return rows.map(A2aQueueStore.#rowToMessage)
  }

  // pending|processing → expired. 다른 상태면 false (receiver 가 먼저 완료한 경우 등).
  markExpired(id, error = null) {
    const result = this.#db.prepare(`
      UPDATE a2a_messages SET status = ?, error = ?
      WHERE id = ? AND status IN (?, ?)
    `).run(TODO_STATUS.EXPIRED, error, id, TODO_STATUS.PENDING, TODO_STATUS.PROCESSING)
    return result.changes > 0
  }

  // response row → orphaned 재분류. 전이 제약 없음 (이미 final status 에서 전환).
  markOrphaned(id) {
    const result = this.#db.prepare(`
      UPDATE a2a_messages SET status = ? WHERE id = ?
    `).run(TODO_STATUS.ORPHANED, id)
    return result.changes > 0
  }

  // --- 조회 ---

  getMessage(id) {
    const row = this.#db.prepare('SELECT * FROM a2a_messages WHERE id = ?').get(id)
    return row ? A2aQueueStore.#rowToMessage(row) : null
  }

  listByRecipient(toAgentId, { status } = {}) {
    const stmt = status
      ? this.#db.prepare('SELECT * FROM a2a_messages WHERE to_agent_id = ? AND status = ? ORDER BY created_at ASC')
      : this.#db.prepare('SELECT * FROM a2a_messages WHERE to_agent_id = ? ORDER BY created_at ASC')
    const rows = status ? stmt.all(toAgentId, status) : stmt.all(toAgentId)
    return rows.map(A2aQueueStore.#rowToMessage)
  }

  // 전체 status 별 조회 (S4 recovery 용). bounded batch 위해 limit 옵션 제공 — 미전달 시 무제한.
  listByStatus(status, { kind, limit } = {}) {
    const params = [status]
    let sql = 'SELECT * FROM a2a_messages WHERE status = ?'
    if (kind) { sql += ' AND kind = ?'; params.push(kind) }
    sql += ' ORDER BY created_at ASC'
    if (typeof limit === 'number' && limit > 0) { sql += ' LIMIT ?'; params.push(limit) }
    return this.#db.prepare(sql).all(...params).map(A2aQueueStore.#rowToMessage)
  }

  close() { this.#db.close() }

  static #rowToMessage(row) {
    return {
      id: row.id,
      fromAgentId: row.from_agent_id,
      toAgentId: row.to_agent_id,
      kind: row.kind,
      correlationId: row.correlation_id,
      category: row.category,
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
