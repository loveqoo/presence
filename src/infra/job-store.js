import Database from 'better-sqlite3'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

// --- JobStore ---
// SQLite 기반 Job 정의 + 실행 이력 저장소.
// better-sqlite3 (동기 API) — Actor 큐 내에서 호출하므로 동기 OK.

const HISTORY_MAX_PER_JOB = 50
const HISTORY_TTL_DAYS = 90

const createJobStore = (dbPath) => {
  const dir = dbPath.split('/').slice(0, -1).join('/')
  if (dir) mkdirSync(dir, { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      prompt        TEXT NOT NULL,
      cron          TEXT NOT NULL,
      enabled       INTEGER DEFAULT 1,
      max_retries   INTEGER DEFAULT 3,
      allowed_tools TEXT DEFAULT '[]',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      next_run      INTEGER
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
  `)

  // --- Job CRUD ---

  const createJob = ({ name, prompt, cron, maxRetries = 3, allowedTools = [], nextRun = null }) => {
    const now = Date.now()
    const id = randomUUID()
    db.prepare(`
      INSERT INTO jobs (id, name, prompt, cron, enabled, max_retries, allowed_tools, created_at, updated_at, next_run)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(id, name, prompt, cron, maxRetries, JSON.stringify(allowedTools), now, now, nextRun)
    return getJob(id)
  }

  const getJob = (id) => {
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
    return row ? rowToJob(row) : null
  }

  const listJobs = () =>
    db.prepare('SELECT * FROM jobs ORDER BY created_at ASC').all().map(rowToJob)

  const updateJob = (id, fields) => {
    const allowed = ['name', 'prompt', 'cron', 'enabled', 'max_retries', 'allowed_tools', 'next_run']
    const updates = Object.entries(fields).filter(([k]) => allowed.includes(k))
    if (updates.length === 0) return getJob(id)
    const setClauses = [...updates.map(([k]) => `${k} = ?`), 'updated_at = ?'].join(', ')
    const values = [...updates.map(([, v]) => v), Date.now(), id]
    db.prepare(`UPDATE jobs SET ${setClauses} WHERE id = ?`).run(...values)
    return getJob(id)
  }

  const deleteJob = (id) => {
    db.prepare('DELETE FROM jobs WHERE id = ?').run(id)
  }

  // 다음 실행이 필요한 Job 목록 (enabled=1, next_run <= now)
  const getDueJobs = (now = Date.now()) =>
    db.prepare(`
      SELECT * FROM jobs WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?
      ORDER BY next_run ASC
    `).all(now).map(rowToJob)

  // --- Job Runs ---

  const startRun = (jobId, attempt = 1) => {
    const now = Date.now()
    const id = randomUUID()
    const expireAt = now + HISTORY_TTL_DAYS * 86_400_000
    db.prepare(`
      INSERT INTO job_runs (id, job_id, started_at, status, attempt, expire_at)
      VALUES (?, ?, ?, 'running', ?, ?)
    `).run(id, jobId, now, attempt, expireAt)
    return id
  }

  const finishRun = (runId, { status, result = null, error = null, jobId = null }) => {
    db.prepare(`
      UPDATE job_runs SET finished_at = ?, status = ?, result = ?, error = ?
      WHERE id = ?
    `).run(Date.now(), status, result, error, runId)
    // 최근 HISTORY_MAX_PER_JOB개 초과분 삭제
    const resolvedJobId = jobId ?? db.prepare('SELECT job_id FROM job_runs WHERE id = ?').get(runId)?.job_id
    if (resolvedJobId) trimHistory(resolvedJobId)
  }

  const getRunHistory = (jobId, limit = 20) =>
    db.prepare(`
      SELECT * FROM job_runs WHERE job_id = ?
      ORDER BY started_at DESC LIMIT ?
    `).all(jobId, limit).map(rowToRun)

  const getRunningJobs = () =>
    db.prepare(`
      SELECT j.*, r.id as run_id, r.attempt
      FROM jobs j JOIN job_runs r ON j.id = r.job_id
      WHERE r.status = 'running'
    `).all()

  // --- 정리 ---

  const trimHistory = (jobId) => {
    const ids = db.prepare(`
      SELECT id FROM job_runs WHERE job_id = ?
      ORDER BY started_at DESC LIMIT -1 OFFSET ?
    `).all(jobId, HISTORY_MAX_PER_JOB).map(r => r.id)
    if (ids.length > 0) {
      db.prepare(`DELETE FROM job_runs WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
    }
  }

  const cleanupExpired = () => {
    const now = Date.now()
    const { changes } = db.prepare('DELETE FROM job_runs WHERE expire_at < ?').run(now)
    return changes
  }

  const close = () => db.close()

  return {
    createJob, getJob, listJobs, updateJob, deleteJob,
    getDueJobs, startRun, finishRun, getRunHistory,
    getRunningJobs, cleanupExpired, close,
  }
}

// --- row → domain object ---

const rowToJob = (row) => ({
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
})

const rowToRun = (row) => ({
  id: row.id,
  jobId: row.job_id,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  status: row.status,
  result: row.result,
  error: row.error,
  attempt: row.attempt,
})

const defaultJobDbPath = (memoryPath) =>
  join(memoryPath, 'jobs.db')

export { createJobStore, defaultJobDbPath }
