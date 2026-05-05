import Database from 'better-sqlite3'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import fp from '@presence/core/lib/fun-fp.js'

const { Reader } = fp

// =============================================================================
// A2aRelationshipStore — A2A Phase 2 (KG-37) 영속 관계 컨테이너
//
// 두 에이전트 쌍의 영속 1:1 관계 컨테이너 메타를 저장한다.
// agent-session.md 의 모델 B (세션 = 영속 관계 컨테이너, 만남 = request/response
// 페어) 를 받친다. 만남별 메시지는 A2aQueueStore (a2a_messages) 가 담당 — 본
// store 는 두 에이전트 쌍의 *관계 메타* 만 보관 (카드 교환 이력 / 만남 카운트 /
// clear/summarize 이력 / close 상태).
//
// 경로: ~/.presence/users/{u}/memory/a2a-relationships.db (a2a-queue.db 와 같은
// 디렉토리). 별 db 분리 — A2aQueueStore 와 트랜잭션 결합 없음 (관계 메타와
// 큐 메시지는 lifecycle 다름).
//
// PK: (local_agent_id, peer_agent_id) — 두 에이전트 쌍은 1:1 고정 (모델 B).
// 같은 쌍에 두 번째 만남이 와도 같은 row 재사용.
//
// **호출 계약 (Phase 3 wiring 책임)**: 본 store 는 정책 인식이 없다. 호출처
// (a2a-router 카드 교환 wire 등) 는 `canStartA2aSession({ allow: true })` 평가
// 통과 후에만 `upsertOnFirstMeeting` 을 호출해야 한다. deny 평가 후 row 가
// 저장되면 정책 위반 흔적이 영속 — Phase 3 통합 시 정적 grep 으로 강제 예정.
// =============================================================================

const SCHEMA_VERSION = 1

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS a2a_relationships (
    local_agent_id   TEXT NOT NULL,
    peer_agent_id    TEXT NOT NULL,
    peer_card        TEXT,
    local_card       TEXT,
    created_at       INTEGER NOT NULL,
    last_meeting_at  INTEGER,
    status           TEXT NOT NULL,
    closed_at        INTEGER,
    history_events   TEXT NOT NULL DEFAULT '[]',
    meeting_count    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (local_agent_id, peer_agent_id)
  );
  CREATE INDEX IF NOT EXISTS idx_a2a_rel_local ON a2a_relationships(local_agent_id);
  CREATE INDEX IF NOT EXISTS idx_a2a_rel_status ON a2a_relationships(status);
