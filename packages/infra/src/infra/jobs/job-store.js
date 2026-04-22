import Database from 'better-sqlite3'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import fp from '@presence/core/lib/fun-fp.js'
import { JOB } from '@presence/core/core/policies.js'

const { Reader } = fp

// --- JobStore ---
// SQLite 기반 Job 정의 + 실행 이력 저장소.
// better-sqlite3 (동기 API) — Actor 큐 내에서 호출하므로 동기 OK.

// Schema version — PRAGMA user_version 으로 관리 (docs/design/agent-identity-model.md §12.1 M7)
// v0 = legacy (owner 필드 없음), v1 = owner_user_id + owner_agent_id 추가.
const SCHEMA_VERSION = 1

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    prompt         TEXT NOT NULL,
    cron           TEXT NOT NULL,
    enabled        INTEGER DEFAULT 1,
    max_retries    INTEGER DEFAULT 3,
    allowed_tools  TEXT DEFAULT '[]',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    next_run       INTEGER,
    owner_user_id  TEXT,
    owner_agent_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_next_run ON jobs(next_run) WHERE enabled = 1;

  CREATE TABLE IF NOT EXISTS job_runs (
    id          TEXT PRIMARY KEY,
    job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    status      TEXT NOT NULL,
    result      TEXT,
    error       TEXT,
    attempt     INTEGER DEFAULT 1,
    expire_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_job_runs_job_id ON job_runs(job_id);
`

const UPDATABLE_FIELDS = ['name', 'prompt', 'cron', 'enabled', 'max_retries', 'allowed_tools', 'next_run', 'owner_user_id', 'owner_agent_id']

class JobStore {
  #db

  constructor(dbPath) {
    const dir = dbPath.split('/').slice(0, -1).join('/')
    if (dir) mkdirSync(dir, { recursive: true })
    this.#db = new Database(dbPath)
    this.#db.pragma('journal_mode = WAL')
    this.#db.pragma('foreign_keys = ON')
    this.#migrate()
  }

  // PRAGMA user_version 기반 idempotent schema migration.
  //   v0 → v1: owner_user_id + owner_agent_id 컬럼 추가. 기존 row 는 null 유지 (legacy).
  //
  // Legacy row (owner=null) 는 scheduler-factory 가 'default' fallback 으로 처리한다.
  // 신규 job 은 createJob 에서 owner 필수 → null 유입 금지.
  #migrate() {
    const current = this.#db.pragma('user_version', { simple: true })

    if (current === 0) {
      // 새 DB 또는 legacy. 먼저 SCHEMA 실행 — 새 DB 는 즉시 완성.
      this.#db.exec(SCHEMA)
      // legacy 에는 jobs 가 이미 있으나 CREATE TABLE IF NOT EXISTS 는 skip.
      // owner 컬럼이 없으면 ALTER TABLE 로 추가.
      const cols = this.#db.prepare("PRAGMA table_info(jobs)").all().map(c => c.name)
      if (!cols.includes('owner_user_id')) {
        this.#db.exec('ALTER TABLE jobs ADD COLUMN owner_user_id TEXT')
      }
      if (!cols.includes('owner_agent_id')) {
        this.#db.exec('ALTER TABLE jobs ADD COLUMN owner_agent_id TEXT')
      }
      this.#db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_owner_user ON jobs(owner_user_id)')
      this.#db.pragma(`user_version = ${SCHEMA_VERSION}`)
    }
    // 추가 버전은 이곳에 if (current === N) { ... } 로 append.
  }

  // --- Job CRUD ---

  createJob(opts) {
    const { name, prompt, cron, maxRetries = 3, allowedTools = [], nextRun = null, ownerUserId, ownerAgentId } = opts
    if (!ownerUserId || !ownerAgentId) {
      throw new Error('createJob: ownerUserId + ownerAgentId required (docs §4.3)')
    }
    const now = Date.now()
    const id = randomUUID()
    this.#db.prepare(`
      INSERT INTO jobs (id, name, prompt, cron, enabled, max_retries, allowed_tools, created_at, updated_at, next_run, owner_user_id, owner_agent_id)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, prompt, cron, maxRetries, JSON.stringify(allowedTools), now, now, nextRun, ownerUserId, ownerAgentId)
    return this.getJob(id)
  }

  getJob(id) {
    const row = this.#db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
    return row ? JobStore.#rowToJob(row) : null
  }

  listJobs() {
    return this.#db.prepare('SELECT * FROM jobs ORDER BY created_at ASC').all().map(JobStore.#rowToJob)
  }

  updateJob(id, fields) {
    const updates = Object.entries(fields).filter(([key]) => UPDATABLE_FIELDS.includes(key))
    if (updates.length === 0) return this.getJob(id)
    const setClauses = [...updates.map(([key]) => `${key} = ?`), 'updated_at = ?'].join(', ')
    const values = [...updates.map(([, val]) => val), Date.now(), id]
    this.#db.prepare(`UPDATE jobs SET ${setClauses} WHERE id = ?`).run(...values)
    return this.getJob(id)
  }

  deleteJob(id) {
    this.#db.prepare('DELETE FROM jobs WHERE id = ?').run(id)
  }

  // 다음 실행이 필요한 Job 목록 (enabled=1, next_run <= now)
  getDueJobs(now = Date.now()) {
    return this.#db.prepare(`
      SELECT * FROM jobs WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?
      ORDER BY next_run ASC
    `).all(now).map(JobStore.#rowToJob)
  }

  // --- Job Runs ---

  startRun(jobId, attempt = 1) {
    const now = Date.now()
    const id = randomUUID()
    const expireAt = now + JOB.HISTORY_TTL_DAYS * 86_400_000
    this.#db.prepare(`
      INSERT INTO job_runs (id, job_id, started_at, status, attempt, expire_at)
      VALUES (?, ?, ?, 'running', ?, ?)
    `).run(id, jobId, now, attempt, expireAt)
    return id
  }

  finishRun(runId, { status, result = null, error = null, jobId = null }) {
    this.#db.prepare(`
      UPDATE job_runs SET finished_at = ?, status = ?, result = ?, error = ?
      WHERE id = ?
    `).run(Date.now(), status, result, error, runId)
    // 최근 JOB.HISTORY_MAX_PER_JOB개 초과분 삭제
    const resolvedJobId = jobId ?? this.#db.prepare('SELECT job_id FROM job_runs WHERE id = ?').get(runId)?.job_id
    if (resolvedJobId) this.#trimHistory(resolvedJobId)
  }

  getRunHistory(jobId, limit = 20) {
    return this.#db.prepare(`
      SELECT * FROM job_runs WHERE job_id = ?
      ORDER BY started_at DESC LIMIT ?
    `).all(jobId, limit).map(JobStore.#rowToRun)
  }

  getRunningJobs() {
    return this.#db.prepare(`
      SELECT j.*, r.id as run_id, r.attempt
      FROM jobs j JOIN job_runs r ON j.id = r.job_id
      WHERE r.status = 'running'
    `).all()
  }

  // --- 정리 ---

  #trimHistory(jobId) {
    const ids = this.#db.prepare(`
      SELECT id FROM job_runs WHERE job_id = ?
      ORDER BY started_at DESC LIMIT -1 OFFSET ?
    `).all(jobId, JOB.HISTORY_MAX_PER_JOB).map(row => row.id)
    if (ids.length > 0) {
      this.#db.prepare(`DELETE FROM job_runs WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
    }
  }

  cleanupExpired() {
    const now = Date.now()
    const { changes } = this.#db.prepare('DELETE FROM job_runs WHERE expire_at < ?').run(now)
    return changes
  }

  close() { this.#db.close() }

  // --- row → domain object ---

  static #rowToJob(row) {
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      cron: row.cron,
      enabled: row.enabled === 1,
      maxRetries: row.max_retries,
      allowedTools: JSON.parse(row.allowed_tools || '[]'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nextRun: row.next_run,
      ownerUserId: row.owner_user_id || null,
      ownerAgentId: row.owner_agent_id || null,
    }
  }

  static #rowToRun(row) {
    return {
      id: row.id,
      jobId: row.job_id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      status: row.status,
      result: row.result,
      error: row.error,
      attempt: row.attempt,
    }
  }
}

const createJobStoreR = Reader.asks(({ dbPath }) => new JobStore(dbPath))

// 레거시 브릿지
const createJobStore = (dbPath) => createJobStoreR.run({ dbPath })

const defaultJobDbPath = (memoryPath) =>
  join(memoryPath, 'jobs.db')

export { JobStore, createJobStoreR, createJobStore, defaultJobDbPath }
