import { createSeq, makeEntry, appendAndTrim, markLastTurnCancelled, turnEntriesOnly } from '@presence/core/core/history-writer.js'
import { HISTORY, HISTORY_ENTRY_TYPE } from '@presence/core/core/policies.js'
import { assert, assertDeepEqual, summary } from '../../../../test/lib/assert.js'

console.log('HistoryWriter tests')

// --- createSeq ---

// S1. sequential ids
{
  const seq = createSeq()
  assert(seq() === 1, 'createSeq: first call → 1')
  assert(seq() === 2, 'createSeq: second call → 2')
  assert(seq() === 3, 'createSeq: third call → 3')
}

// S2. independent instances
{
  const a = createSeq(), b = createSeq()
  a(); a(); a()
  assert(b() === 1, 'createSeq: separate instances do not share state')
}

// --- makeEntry (turn) ---

// T1. basic turn entry
{
  const seq = createSeq()
  const entry = makeEntry({ input: 'hello', output: 'world', seq, now: 1000 })
  assert(entry.id === 'h-1000-1', 'makeEntry turn: id = h-{now}-{seq}')
  assert(entry.ts === 1000, 'makeEntry turn: ts matches now')
  assert(entry.input === 'hello', 'makeEntry turn: input preserved')
  assert(entry.output === 'world', 'makeEntry turn: output preserved')
  assert(entry.type === undefined, 'makeEntry turn: type omitted (backward compat)')
}

// T2. truncate long input/output
{
  const seq = createSeq()
  const longInput = 'x'.repeat(HISTORY.MAX_INPUT_CHARS + 100)
  const entry = makeEntry({ input: longInput, output: 'ok', seq })
  assert(entry.input.length === HISTORY.MAX_INPUT_CHARS + '...(truncated)'.length, 'makeEntry turn: input truncated at MAX_INPUT_CHARS')
  assert(entry.input.endsWith('...(truncated)'), 'makeEntry turn: truncation marker')
}

// T3. extra fields merged
{
  const seq = createSeq()
  const entry = makeEntry({
    input: 'q', output: 'a', seq,
    extra: { cancelled: true, failed: true, errorKind: 'aborted' },
  })
  assert(entry.cancelled === true, 'makeEntry turn: extra.cancelled')
  assert(entry.failed === true, 'makeEntry turn: extra.failed')
  assert(entry.errorKind === 'aborted', 'makeEntry turn: extra.errorKind')
}

// T4. null/undefined input coerced to empty string
{
  const seq = createSeq()
  const entry = makeEntry({ input: null, output: undefined, seq })
  assert(entry.input === '', 'makeEntry turn: null input → empty')
  assert(entry.output === '', 'makeEntry turn: undefined output → empty')
}

// --- makeEntry (system) ---

// Y1. basic system entry
{
  const seq = createSeq()
  const entry = makeEntry({ type: HISTORY_ENTRY_TYPE.SYSTEM, content: 'cancelled', tag: 'cancel', seq, now: 2000 })
  assert(entry.type === HISTORY_ENTRY_TYPE.SYSTEM, 'makeEntry system: type = system')
  assert(entry.content === 'cancelled', 'makeEntry system: content preserved')
  assert(entry.tag === 'cancel', 'makeEntry system: tag preserved')
  assert(entry.id === 'h-2000-1', 'makeEntry system: id format')
  assert(entry.ts === 2000, 'makeEntry system: ts matches now')
  assert(entry.input === undefined, 'makeEntry system: no input field')
  assert(entry.output === undefined, 'makeEntry system: no output field')
}

// --- appendAndTrim ---

// A1. append single entry
{
  const result = appendAndTrim([], { id: 'h-1' })
  assert(result.length === 1, 'appendAndTrim: empty + entry → length 1')
  assert(result[0].id === 'h-1', 'appendAndTrim: entry at index 0')
}

// A2. null history treated as empty
{
  const result = appendAndTrim(null, { id: 'h-1' })
  assert(result.length === 1, 'appendAndTrim: null → treated as []')
}

