import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { createA2aQueueStore, TODO_STATUS, TODO_KIND } from '@presence/infra/infra/a2a/a2a-queue-store.js'
import { A2A } from '@presence/core/core/policies.js'
import { assert, summary } from '../../../test/lib/assert.js'

const makeTmpDir = () => {
  const dir = join(tmpdir(), `presence-a2a-queue-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const AGENT_A = 'alice/planner'
const AGENT_B = 'alice/worker'

const run = async () => {
  console.log('A2aQueueStore unit tests')

  // AQ1. enqueueRequest → getMessage 왕복, status='pending'
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const msg = store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: '조사 부탁' })
    assert(msg.id, 'AQ1: id 발급')
    assert(msg.fromAgentId === AGENT_A, 'AQ1: from round-trip')
    assert(msg.toAgentId === AGENT_B, 'AQ1: to round-trip')
    assert(msg.kind === TODO_KIND.REQUEST, 'AQ1: kind=request')
    assert(msg.status === TODO_STATUS.PENDING, 'AQ1: status=pending')
    assert(msg.payload === '조사 부탁', 'AQ1: payload round-trip')
    const fetched = store.getMessage(msg.id)
    assert(fetched.id === msg.id, 'AQ1: getMessage 일치')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // AQ2. markProcessing — pending → processing 성공, 재호출 false (멱등)
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const msg = store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: 'x' })

    assert(store.markProcessing(msg.id) === true, 'AQ2: 첫 markProcessing → true')
    const after = store.getMessage(msg.id)
    assert(after.status === TODO_STATUS.PROCESSING, 'AQ2: status=processing')
    assert(typeof after.processedAt === 'number', 'AQ2: processedAt 기록')

    assert(store.markProcessing(msg.id) === false, 'AQ2: 재호출 false (멱등)')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // AQ3. markCompleted — processing 상태에서만 true, pending/completed 에서 false
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const msg = store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: 'x' })

    assert(store.markCompleted(msg.id) === false, 'AQ3: pending → markCompleted false')
    store.markProcessing(msg.id)
    assert(store.markCompleted(msg.id) === true, 'AQ3: processing → markCompleted true')
    assert(store.getMessage(msg.id).status === TODO_STATUS.COMPLETED, 'AQ3: status=completed')
    assert(store.markCompleted(msg.id) === false, 'AQ3: completed → markCompleted false (재호출)')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // AQ4. markFailed — pending + processing 양쪽 허용, error 저장
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const pendingMsg = store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: 'p1' })
    const procMsg = store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: 'p2' })
    store.markProcessing(procMsg.id)

    assert(store.markFailed(pendingMsg.id, 'reason-a') === true, 'AQ4: pending → failed true')
    assert(store.markFailed(procMsg.id, 'reason-b') === true, 'AQ4: processing → failed true')
    assert(store.getMessage(pendingMsg.id).error === 'reason-a', 'AQ4: error round-trip (pending)')
    assert(store.getMessage(procMsg.id).error === 'reason-b', 'AQ4: error round-trip (processing)')
    // completed 상태는 markFailed 가 false
    const doneMsg = store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: 'p3' })
    store.markProcessing(doneMsg.id)
    store.markCompleted(doneMsg.id)
    assert(store.markFailed(doneMsg.id, 'too-late') === false, 'AQ4: completed → markFailed false')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // AQ5. listByRecipient status 필터
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const m1 = store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: 'a' })
    const m2 = store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: 'b' })
    store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: 'alice/other', payload: 'c' })
    store.markProcessing(m2.id)

    const all = store.listByRecipient(AGENT_B)
    assert(all.length === 2, 'AQ5: 전체 (2개)')
    const pendings = store.listByRecipient(AGENT_B, { status: TODO_STATUS.PENDING })
    assert(pendings.length === 1 && pendings[0].id === m1.id, 'AQ5: pending 필터')
    const processings = store.listByRecipient(AGENT_B, { status: TODO_STATUS.PROCESSING })
    assert(processings.length === 1 && processings[0].id === m2.id, 'AQ5: processing 필터')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // AQ6. schema migration — 빈 DB 에서 v2 생성 smoke (a2a_messages + category 컬럼)
  {
    const dir = makeTmpDir()
    const dbPath = join(dir, 'a2a.db')
    const store = createA2aQueueStore(dbPath)
    const { default: BetterSqlite } = await import('better-sqlite3')
    const ro = new BetterSqlite(dbPath, { readonly: true })
    const cols = ro.prepare('PRAGMA table_info(a2a_messages)').all().map(c => c.name)
    assert(cols.includes('id'), 'AQ6: id 컬럼')
    assert(cols.includes('to_agent_id'), 'AQ6: to_agent_id 컬럼')
    assert(cols.includes('status'), 'AQ6: status 컬럼')
    assert(cols.includes('category'), 'AQ6: category 컬럼')
    assert(ro.pragma('user_version', { simple: true }) === 2, 'AQ6: user_version=2')
    ro.close()
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // AQ7. close + 재개방 idempotent
  {
    const dir = makeTmpDir()
    const dbPath = join(dir, 'a2a.db')
    const s1 = createA2aQueueStore(dbPath)
    const m = s1.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: 'data' })
    s1.close()

    const s2 = createA2aQueueStore(dbPath)
    const fetched = s2.getMessage(m.id)
    assert(fetched !== null && fetched.payload === 'data', 'AQ7: 재개방 후 동일 데이터 조회')
    s2.close(); rmSync(dir, { recursive: true, force: true })
  }

  // --- S2 확장: response + expire ---

  // AQ8. enqueueResponse — kind='response', correlation_id 설정, status 즉시 final
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const req = store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: 'q' })
    const resp = store.enqueueResponse({
      correlationId: req.id, fromAgentId: AGENT_B, toAgentId: AGENT_A,
      payload: 'a', status: TODO_STATUS.COMPLETED,
    })
    assert(resp.kind === TODO_KIND.RESPONSE, 'AQ8: kind=response')
    assert(resp.correlationId === req.id, 'AQ8: correlationId round-trip')
    assert(resp.status === TODO_STATUS.COMPLETED, 'AQ8: status=completed')
    assert(resp.fromAgentId === AGENT_B && resp.toAgentId === AGENT_A, 'AQ8: from/to 역방향')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // AQ9. enqueueResponse — 모든 status 변형 허용 + 잘못된 status 거부
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const req = store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: 'x' })
    const base = { correlationId: req.id, fromAgentId: AGENT_B, toAgentId: AGENT_A, payload: 'x' }
    for (const status of [TODO_STATUS.COMPLETED, TODO_STATUS.FAILED, TODO_STATUS.EXPIRED, TODO_STATUS.ORPHANED]) {
      const r = store.enqueueResponse({ ...base, status })
      assert(r.status === status, `AQ9: status=${status} 허용`)
    }
    let thrown = null
    try { store.enqueueResponse({ ...base, status: TODO_STATUS.PENDING }) } catch (e) { thrown = e }
    assert(thrown !== null, 'AQ9: status=pending 거부 (response 는 final 만)')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // AQ10. listExpired — pending/processing 중 timeout 초과만. 타 status 제외.
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const now = Date.now()

    // 만든 후 created_at 수동 조작 — raw SQL
    const { default: BetterSqlite } = await import('better-sqlite3')
    const db = new BetterSqlite(join(dir, 'a2a.db'))

    const pendingExpired = store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: 'p1', timeoutMs: 1000 })
    db.prepare('UPDATE a2a_messages SET created_at = ? WHERE id = ?').run(now - 2000, pendingExpired.id)

    const processingExpired = store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: 'p2', timeoutMs: 1000 })
    db.prepare('UPDATE a2a_messages SET created_at = ?, status = ? WHERE id = ?').run(now - 2000, TODO_STATUS.PROCESSING, processingExpired.id)

    const pendingFresh = store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: 'fresh', timeoutMs: 1000 })
    const completedOld = store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: 'done', timeoutMs: 1000 })
    db.prepare('UPDATE a2a_messages SET created_at = ?, status = ? WHERE id = ?').run(now - 2000, TODO_STATUS.COMPLETED, completedOld.id)

    db.close()

    const expired = store.listExpired(now)
    const expiredIds = expired.map(m => m.id).sort()
    const expectedIds = [pendingExpired.id, processingExpired.id].sort()
    assert(expiredIds.length === 2, `AQ10: 2 개 만료 (got ${expiredIds.length})`)
    assert(JSON.stringify(expiredIds) === JSON.stringify(expectedIds), 'AQ10: pending/processing 만 포함')
    assert(!expired.some(m => m.id === pendingFresh.id), 'AQ10: fresh 제외')
    assert(!expired.some(m => m.id === completedOld.id), 'AQ10: completed 제외')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // AQ11. listExpired — timeout_ms null 인 row 는 A2A.DEFAULT_TIMEOUT_MS 적용
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const now = Date.now()
    const msg = store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: 'x' /* timeoutMs 생략 */ })

    const { default: BetterSqlite } = await import('better-sqlite3')
    const db = new BetterSqlite(join(dir, 'a2a.db'))
    // created_at 을 DEFAULT_TIMEOUT_MS + 1000 이전으로 설정
    db.prepare('UPDATE a2a_messages SET created_at = ? WHERE id = ?').run(now - (A2A.DEFAULT_TIMEOUT_MS + 1000), msg.id)
    db.close()

    const expired = store.listExpired(now)
    assert(expired.length === 1 && expired[0].id === msg.id, 'AQ11: null timeout_ms → DEFAULT_TIMEOUT_MS 적용')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // AQ12. markExpired / markOrphaned 멱등 + 상태 전이
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const req = store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: 'x' })

    // pending → expired
    assert(store.markExpired(req.id) === true, 'AQ12: pending → expired true')
    assert(store.getMessage(req.id).status === TODO_STATUS.EXPIRED, 'AQ12: status=expired')
    // 재호출 false (멱등)
    assert(store.markExpired(req.id) === false, 'AQ12: expired → markExpired false (멱등)')
    // completed 상태에서는 false
    const req2 = store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: 'y' })
    store.markProcessing(req2.id)
    store.markCompleted(req2.id)
    assert(store.markExpired(req2.id) === false, 'AQ12: completed → markExpired false (race 방지)')

    // response row 의 markOrphaned
    const resp = store.enqueueResponse({
      correlationId: req.id, fromAgentId: AGENT_B, toAgentId: AGENT_A,
      payload: '', status: TODO_STATUS.COMPLETED,
    })
    assert(store.markOrphaned(resp.id) === true, 'AQ12: completed response → orphaned true')
    assert(store.getMessage(resp.id).status === TODO_STATUS.ORPHANED, 'AQ12: response status=orphaned')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // --- Category 필드 (v2) ---

  // AQ-cat1. enqueueRequest 기본 category='todo' 저장
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const msg = store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: 'q' })
    assert(msg.category === 'todo', 'AQ-cat1: 기본 category=todo')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // AQ-cat2. enqueueRequest / enqueueResponse category override
  {
    const dir = makeTmpDir()
    const store = createA2aQueueStore(join(dir, 'a2a.db'))
    const req = store.enqueueRequest({ fromAgentId: AGENT_A, toAgentId: AGENT_B, payload: 'q', category: 'question' })
    assert(req.category === 'question', 'AQ-cat2: request category=question')
    const resp = store.enqueueResponse({
      correlationId: req.id, fromAgentId: AGENT_B, toAgentId: AGENT_A,
      payload: 'a', status: TODO_STATUS.COMPLETED,
    }, { category: 'question' })
    assert(resp.category === 'question', 'AQ-cat2: response category=question (요청과 동일 분류 유지)')
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  // AQ-cat3. migration v1 → v2 — ALTER TABLE RENAME + ADD COLUMN + DEFAULT 'todo' 백필
  {
    const dir = makeTmpDir()
    const dbPath = join(dir, 'a2a.db')
    const { default: BetterSqlite } = await import('better-sqlite3')

    // v1 스키마를 수동 생성 — todo_messages 테이블 + category 컬럼 없음
    const legacy = new BetterSqlite(dbPath)
    legacy.pragma('journal_mode = WAL')
    legacy.exec(`
      CREATE TABLE todo_messages (
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
    `)
    const legacyId = 'legacy-id-1'
    legacy.prepare(`
      INSERT INTO todo_messages (id, from_agent_id, to_agent_id, kind, payload, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(legacyId, AGENT_A, AGENT_B, 'request', 'legacy-payload', 'pending', Date.now())
    legacy.pragma('user_version = 1')
    legacy.close()

    // createA2aQueueStore 가 v1→v2 migration 을 자동 실행
    const store = createA2aQueueStore(dbPath)
    const migrated = store.getMessage(legacyId)
    assert(migrated !== null, 'AQ-cat3: legacy row 조회 가능')
    assert(migrated.payload === 'legacy-payload', 'AQ-cat3: legacy payload 보존')
    assert(migrated.category === 'todo', 'AQ-cat3: category DEFAULT todo 백필')

    const ro = new BetterSqlite(dbPath, { readonly: true })
    assert(ro.pragma('user_version', { simple: true }) === 2, 'AQ-cat3: user_version=2')
    const tables = ro.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name)
    assert(tables.includes('a2a_messages'), 'AQ-cat3: a2a_messages 테이블 존재')
    assert(!tables.includes('todo_messages'), 'AQ-cat3: todo_messages 테이블 사라짐')
    ro.close()
    store.close(); rmSync(dir, { recursive: true, force: true })
  }

  summary()
}

run().catch(err => { console.error(err); process.exit(1) })
