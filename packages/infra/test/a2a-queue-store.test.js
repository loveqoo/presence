import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { createA2aQueueStore, TODO_STATUS, TODO_KIND } from '@presence/infra/infra/a2a/a2a-queue-store.js'
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

  // AQ6. schema migration — 빈 DB 에서 v1 생성 smoke
  {
    const dir = makeTmpDir()
    const dbPath = join(dir, 'a2a.db')
    const store = createA2aQueueStore(dbPath)
    const { default: BetterSqlite } = await import('better-sqlite3')
    const ro = new BetterSqlite(dbPath, { readonly: true })
    const cols = ro.prepare('PRAGMA table_info(todo_messages)').all().map(c => c.name)
    assert(cols.includes('id'), 'AQ6: id 컬럼')
    assert(cols.includes('to_agent_id'), 'AQ6: to_agent_id 컬럼')
    assert(cols.includes('status'), 'AQ6: status 컬럼')
    assert(ro.pragma('user_version', { simple: true }) === 1, 'AQ6: user_version=1')
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

  summary()
}

run().catch(err => { console.error(err); process.exit(1) })
