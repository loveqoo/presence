import { initI18n } from '../../src/i18n/index.js'
initI18n('ko')
import {
  extractForCompaction, buildCompactionPrompt, createSummaryEntry, SUMMARY_MARKER,
} from '../../src/infra/history-compaction.js'
import { migrateHistoryIds } from '../../src/infra/persistence.js'
import { createReactiveState } from '../../src/infra/state.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

function assertDeepEqual(a, b, msg) {
  assert(JSON.stringify(a) === JSON.stringify(b), msg)
}

// --- 헬퍼 ---
const makeHistory = (n) => Array.from({ length: n }, (_, i) => ({
  id: `h-${i}`, input: `q${i}`, output: `a${i}`, ts: 1000 + i,
}))

async function run() {
  console.log('History Compaction tests')

  // =============================================
  // extractForCompaction 순수 함수 테스트
  // =============================================

  // E1. threshold 미달 → null
  {
    const history = makeHistory(10)
    const result = extractForCompaction(history, 15, 5)
    assert(result === null, 'extractForCompaction: below threshold → null')
  }

  // E2. threshold 경계 (== threshold) → null
  {
    const history = makeHistory(15)
    const result = extractForCompaction(history, 15, 5)
    assert(result === null, 'extractForCompaction: at threshold → null')
  }

  // E3. 정상 분리
  {
    const history = makeHistory(20)
    const result = extractForCompaction(history, 15, 5)
    assert(result !== null, 'extractForCompaction: above threshold → split')
    assert(result.extracted.length === 15, 'extractForCompaction: extracted count')
    assert(result.remaining.length === 5, 'extractForCompaction: remaining count')
  }

  // E4. remaining 정확성
  {
    const history = makeHistory(20)
    const result = extractForCompaction(history, 15, 5)
    assertDeepEqual(result.remaining, history.slice(15), 'extractForCompaction: remaining matches tail')
  }

  // E5. 입력 불변
  {
    const history = makeHistory(20)
    const original = JSON.parse(JSON.stringify(history))
    extractForCompaction(history, 15, 5)
    assertDeepEqual(history, original, 'extractForCompaction: input array not mutated')
  }

  // E6. keep <= 0 → null
  {
    const history = makeHistory(20)
    assert(extractForCompaction(history, 15, 0) === null, 'extractForCompaction: keep=0 → null')
    assert(extractForCompaction(history, 15, -1) === null, 'extractForCompaction: keep=-1 → null')
  }

  // E7. keep >= history.length → null
  {
    const history = makeHistory(20)
    assert(extractForCompaction(history, 15, 20) === null, 'extractForCompaction: keep=length → null')
    assert(extractForCompaction(history, 15, 25) === null, 'extractForCompaction: keep>length → null')
  }

  // E8. keep >= threshold → null
  {
    const history = makeHistory(20)
    assert(extractForCompaction(history, 15, 15) === null, 'extractForCompaction: keep=threshold → null')
    assert(extractForCompaction(history, 15, 16) === null, 'extractForCompaction: keep>threshold → null')
  }

  // E9. non-array → null
  {
    assert(extractForCompaction(null, 15, 5) === null, 'extractForCompaction: null → null')
    assert(extractForCompaction(undefined, 15, 5) === null, 'extractForCompaction: undefined → null')
  }

  // =============================================
  // buildCompactionPrompt 테스트
  // =============================================

  // B1. 일반 턴
  {
    const turns = [{ input: 'hi', output: 'hello' }, { input: 'bye', output: 'goodbye' }]
    const prompt = buildCompactionPrompt(turns)
    assert(prompt.messages.length === 2, 'buildCompactionPrompt: 2 messages (system + user)')
    assert(prompt.messages[1].content.includes('User: hi'), 'buildCompactionPrompt: contains user input')
    assert(!prompt.messages[0].content.includes('이전 요약'), 'buildCompactionPrompt: no previous summary instruction')
  }

  // B2. summary-at-head
  {
    const turns = [
      { input: SUMMARY_MARKER, output: 'previous summary text' },
      { input: 'new q', output: 'new a' },
    ]
    const prompt = buildCompactionPrompt(turns)
    assert(prompt.messages[0].content.includes('이전 요약'), 'buildCompactionPrompt: summary-at-head uses merge instruction')
    assert(prompt.messages[1].content.includes('[Previous Summary]'), 'buildCompactionPrompt: contains previous summary tag')
  }

  // B3. 빈 배열
  {
    const prompt = buildCompactionPrompt([])
    assert(prompt.messages.length === 2, 'buildCompactionPrompt: empty array still produces 2 messages')
  }

  // =============================================
  // createSummaryEntry 테스트
  // =============================================

  // S1. format 검증
  {
    const entry = createSummaryEntry('test summary')
    assert(entry.id.startsWith('summary-'), 'createSummaryEntry: id starts with summary-')
    assert(entry.input === SUMMARY_MARKER, 'createSummaryEntry: input is SUMMARY_MARKER')
    assert(entry.output === 'test summary', 'createSummaryEntry: output preserved')
    assert(typeof entry.ts === 'number', 'createSummaryEntry: ts is number')
  }

  // S2. 두 번 호출 시 id 다름 (random suffix)
  {
    const a = createSummaryEntry('a')
    const b = createSummaryEntry('b')
    assert(a.id !== b.id, 'createSummaryEntry: unique ids')
  }

  // =============================================
  // migrateHistoryIds 테스트
  // =============================================

  // M1. id 있는 항목 보존
  {
    const history = [{ id: 'existing-1', input: 'q', output: 'a', ts: 100 }]
    const migrated = migrateHistoryIds(history)
    assert(migrated[0].id === 'existing-1', 'migrateHistoryIds: existing id preserved')
  }

  // M2. id 없는 항목 생성
  {
    const history = [{ input: 'q', output: 'a', ts: 200 }]
    const migrated = migrateHistoryIds(history)
    assert(migrated[0].id.startsWith('h-'), 'migrateHistoryIds: generated id starts with h-')
    assert(migrated[0].input === 'q', 'migrateHistoryIds: input preserved')
  }

  // M3. summary 항목
  {
    const history = [{ input: '[conversation summary]', output: 'sum', ts: 300 }]
    const migrated = migrateHistoryIds(history)
    assert(migrated[0].id.startsWith('summary-'), 'migrateHistoryIds: summary id starts with summary-')
  }

  // M4. 빈 입력
  {
    assertDeepEqual(migrateHistoryIds([]), [], 'migrateHistoryIds: empty array → empty array')
    assertDeepEqual(migrateHistoryIds(null), [], 'migrateHistoryIds: null → empty array')
    assertDeepEqual(migrateHistoryIds(undefined), [], 'migrateHistoryIds: undefined → empty array')
  }

  // M5. 혼합 (id 있는 + 없는)
  {
    const history = [
      { id: 'keep', input: 'q1', output: 'a1' },
      { input: 'q2', output: 'a2', ts: 400 },
    ]
    const migrated = migrateHistoryIds(history)
    assert(migrated[0].id === 'keep', 'migrateHistoryIds: mixed - existing preserved')
    assert(migrated[1].id.startsWith('h-'), 'migrateHistoryIds: mixed - new id generated')
  }

  // =============================================
  // 통합 테스트 (placeholder 기반 Extract-Summarize-Replace)
  // =============================================

  // --- placeholder 시뮬레이션 헬퍼 ---
  const simulatePhase1 = (state, split) => {
    const epochBefore = state.get('_compactionEpoch') || 0
    const placeholderId = `placeholder-test-${Date.now()}`
    const placeholder = {
      id: placeholderId,
      input: SUMMARY_MARKER,
      output: `이전 대화 ${split.extracted.length}개 턴의 맥락 요약이 진행 중입니다.`,
      ts: Date.now(),
    }
    state.set('context.conversationHistory', [placeholder, ...split.remaining])
    state.set('_compactionEpoch', epochBefore + 1)
    return { placeholderId, epochBefore }
  }

  // I1. 전체 흐름: 16항목 → placeholder+remaining → 요약 → replace → 6항목
  {
    const state = createReactiveState({
      turnState: { tag: 'idle' },
      context: { conversationHistory: makeHistory(16) },
    })
    const mockLlm = { chat: async () => ({ content: 'summary of conversation' }) }

    const history = state.get('context.conversationHistory')
    const split = extractForCompaction(history, 15, 5)
    assert(split !== null, 'integration: split is not null for 16 items')

    // Phase 1: 동기 추출 + placeholder
    const { placeholderId, epochBefore } = simulatePhase1(state, split)

    // Phase 1 직후: placeholder + 5 remaining = 6
    const afterPhase1 = state.get('context.conversationHistory')
    assert(afterPhase1.length === 6, 'integration: phase1 → placeholder + 5 remaining')
    assert(afterPhase1[0].id === placeholderId, 'integration: phase1 → placeholder at head')
    assert(afterPhase1[0].input === SUMMARY_MARKER, 'integration: placeholder has SUMMARY_MARKER')

    // Phase 2: 비동기 요약
    const result = await mockLlm.chat(buildCompactionPrompt(split.extracted))

    // Phase 3: placeholder → 실제 summary 교체
    const epochNow = state.get('_compactionEpoch')
    assert(epochNow === epochBefore + 1, 'integration: epoch unchanged')
    const current = state.get('context.conversationHistory')
    const summary = createSummaryEntry(result.content)
    const replaced = current.map(h => h.id === placeholderId ? summary : h)
    state.set('context.conversationHistory', replaced)

    const final = state.get('context.conversationHistory')
    assert(final.length === 6, 'integration: 16 → 6 (1 summary + 5 remaining)')
    assert(final[0].input === SUMMARY_MARKER, 'integration: first entry is summary')
    assert(final[0].output === 'summary of conversation', 'integration: summary content (not placeholder)')
    assert(final[0].id !== placeholderId, 'integration: placeholder replaced')
    assert(final[1].id === 'h-11', 'integration: remaining starts at correct position')
  }

  // I2. threshold 미달 → 건너뜀
  {
    const history = makeHistory(10)
    const split = extractForCompaction(history, 15, 5)
    assert(split === null, 'integration: below threshold → skip')
  }

  // I3. /clear epoch → 폐기 (placeholder 포함 전부 초기화)
  {
    const state = createReactiveState({
      turnState: { tag: 'idle' },
      context: { conversationHistory: makeHistory(16) },
    })

    const history = state.get('context.conversationHistory')
    const split = extractForCompaction(history, 15, 5)
    const { placeholderId, epochBefore } = simulatePhase1(state, split)

    // /clear 발생 시뮬레이션
    state.set('context.conversationHistory', [])
    state.set('_compactionEpoch', (state.get('_compactionEpoch') || 0) + 1)

    // Phase 3: epoch 불일치 → 폐기
    const epochNow = state.get('_compactionEpoch')
    assert(epochNow !== epochBefore + 1, 'integration: epoch mismatch after /clear')
    const final = state.get('context.conversationHistory')
    assert(final.length === 0, 'integration: /clear → empty history preserved')
  }

  // I4. LLM 실패 → placeholder 제거, remaining 유지
  {
    const state = createReactiveState({
      turnState: { tag: 'idle' },
      context: { conversationHistory: makeHistory(16) },
    })
    const logs = []
    const mockLogger = {
      warn: (msg, meta) => logs.push({ level: 'warn', msg, meta }),
    }

    const history = state.get('context.conversationHistory')
    const split = extractForCompaction(history, 15, 5)
    const { placeholderId, epochBefore } = simulatePhase1(state, split)

    // Phase 2: LLM 실패 → placeholder 제거
    const epochNow = state.get('_compactionEpoch')
    if (epochNow === epochBefore + 1) {
      const current = state.get('context.conversationHistory')
      state.set('context.conversationHistory', current.filter(h => h.id !== placeholderId))
    }
    mockLogger.warn('compaction failed', { count: split.extracted.length, error: 'LLM timeout' })

    const final = state.get('context.conversationHistory')
    assert(final.length === 5, 'integration: LLM failure → placeholder removed, remaining preserved')
    assert(!final.some(h => h.id === placeholderId), 'integration: LLM failure → no placeholder in history')
    assert(logs.some(l => l.level === 'warn' && l.meta.count === 11), 'integration: LLM failure → lost count logged')
  }

  // I5. 새 턴 append → placeholder 유지, 새 턴 보존, 교체 후 전부 유지
  {
    const state = createReactiveState({
      turnState: { tag: 'idle' },
      context: { conversationHistory: makeHistory(16) },
    })

    const history = state.get('context.conversationHistory')
    const split = extractForCompaction(history, 15, 5)
    const { placeholderId, epochBefore } = simulatePhase1(state, split)

    // 비동기 gap 중 새 턴 2개 append
    const current = state.get('context.conversationHistory')
    state.set('context.conversationHistory', [
      ...current,
      { id: 'h-new-1', input: 'new q1', output: 'new a1', ts: 9998 },
      { id: 'h-new-2', input: 'new q2', output: 'new a2', ts: 9999 },
    ])

    // 비동기 gap 중: placeholder가 head에 있으므로 프롬프트에 맥락 힌트 포함
    const duringGap = state.get('context.conversationHistory')
    assert(duringGap[0].id === placeholderId, 'integration: during gap → placeholder still at head')
    assert(duringGap[0].input === SUMMARY_MARKER, 'integration: during gap → placeholder is SUMMARY_MARKER')

    // Phase 3: placeholder → 실제 summary 교체
    const epochNow = state.get('_compactionEpoch')
    assert(epochNow === epochBefore + 1, 'integration: epoch still matches')
    const afterAppend = state.get('context.conversationHistory')
    const summary = createSummaryEntry('combined summary')
    const replaced = afterAppend.map(h => h.id === placeholderId ? summary : h)
    state.set('context.conversationHistory', replaced)

    const final = state.get('context.conversationHistory')
    assert(final.length === 8, 'integration: 1 summary + 5 remaining + 2 new = 8')
    assert(final[0].input === SUMMARY_MARKER, 'integration: summary at head')
    assert(final[0].output === 'combined summary', 'integration: real summary, not placeholder')
    assert(final[6].id === 'h-new-1', 'integration: new turns preserved')
    assert(final[7].id === 'h-new-2', 'integration: all new turns preserved')
  }

  // I6. compacting flag 재진입 방지
  {
    let compacting = false
    let callCount = 0

    const tryCompact = () => {
      if (compacting) return false
      compacting = true
      callCount++
      return true
    }

    const started1 = tryCompact()
    const started2 = tryCompact() // 재진입 시도
    compacting = false
    const started3 = tryCompact() // 해제 후 재시도

    assert(started1 === true, 'integration: first compaction starts')
    assert(started2 === false, 'integration: re-entry blocked')
    assert(started3 === true, 'integration: after release, compaction starts again')
    assert(callCount === 2, 'integration: exactly 2 compactions ran')
  }

  // I7. append + rolling trim → placeholder 소실, prepend fallback이 MAX_HISTORY 상한 유지
  {
    const MAX_HISTORY = 20  // policies.js HISTORY.MAX_CONVERSATION과 동일
    const state = createReactiveState({
      turnState: { tag: 'idle' },
      context: { conversationHistory: makeHistory(20) },
    })

    const history = state.get('context.conversationHistory')
    const split = extractForCompaction(history, 15, 5)
    const { placeholderId, epochBefore } = simulatePhase1(state, split)

    // 비동기 gap 중: 다수 턴 append → rolling window가 MAX_HISTORY=20으로 trim
    const current = state.get('context.conversationHistory')
    const newTurns = Array.from({ length: 25 }, (_, i) => ({
      id: `h-new-${i}`, input: `nq${i}`, output: `na${i}`, ts: 5000 + i,
    }))
    const withNew = [...current, ...newTurns]
    // rolling window 시뮬레이션: 최근 MAX_HISTORY개만 유지
    const trimmed = withNew.slice(-MAX_HISTORY)
    state.set('context.conversationHistory', trimmed)

    // placeholder가 trim됐는지 확인
    assert(!trimmed.some(h => h.id === placeholderId), 'integration: placeholder trimmed away')
    assert(trimmed.length === MAX_HISTORY, 'integration: history at MAX_HISTORY before fallback')

    // Phase 3: placeholder 없으면 prepend fallback + 상한 유지
    const epochNow = state.get('_compactionEpoch')
    assert(epochNow === epochBefore + 1, 'integration: epoch matches after trim')
    const afterTrim = state.get('context.conversationHistory')
    const summary = createSummaryEntry('trimmed summary')
    const hasPlaceholder = afterTrim.some(h => h.id === placeholderId)
    const merged = hasPlaceholder
      ? afterTrim.map(h => h.id === placeholderId ? summary : h)
      : [summary, ...afterTrim]
    const updated = merged.length > MAX_HISTORY
      ? [merged[0], ...merged.slice(-(MAX_HISTORY - 1))]
      : merged
    state.set('context.conversationHistory', updated)

    const final = state.get('context.conversationHistory')
    assert(final[0].input === SUMMARY_MARKER, 'integration: summary prepended after trim')
    assert(final[0].output === 'trimmed summary', 'integration: real summary content, not lost')
    assert(final.length <= MAX_HISTORY, 'integration: prepend fallback respects MAX_HISTORY')
    assert(final.length === MAX_HISTORY, 'integration: exactly MAX_HISTORY after trim+prepend')
    // summary가 [0]이고, 나머지 19개가 최신 턴
    assert(final[final.length - 1].id === 'h-new-24', 'integration: most recent turn preserved')
  }

  // I8. _compactionEpoch는 transient → persistence에서 제외
  {
    const state = createReactiveState({
      turnState: { tag: 'idle' },
      _compactionEpoch: 3,
    })
    const snap = state.snapshot()
    assert(snap._compactionEpoch === 3, 'integration: _compactionEpoch in snapshot')
    const stripped = {}
    for (const key of Object.keys(snap)) {
      if (!key.startsWith('_')) stripped[key] = snap[key]
    }
    assert(stripped._compactionEpoch === undefined, 'integration: _compactionEpoch stripped by transient filter')
  }

  // I9. /clear + 새 턴 → epoch 불일치 + 새 턴 유지
  {
    const state = createReactiveState({
      turnState: { tag: 'idle' },
      context: { conversationHistory: makeHistory(16) },
    })

    const history = state.get('context.conversationHistory')
    const split = extractForCompaction(history, 15, 5)
    const { placeholderId, epochBefore } = simulatePhase1(state, split)

    // /clear + 새 턴
    state.set('context.conversationHistory', [])
    state.set('_compactionEpoch', (state.get('_compactionEpoch') || 0) + 1)
    state.set('context.conversationHistory', [
      { id: 'h-fresh', input: 'fresh q', output: 'fresh a', ts: 9999 },
    ])

    // Phase 3: epoch 불일치 → summary 폐기
    const epochNow = state.get('_compactionEpoch')
    assert(epochNow !== epochBefore + 1, 'integration: /clear+new → epoch mismatch')
    const final = state.get('context.conversationHistory')
    assert(final.length === 1, 'integration: /clear+new → new turn preserved')
    assert(final[0].id === 'h-fresh', 'integration: /clear+new → correct new turn')
  }

  // I10. 요약-of-요약
  {
    const history = [
      { id: 'summary-old', input: SUMMARY_MARKER, output: 'old summary text', ts: 100 },
      ...makeHistory(16).slice(0, 15),
    ]
    const split = extractForCompaction(history, 15, 5)
    assert(split !== null, 'integration: summary-of-summaries → split')
    assert(split.extracted[0].input === SUMMARY_MARKER, 'integration: summary-of-summaries → old summary in extracted')
    const prompt = buildCompactionPrompt(split.extracted)
    assert(prompt.messages[0].content.includes('이전 요약'), 'integration: summary-of-summaries → merge instruction')
  }

  // =============================================
  // Placeholder 공백 구간 시나리오 테스트
  // =============================================

  // P1. Phase 1 직후 프롬프트 빌드 시 placeholder가 맥락 힌트 제공
  {
    const state = createReactiveState({
      turnState: { tag: 'idle' },
      context: { conversationHistory: makeHistory(16) },
    })

    const history = state.get('context.conversationHistory')
    const split = extractForCompaction(history, 15, 5)
    const { placeholderId } = simulatePhase1(state, split)

    // 비동기 gap — 사용자가 새 질문을 보냈다고 가정
    // agent가 prompt를 빌드할 때 읽는 history
    const promptHistory = state.get('context.conversationHistory')
    assert(promptHistory.length === 6, 'placeholder: prompt sees 6 entries (1 placeholder + 5 remaining)')
    assert(promptHistory[0].input === SUMMARY_MARKER, 'placeholder: prompt sees SUMMARY_MARKER at head')
    assert(promptHistory[0].output.includes('11'), 'placeholder: output mentions extracted count')
    // placeholder가 있으므로 LLM은 이전 맥락이 존재함을 인지
    const hasContextHint = promptHistory.some(h =>
      h.input === SUMMARY_MARKER && h.output.length > 0
    )
    assert(hasContextHint, 'placeholder: context hint present during gap')
  }

  // P2. Phase 3 성공 후 placeholder가 실제 요약으로 교체 확인
  {
    const state = createReactiveState({
      turnState: { tag: 'idle' },
      context: { conversationHistory: makeHistory(16) },
    })

    const history = state.get('context.conversationHistory')
    const split = extractForCompaction(history, 15, 5)
    const { placeholderId } = simulatePhase1(state, split)

    // 교체
    const current = state.get('context.conversationHistory')
    const summary = createSummaryEntry('real summary')
    const replaced = current.map(h => h.id === placeholderId ? summary : h)
    state.set('context.conversationHistory', replaced)

    const final = state.get('context.conversationHistory')
    assert(!final.some(h => h.id === placeholderId), 'placeholder: no placeholder after replace')
    assert(final[0].output === 'real summary', 'placeholder: real summary in place')
    assert(final[0].id.startsWith('summary-'), 'placeholder: real summary id format')
  }

  // P3. LLM 실패 시 placeholder 제거 → history에 placeholder 잔류 없음
  {
    const state = createReactiveState({
      turnState: { tag: 'idle' },
      context: { conversationHistory: makeHistory(16) },
    })

    const history = state.get('context.conversationHistory')
    const split = extractForCompaction(history, 15, 5)
    const { placeholderId, epochBefore } = simulatePhase1(state, split)

    // 비동기 gap 중 새 턴 추가
    const current = state.get('context.conversationHistory')
    state.set('context.conversationHistory', [
      ...current,
      { id: 'h-gap-turn', input: 'gap q', output: 'gap a', ts: 8888 },
    ])

    // LLM 실패 → placeholder 제거
    const epochNow = state.get('_compactionEpoch')
    if (epochNow === epochBefore + 1) {
      const cur = state.get('context.conversationHistory')
      state.set('context.conversationHistory', cur.filter(h => h.id !== placeholderId))
    }

    const final = state.get('context.conversationHistory')
    assert(!final.some(h => h.id === placeholderId), 'placeholder: removed after LLM failure')
    assert(final.length === 6, 'placeholder: 5 remaining + 1 gap turn, no placeholder')
    assert(final.some(h => h.id === 'h-gap-turn'), 'placeholder: gap turn preserved after failure')
  }

  // P4. placeholder가 buildCompactionPrompt에서 [Previous Summary]로 인식되지 않음 확인
  //     (placeholder는 extracted에 포함되지 않으므로 이 케이스는 발생하지 않지만, 방어 확인)
  {
    const placeholderEntry = {
      id: 'placeholder-test', input: SUMMARY_MARKER,
      output: '요약 진행 중...', ts: 100,
    }
    // placeholder가 혹시 다음 compaction의 extracted에 들어가면?
    const prompt = buildCompactionPrompt([placeholderEntry, { input: 'q', output: 'a' }])
    // SUMMARY_MARKER 이므로 [Previous Summary]로 인식됨 — 이것은 의도된 동작
    assert(prompt.messages[1].content.includes('[Previous Summary]'), 'placeholder: treated as previous summary if in extracted')
    assert(prompt.messages[0].content.includes('이전 요약'), 'placeholder: merge instruction triggered')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