// A3. trim to max
{
  const history = Array.from({ length: HISTORY.MAX_CONVERSATION }, (_, i) => ({ id: `h-${i}` }))
  const result = appendAndTrim(history, { id: 'h-new' })
  assert(result.length === HISTORY.MAX_CONVERSATION, 'appendAndTrim: trim to MAX_CONVERSATION')
  assert(result[result.length - 1].id === 'h-new', 'appendAndTrim: new entry at tail')
  assert(result[0].id === 'h-1', 'appendAndTrim: oldest (h-0) trimmed')
}

// A4. below max no trim
{
  const history = [{ id: 'h-1' }, { id: 'h-2' }]
  const result = appendAndTrim(history, { id: 'h-3' }, 5)
  assert(result.length === 3, 'appendAndTrim: below max → no trim')
}

// A5. immutability
{
  const history = [{ id: 'h-1' }]
  const before = JSON.stringify(history)
  appendAndTrim(history, { id: 'h-2' })
  assert(JSON.stringify(history) === before, 'appendAndTrim: input not mutated')
}

// --- markLastTurnCancelled ---

// C1. empty history
{
  const result = markLastTurnCancelled([])
  assert(result.length === 0, 'markLastTurnCancelled: empty → empty')
}

// C2. null/undefined
{
  assertDeepEqual(markLastTurnCancelled(null), null, 'markLastTurnCancelled: null passthrough')
  assertDeepEqual(markLastTurnCancelled(undefined), undefined, 'markLastTurnCancelled: undefined passthrough')
}

// C3. last entry is turn → mark cancelled
{
  const history = [{ id: 'h-1', input: 'q', output: 'a' }]
  const result = markLastTurnCancelled(history)
  assert(result[0].cancelled === true, 'markLastTurnCancelled: last turn marked')
  assert(history[0].cancelled === undefined, 'markLastTurnCancelled: input not mutated')
}

// C4. last entry is SYSTEM → skip to prior turn (INV-CNC-1)
{
  const history = [
    { id: 'h-1', input: 'q1', output: 'a1' },
    { id: 'h-2', type: HISTORY_ENTRY_TYPE.SYSTEM, content: 'approved', tag: 'approve' },
  ]
  const result = markLastTurnCancelled(history)
  assert(result[0].cancelled === true, 'markLastTurnCancelled: prior turn marked')
  assert(result[1].cancelled === undefined, 'markLastTurnCancelled: SYSTEM entry unchanged')
}

// C5. already cancelled → no change
{
  const history = [{ id: 'h-1', input: 'q', output: 'a', cancelled: true }]
  const result = markLastTurnCancelled(history)
  assert(result === history, 'markLastTurnCancelled: already cancelled → same ref')
}

// C6. all SYSTEM entries → no change
{
  const history = [
    { id: 'h-1', type: HISTORY_ENTRY_TYPE.SYSTEM, content: 'a' },
    { id: 'h-2', type: HISTORY_ENTRY_TYPE.SYSTEM, content: 'b' },
  ]
  const result = markLastTurnCancelled(history)
  assert(result === history, 'markLastTurnCancelled: no turn → same ref')
}

// C7. skip multiple SYSTEM entries to find turn
{
  const history = [
    { id: 'h-1', input: 'q1', output: 'a1' },
    { id: 'h-2', type: HISTORY_ENTRY_TYPE.SYSTEM, content: 's1' },
    { id: 'h-3', type: HISTORY_ENTRY_TYPE.SYSTEM, content: 's2' },
  ]
  const result = markLastTurnCancelled(history)
  assert(result[0].cancelled === true, 'markLastTurnCancelled: skip multiple SYSTEM to find turn')
  assert(result[1].cancelled === undefined, 'markLastTurnCancelled: SYSTEM at [1] unchanged')
  assert(result[2].cancelled === undefined, 'markLastTurnCancelled: SYSTEM at [2] unchanged')
}

// --- turnEntriesOnly ---

// F1. mixed → turn only
{
  const history = [
    { id: '1', input: 'q' },
    { id: '2', type: HISTORY_ENTRY_TYPE.SYSTEM, content: 's' },
    { id: '3', input: 'q2' },
  ]
  const result = turnEntriesOnly(history)
  assert(result.length === 2, 'turnEntriesOnly: 2 turns')
  assert(result[0].id === '1' && result[1].id === '3', 'turnEntriesOnly: preserves order')
}

// F2. null → []
{
  assertDeepEqual(turnEntriesOnly(null), [], 'turnEntriesOnly: null → []')
}

summary()
