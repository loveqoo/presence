// A2A Phase 2 (KG-37) — A2aRelationshipStore 단위 테스트.
// 영속 관계 컨테이너 메타 저장 검증. 격리 tmpdir + DB close.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  A2aRelationshipStore,
  createA2aRelationshipStore,
  defaultA2aRelationshipDbPath,
  RELATIONSHIP_STATUS,
  HISTORY_EVENT_TYPE,
} from '@presence/infra/infra/a2a/a2a-relationship-store.js'
import { assert, summary } from '../../../test/lib/assert.js'

console.log('A2aRelationshipStore tests (Phase 2 / KG-37)')

const createTmpStore = () => {
  const dir = join(tmpdir(), `a2a-rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  const store = createA2aRelationshipStore(defaultA2aRelationshipDbPath(dir))
  return {
    store,
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

// RS1 — defaultA2aRelationshipDbPath 가 memoryPath 기준 a2a-relationships.db
{
  const path = defaultA2aRelationshipDbPath('/tmp/foo/memory')
  assert(path === '/tmp/foo/memory/a2a-relationships.db', `RS1: db path (got ${path})`)
}

// RS2 — upsertOnFirstMeeting 첫 호출 → insertedNew=true + active 관계
{
  const { store, cleanup } = createTmpStore()
  const peerCard = { name: 'B', persona: 'helpful' }
  const r = store.upsertOnFirstMeeting({
    localAgentId: 'anthony/default', peerAgentId: 'remote/bot', peerCard,
  })
  assert(r.insertedNew === true, 'RS2: 첫 만남 insertedNew=true')
  assert(r.relationship.status === RELATIONSHIP_STATUS.ACTIVE, 'RS2: 신규 관계 status=active')
  assert(r.relationship.peerCard.name === 'B', 'RS2: peerCard JSON 복원')
  assert(r.relationship.meetingCount === 0, 'RS2: 신규 meetingCount=0 (recordMeeting 전)')
  assert(Array.isArray(r.relationship.historyEvents) && r.relationship.historyEvents.length === 0, 'RS2: historyEvents 빈 배열')
  cleanup()
}

// RS3 — 같은 쌍 두 번째 호출 → insertedNew=false (관계 영속, 1:1 고정)
{
  const { store, cleanup } = createTmpStore()
  store.upsertOnFirstMeeting({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  const second = store.upsertOnFirstMeeting({ localAgentId: 'a/x', peerAgentId: 'b/y', peerCard: { changed: true } })
  assert(second.insertedNew === false, 'RS3: 두 번째 호출 insertedNew=false')
  // 두 번째 호출의 peerCard 는 영향 없음 (refreshCards 가 별도 책임)
  assert(second.relationship.peerCard === null, 'RS3: 두 번째 호출에서 peerCard 변경 없음')
  cleanup()
}

// RS4 — getRelationship 존재 / 부재
{
  const { store, cleanup } = createTmpStore()
  store.upsertOnFirstMeeting({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  const found = store.getRelationship({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  assert(found !== null && found.localAgentId === 'a/x', 'RS4: 존재하는 관계 조회')
  const missing = store.getRelationship({ localAgentId: 'a/x', peerAgentId: 'nope/peer' })
  assert(missing === null, 'RS4: 부재 관계 → null')
  cleanup()
}

// RS5 — listForLocal 정렬 (created_at ASC, peer_agent_id ASC) + status 필터
// peer_agent_id 보조 정렬 키 — 같은 ms 에 INSERT 된 row 도 결정적 순서 (sleep 의존 없음).
{
  const { store, cleanup } = createTmpStore()
  store.upsertOnFirstMeeting({ localAgentId: 'a/x', peerAgentId: 'p1' })
  store.upsertOnFirstMeeting({ localAgentId: 'a/x', peerAgentId: 'p2' })
  store.upsertOnFirstMeeting({ localAgentId: 'a/x', peerAgentId: 'p3' })
  store.closeRelationship({ localAgentId: 'a/x', peerAgentId: 'p2' })
  const all = store.listForLocal({ localAgentId: 'a/x' })
  assert(all.length === 3, `RS5: 전체 3개 (got ${all.length})`)
  // peer_agent_id 알파벳 순 (보조 키) — p1, p2, p3
  assert(all[0].peerAgentId === 'p1' && all[1].peerAgentId === 'p2' && all[2].peerAgentId === 'p3',
    `RS5: peer_agent_id 보조 정렬 (got ${all.map(r => r.peerAgentId).join(',')})`)
  const active = store.listForLocal({ localAgentId: 'a/x', status: RELATIONSHIP_STATUS.ACTIVE })
  assert(active.length === 2 && active.every(r => r.status === 'active'), 'RS5: status=active 필터 (2개)')
  const closed = store.listForLocal({ localAgentId: 'a/x', status: RELATIONSHIP_STATUS.CLOSED })
  assert(closed.length === 1 && closed[0].peerAgentId === 'p2', 'RS5: status=closed 필터 (1개)')
  cleanup()
}

// RS5b — listForLocal invalid status → throw (codex round 1)
{
  const { store, cleanup } = createTmpStore()
  let threw = false
  try {
    store.listForLocal({ localAgentId: 'a/x', status: 'bogus' })
  } catch (err) {
    threw = err.message.includes('invalid status')
  }
  assert(threw, 'RS5b: invalid status → throw')
  cleanup()
}

// RS5c — listForLocal 빈/whitespace localAgentId → throw (codex round 2: mutator 일관성)
{
  const { store, cleanup } = createTmpStore()
  let threw = 0
  const expectThrow = (fn) => { try { fn() } catch (_) { threw += 1 } }
  expectThrow(() => store.listForLocal({ localAgentId: '' }))
  expectThrow(() => store.listForLocal({ localAgentId: '   ' }))
  expectThrow(() => store.listForLocal({ localAgentId: null }))
  expectThrow(() => store.listForLocal({}))
  assert(threw === 4, `RS5c: 빈/whitespace/null/undefined localAgentId 모두 throw (got ${threw})`)
  cleanup()
}

// RS6 — recordMeeting 가 last_meeting_at + meeting_count 증가
{
  const { store, cleanup } = createTmpStore()
  store.upsertOnFirstMeeting({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  assert(store.recordMeeting({ localAgentId: 'a/x', peerAgentId: 'b/y' }) === true, 'RS6: 첫 recordMeeting → true')
  let r = store.getRelationship({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  assert(r.meetingCount === 1, `RS6: meetingCount=1 (got ${r.meetingCount})`)
  assert(typeof r.lastMeetingAt === 'number' && r.lastMeetingAt > 0, 'RS6: lastMeetingAt 설정됨')
  store.recordMeeting({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  store.recordMeeting({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  r = store.getRelationship({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  assert(r.meetingCount === 3, `RS6: meetingCount=3 (got ${r.meetingCount})`)
  cleanup()
}

// RS7 — recordMeeting 부재 row → false (no-op, no throw — race 후 upsert 재시도 가능)
{
  const { store, cleanup } = createTmpStore()
  const r = store.recordMeeting({ localAgentId: 'a/x', peerAgentId: 'never' })
  assert(r === false, 'RS7: 부재 row recordMeeting → false')
  cleanup()
}

// RS7b — recordMeeting closed 관계 → throw (codex round 1: closed vs missing 분리)
//        + throw 후 meeting_count / last_meeting_at 불변 검증 (codex round 2 보강)
{
  const { store, cleanup } = createTmpStore()
  store.upsertOnFirstMeeting({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  store.recordMeeting({ localAgentId: 'a/x', peerAgentId: 'b/y' })  // 1 회 만남 카운트
  const beforeClose = store.getRelationship({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  store.closeRelationship({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  let threw = false
  let code = null
  try {
    store.recordMeeting({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  } catch (err) {
    threw = err.message.includes('relationship closed')
    code = err.code
  }
  assert(threw, 'RS7b: closed 관계 recordMeeting → throw')
  assert(code === 'RELATIONSHIP_CLOSED', `RS7b: err.code=RELATIONSHIP_CLOSED (got ${code})`)
  // throw 후 row 불변 — 트랜잭션 롤백 확인
  const afterThrow = store.getRelationship({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  assert(afterThrow.meetingCount === beforeClose.meetingCount,
    `RS7b: throw 후 meetingCount 불변 (before=${beforeClose.meetingCount} / after=${afterThrow.meetingCount})`)
  assert(afterThrow.lastMeetingAt === beforeClose.lastMeetingAt,
    `RS7b: throw 후 lastMeetingAt 불변`)
  cleanup()
}

// RS8 — closeRelationship → status=closed + closed_at + history closed 이벤트
{
  const { store, cleanup } = createTmpStore()
  store.upsertOnFirstMeeting({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  const ok = store.closeRelationship({ localAgentId: 'a/x', peerAgentId: 'b/y', summary: 'farewell' })
  assert(ok === true, 'RS8: closeRelationship → true')
  const r = store.getRelationship({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  assert(r.status === RELATIONSHIP_STATUS.CLOSED, 'RS8: status=closed')
  assert(typeof r.closedAt === 'number' && r.closedAt > 0, 'RS8: closed_at 설정됨')
  assert(r.historyEvents.length === 1, `RS8: history 1건 (got ${r.historyEvents.length})`)
  assert(r.historyEvents[0].type === HISTORY_EVENT_TYPE.CLOSED, 'RS8: history.type=closed')
  assert(r.historyEvents[0].summary === 'farewell', 'RS8: history.summary 보존')
  cleanup()
}

// RS9 — closeRelationship 멱등 — 두 번째 호출 → false (이미 closed)
{
  const { store, cleanup } = createTmpStore()
  store.upsertOnFirstMeeting({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  store.closeRelationship({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  const second = store.closeRelationship({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  assert(second === false, 'RS9: 이미 closed → false (history 추가 없음)')
  const r = store.getRelationship({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  assert(r.historyEvents.length === 1, `RS9: history 1건 유지 (got ${r.historyEvents.length})`)
  cleanup()
}

// RS10 — recordHistoryEvent 가 cleared/summarized 누적
{
  const { store, cleanup } = createTmpStore()
  store.upsertOnFirstMeeting({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  const ok1 = store.recordHistoryEvent({ localAgentId: 'a/x', peerAgentId: 'b/y', type: HISTORY_EVENT_TYPE.CLEARED })
  const ok2 = store.recordHistoryEvent({ localAgentId: 'a/x', peerAgentId: 'b/y', type: HISTORY_EVENT_TYPE.SUMMARIZED, summary: 'gist 요약' })
  assert(ok1 === true && ok2 === true, 'RS10: 두 이벤트 모두 성공')
  const r = store.getRelationship({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  assert(r.historyEvents.length === 2, `RS10: 2 이벤트 누적 (got ${r.historyEvents.length})`)
  assert(r.historyEvents[0].type === 'cleared', 'RS10: 첫 이벤트 cleared')
  assert(r.historyEvents[1].type === 'summarized' && r.historyEvents[1].summary === 'gist 요약', 'RS10: 두 번째 summarized + summary')
  cleanup()
}

// RS11 — recordHistoryEvent invalid type → throw
{
  const { store, cleanup } = createTmpStore()
  store.upsertOnFirstMeeting({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  let threw = false
  try {
    store.recordHistoryEvent({ localAgentId: 'a/x', peerAgentId: 'b/y', type: 'bogus' })
  } catch (err) {
    threw = err.message.includes('invalid type')
  }
  assert(threw, 'RS11: invalid type → throw with invalid type 메시지')
  cleanup()
}

// RS12 — refreshCards 가 peer/local 카드 갱신 + card-refreshed 이벤트
{
  const { store, cleanup } = createTmpStore()
  store.upsertOnFirstMeeting({
    localAgentId: 'a/x', peerAgentId: 'b/y',
    peerCard: { v: 1 }, localCard: { mine: 1 },
  })
  const ok = store.refreshCards({
    localAgentId: 'a/x', peerAgentId: 'b/y',
    peerCard: { v: 2 },
  })
  assert(ok === true, 'RS12: refreshCards 성공')
  const r = store.getRelationship({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  assert(r.peerCard.v === 2, 'RS12: peerCard 갱신됨')
  assert(r.localCard.mine === 1, 'RS12: localCard 미변경 (인자 없음)')
  assert(r.historyEvents.length === 1 && r.historyEvents[0].type === 'card-refreshed', 'RS12: card-refreshed 이벤트 기록')
  cleanup()
}

// RS13 — refreshCards 부재 row → false
{
  const { store, cleanup } = createTmpStore()
  const ok = store.refreshCards({ localAgentId: 'never/here', peerAgentId: 'p', peerCard: {} })
  assert(ok === false, 'RS13: 부재 row refreshCards → false')
  cleanup()
}

// RS14 — refreshCards 인자 모두 부재 → throw
{
  const { store, cleanup } = createTmpStore()
  store.upsertOnFirstMeeting({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  let threw = false
  try {
    store.refreshCards({ localAgentId: 'a/x', peerAgentId: 'b/y' })
  } catch (err) {
    threw = err.message.includes('peerCard 또는 localCard')
  }
  assert(threw, 'RS14: 인자 둘 다 부재 → throw')
  cleanup()
}

// RS15 — 필수 파라미터 누락 → throw 일관 결
{
  const { store, cleanup } = createTmpStore()
  let threw = 0
  const expectThrow = (fn) => { try { fn() } catch (_) { threw += 1 } }
  expectThrow(() => store.upsertOnFirstMeeting({ peerAgentId: 'p' }))
  expectThrow(() => store.recordMeeting({ peerAgentId: 'p' }))
  expectThrow(() => store.recordHistoryEvent({ peerAgentId: 'p', type: HISTORY_EVENT_TYPE.CLEARED }))
  expectThrow(() => store.closeRelationship({ peerAgentId: 'p' }))
  expectThrow(() => store.refreshCards({ peerAgentId: 'p', peerCard: {} }))
  assert(threw === 5, `RS15: 5 메서드 모두 missing localAgentId → throw (got ${threw})`)
  cleanup()
}

// RS15b — 공백 only / non-string ID 도 throw (codex round 1: assertAgentIds 강화)
//          5 mutator 모두 커버 (codex round 2 보강)
{
  const { store, cleanup } = createTmpStore()
  let threw = 0
  const expectThrow = (fn) => { try { fn() } catch (_) { threw += 1 } }
  // upsertOnFirstMeeting
  expectThrow(() => store.upsertOnFirstMeeting({ localAgentId: '   ', peerAgentId: 'p' }))
  expectThrow(() => store.upsertOnFirstMeeting({ localAgentId: 123, peerAgentId: 'p' }))
  // recordMeeting
  expectThrow(() => store.recordMeeting({ localAgentId: 'a/x', peerAgentId: null }))
  expectThrow(() => store.recordMeeting({ localAgentId: '\t', peerAgentId: 'p' }))
  // refreshCards
  expectThrow(() => store.refreshCards({ localAgentId: 'a/x', peerAgentId: '', peerCard: {} }))
  expectThrow(() => store.refreshCards({ localAgentId: undefined, peerAgentId: 'p', peerCard: {} }))
  // recordHistoryEvent
  expectThrow(() => store.recordHistoryEvent({ localAgentId: '   ', peerAgentId: 'p', type: HISTORY_EVENT_TYPE.CLEARED }))
  expectThrow(() => store.recordHistoryEvent({ localAgentId: 'a/x', peerAgentId: 42, type: HISTORY_EVENT_TYPE.CLEARED }))
  // closeRelationship
  expectThrow(() => store.closeRelationship({ localAgentId: '\n', peerAgentId: 'p' }))
  expectThrow(() => store.closeRelationship({ localAgentId: 'a/x', peerAgentId: false }))
  assert(threw === 10, `RS15b: 5 mutator × 2 케이스 = 10 throw (got ${threw})`)
  cleanup()
}

// RS16 — Reader 동치 — createA2aRelationshipStoreR.run({ dbPath }) === createA2aRelationshipStore(dbPath) shape
{
  const dir = join(tmpdir(), `a2a-rel-rd-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  const dbPath = defaultA2aRelationshipDbPath(dir)
  const store = createA2aRelationshipStore(dbPath)
  assert(store instanceof A2aRelationshipStore, 'RS16: factory → A2aRelationshipStore 인스턴스')
  store.close()
  rmSync(dir, { recursive: true, force: true })
}

summary()