`

// 관계 status — agent-session.md §종료 단계 의 close 상태 매핑.
// active: 첫 만남 후 정상. closed: 사용자가 명시적으로 폐기.
// clear / summarize 는 status 변경 없이 history_events 에 누적 (관계는 살아있음).
const RELATIONSHIP_STATUS = Object.freeze({
  ACTIVE: 'active',
  CLOSED: 'closed',
})

// history_events 의 type 분류. agent-session.md §세션 종료 단계 (close/clear/summarize)
// 에서 close 는 status='closed' 와 함께 'closed' 이벤트도 기록 (양쪽 단일 진실 원천).
const HISTORY_EVENT_TYPE = Object.freeze({
  CARD_REFRESHED: 'card-refreshed',
  CLEARED:        'cleared',
  SUMMARIZED:     'summarized',
  CLOSED:         'closed',
})

const VALID_HISTORY_TYPES = new Set(Object.values(HISTORY_EVENT_TYPE))
const VALID_STATUSES = new Set(Object.values(RELATIONSHIP_STATUS))

// 모든 mutator 의 공통 ID 검증 — 빈 문자열/공백 only/non-string 차단.
// composite PK (local_agent_id, peer_agent_id) 의 무결성 보호.
const assertAgentIds = (fn, localAgentId, peerAgentId) => {
  if (typeof localAgentId !== 'string' || localAgentId.trim() === '') {
    throw new Error(`${fn}: localAgentId required (non-empty string)`)
  }
  if (typeof peerAgentId !== 'string' || peerAgentId.trim() === '') {
    throw new Error(`${fn}: peerAgentId required (non-empty string)`)
  }
}

class A2aRelationshipStore {
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
  //   0 → 1: 신규 DB. SCHEMA 로 a2a_relationships 테이블 생성.
  #migrate() {
    const current = this.#db.pragma('user_version', { simple: true })
    if (current === 0) {
      this.#db.exec(SCHEMA)
      this.#db.pragma(`user_version = ${SCHEMA_VERSION}`)
    }
  }

  // 첫 만남 시 lazy create. 이미 row 있으면 no-op (관계 영속). insertedNew 반환으로
  // 호출자가 카드 교환 / audit 분기 판단.
  // 카드 인자 (peerCard/localCard) 는 *최초 INSERT 에만* 사용. 두 번째 호출부터는
  // 무시된다 — 카드 갱신은 refreshCards 가 별 책임. 시그니처에 인자가 있어도
  // 두 번째 호출에 새 카드가 적용 안 됨을 호출자가 인지해야 함.
  upsertOnFirstMeeting({ localAgentId, peerAgentId, peerCard = null, localCard = null }) {
    assertAgentIds('upsertOnFirstMeeting', localAgentId, peerAgentId)
    const existing = this.getRelationship({ localAgentId, peerAgentId })
    if (existing) return { insertedNew: false, relationship: existing }
    const now = Date.now()
    this.#db.prepare(`
      INSERT INTO a2a_relationships
        (local_agent_id, peer_agent_id, peer_card, local_card, created_at, status, history_events, meeting_count)
        VALUES (?, ?, ?, ?, ?, ?, '[]', 0)
    `).run(
      localAgentId, peerAgentId,
      peerCard === null ? null : JSON.stringify(peerCard),
      localCard === null ? null : JSON.stringify(localCard),
      now, RELATIONSHIP_STATUS.ACTIVE,
    )
    return { insertedNew: true, relationship: this.getRelationship({ localAgentId, peerAgentId }) }
  }

  getRelationship({ localAgentId, peerAgentId }) {
    if (!localAgentId || !peerAgentId) return null
    const row = this.#db.prepare(
      'SELECT * FROM a2a_relationships WHERE local_agent_id = ? AND peer_agent_id = ?',
    ).get(localAgentId, peerAgentId)
    return row ? A2aRelationshipStore.#rowToObject(row) : null
  }

  listForLocal({ localAgentId, status } = {}) {
    // codex round 2 — mutator 와 일관성 (whitespace/non-string ID fail-fast)
    if (typeof localAgentId !== 'string' || localAgentId.trim() === '') {
      throw new Error('listForLocal: localAgentId required (non-empty string)')
    }
    if (status !== undefined && !VALID_STATUSES.has(status)) {
      throw new Error(`listForLocal: invalid status '${status}' (valid: ${[...VALID_STATUSES].join('|')})`)
    }
    // 보조 정렬 키 peer_agent_id — 같은 ms 에 INSERT 된 두 row 의 결정적 순서.
    const stmt = status
      ? this.#db.prepare('SELECT * FROM a2a_relationships WHERE local_agent_id = ? AND status = ? ORDER BY created_at ASC, peer_agent_id ASC')
      : this.#db.prepare('SELECT * FROM a2a_relationships WHERE local_agent_id = ? ORDER BY created_at ASC, peer_agent_id ASC')
    const rows = status ? stmt.all(localAgentId, status) : stmt.all(localAgentId)
    return rows.map(A2aRelationshipStore.#rowToObject)
  }

  // 만남이 일어날 때마다 호출. last_meeting_at 갱신 + meeting_count 증가.
  // 반환 의미 분기:
  //   - row 없음 → false (caller 가 upsertOnFirstMeeting 후 재시도. race 보호).
  //   - status='closed' → throw (관계 명시적 폐기 후 만남 시도는 caller bug —
  //     fail-fast 로 무한 retry 루프 방지). agent-session.md §종료 단계 참조.
  //   - status='active' UPDATE 성공 → true.
  recordMeeting({ localAgentId, peerAgentId }) {
    assertAgentIds('recordMeeting', localAgentId, peerAgentId)
    const now = Date.now()
    const tx = this.#db.transaction(() => {
      const row = this.#db.prepare(
        'SELECT status FROM a2a_relationships WHERE local_agent_id = ? AND peer_agent_id = ?',
      ).get(localAgentId, peerAgentId)
      if (!row) return false
      if (row.status === RELATIONSHIP_STATUS.CLOSED) {
        const err = new Error(`recordMeeting: relationship closed (${localAgentId} ↔ ${peerAgentId}) — reopen 또는 upsertOnFirstMeeting 필요 없음`)
        err.code = 'RELATIONSHIP_CLOSED'
        throw err
      }
      this.#db.prepare(`
        UPDATE a2a_relationships
           SET last_meeting_at = ?, meeting_count = meeting_count + 1
         WHERE local_agent_id = ? AND peer_agent_id = ? AND status = ?
      `).run(now, localAgentId, peerAgentId, RELATIONSHIP_STATUS.ACTIVE)
      return true
    })
    return tx()
  }

  // history_events 에 이벤트 push. type 화이트리스트 검증.
  // closed 이벤트는 closeRelationship 가 트랜잭션 내부에서 수행 — 직접 호출 안 함.
  recordHistoryEvent({ localAgentId, peerAgentId, type, summary = null }) {
    assertAgentIds('recordHistoryEvent', localAgentId, peerAgentId)
    if (!VALID_HISTORY_TYPES.has(type)) {
      throw new Error(`recordHistoryEvent: invalid type '${type}' (valid: ${[...VALID_HISTORY_TYPES].join('|')})`)
    }
    return this.#appendHistoryEvent(localAgentId, peerAgentId, { type, summary, at: Date.now() })
  }

  // 관계 폐기 — status='closed', closed_at 기록 + history_events 에 closed 이벤트 push.
  // 트랜잭션 안에서 두 변경 원자화 — caller 가 두 번 호출할 필요 없음.
  closeRelationship({ localAgentId, peerAgentId, summary = null }) {
    assertAgentIds('closeRelationship', localAgentId, peerAgentId)
    const now = Date.now()
    const tx = this.#db.transaction(() => {
      const row = this.#db.prepare(
        'SELECT history_events, status FROM a2a_relationships WHERE local_agent_id = ? AND peer_agent_id = ?',
      ).get(localAgentId, peerAgentId)
      if (!row) return false
      if (row.status === RELATIONSHIP_STATUS.CLOSED) return false
      const events = JSON.parse(row.history_events || '[]')
      events.push({ type: HISTORY_EVENT_TYPE.CLOSED, at: now, summary })
      this.#db.prepare(`
        UPDATE a2a_relationships
           SET status = ?, closed_at = ?, history_events = ?
         WHERE local_agent_id = ? AND peer_agent_id = ?
      `).run(RELATIONSHIP_STATUS.CLOSED, now, JSON.stringify(events), localAgentId, peerAgentId)
      return true
    })
    return tx()
  }

  // 카드 갱신 (peer/local). 카드 메타 변경 시 호출. 관계 active/closed 무관.
  // peerCard / localCard 의미 분기:
  //   - undefined (인자 미전달) → 해당 컬럼 변경 안 함
  //   - null (명시 전달) → 컬럼 NULL 설정 (카드 unset)
  //   - 객체 → JSON.stringify 후 저장
  refreshCards({ localAgentId, peerAgentId, peerCard, localCard }) {
    assertAgentIds('refreshCards', localAgentId, peerAgentId)
    if (peerCard === undefined && localCard === undefined) {
      throw new Error('refreshCards: peerCard 또는 localCard 중 최소 하나 필요')
    }
    const tx = this.#db.transaction(() => {
      const existing = this.getRelationship({ localAgentId, peerAgentId })
      if (!existing) return false
      const fields = []
      const params = []
      if (peerCard !== undefined) {
        fields.push('peer_card = ?')
        params.push(peerCard === null ? null : JSON.stringify(peerCard))
      }
      if (localCard !== undefined) {
        fields.push('local_card = ?')
        params.push(localCard === null ? null : JSON.stringify(localCard))
      }
      params.push(localAgentId, peerAgentId)
      this.#db.prepare(`
        UPDATE a2a_relationships SET ${fields.join(', ')}
         WHERE local_agent_id = ? AND peer_agent_id = ?
      `).run(...params)
      this.#appendHistoryEvent(localAgentId, peerAgentId, {
        type: HISTORY_EVENT_TYPE.CARD_REFRESHED,
        at: Date.now(),
        summary: null,
      })
      return true
    })
    return tx()
  }

  close() { this.#db.close() }

  // history_events 배열에 이벤트 push (트랜잭션 안전: SELECT → JSON parse → push → JSON stringify → UPDATE).
  #appendHistoryEvent(localAgentId, peerAgentId, event) {
    const tx = this.#db.transaction(() => {
      const row = this.#db.prepare(
        'SELECT history_events FROM a2a_relationships WHERE local_agent_id = ? AND peer_agent_id = ?',
      ).get(localAgentId, peerAgentId)
      if (!row) return false
      const events = JSON.parse(row.history_events || '[]')
      events.push(event)
      this.#db.prepare(`
        UPDATE a2a_relationships SET history_events = ?
         WHERE local_agent_id = ? AND peer_agent_id = ?
      `).run(JSON.stringify(events), localAgentId, peerAgentId)
      return true
    })
    return tx()
  }

  static #rowToObject(row) {
    return {
      localAgentId:   row.local_agent_id,
      peerAgentId:    row.peer_agent_id,
      peerCard:       row.peer_card === null ? null : JSON.parse(row.peer_card),
      localCard:      row.local_card === null ? null : JSON.parse(row.local_card),
      createdAt:      row.created_at,
      lastMeetingAt:  row.last_meeting_at,
      status:         row.status,
      closedAt:       row.closed_at,
      historyEvents:  JSON.parse(row.history_events || '[]'),
      meetingCount:   row.meeting_count,
    }
  }
}

const createA2aRelationshipStoreR = Reader.asks(({ dbPath }) => new A2aRelationshipStore(dbPath))
const createA2aRelationshipStore = (dbPath) => createA2aRelationshipStoreR.run({ dbPath })
const defaultA2aRelationshipDbPath = (memoryPath) => join(memoryPath, 'a2a-relationships.db')

export {
  A2aRelationshipStore,
  createA2aRelationshipStoreR,
  createA2aRelationshipStore,
  defaultA2aRelationshipDbPath,
  RELATIONSHIP_STATUS,
  HISTORY_EVENT_TYPE,
}
