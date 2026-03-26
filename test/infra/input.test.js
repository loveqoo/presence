import { InputHandler, PASTE_START, PASTE_END } from '../../src/infra/input.js'
import { assert, summary } from '../lib/assert.js'

console.log('InputHandler tests')

// 1. Single line input
{
  const lines = []
  const h = new InputHandler({ onLine: (l) => lines.push(l) })
  h.feed('hello\n')
  assert(lines.length === 1 && lines[0] === 'hello', 'single line: parsed')
}

// 2. Multiple lines
{
  const lines = []
  const h = new InputHandler({ onLine: (l) => lines.push(l) })
  h.feed('a\nb\nc\n')
  assert(lines.length === 3, 'multi line: 3 lines')
  assert(lines[2] === 'c', 'multi line: correct content')
}

// 3. Carriage return handled
{
  const lines = []
  const h = new InputHandler({ onLine: (l) => lines.push(l) })
  h.feed('hello\r')
  assert(lines[0] === 'hello', 'CR: parsed as line end')
}

// 4. Bracketed paste: multiline paste arrives as single onPaste
{
  const lines = []
  const pastes = []
  const h = new InputHandler({
    onLine: (l) => lines.push(l),
    onPaste: (p) => pastes.push(p),
  })
  h.feed(`${PASTE_START}line1\nline2\nline3${PASTE_END}`)
  assert(lines.length === 0, 'paste: no onLine called')
  assert(pastes.length === 1, 'paste: 1 onPaste call')
  assert(pastes[0] === 'line1\nline2\nline3', 'paste: full content preserved')
}

// 5. Mixed: typed text, then paste, then typed text
{
  const lines = []
  const pastes = []
  const h = new InputHandler({
    onLine: (l) => lines.push(l),
    onPaste: (p) => pastes.push(p),
  })
  h.feed('before\n')
  h.feed(`${PASTE_START}pasted${PASTE_END}`)
  h.feed('after\n')
  assert(lines.length === 2, 'mixed: 2 lines')
  assert(lines[0] === 'before', 'mixed: before paste')
  assert(lines[1] === 'after', 'mixed: after paste')
  assert(pastes[0] === 'pasted', 'mixed: paste content')
}

// 6. Paste split across chunks
{
  const pastes = []
  const h = new InputHandler({ onPaste: (p) => pastes.push(p) })
  h.feed(`${PASTE_START}first half`)
  h.feed(` second half${PASTE_END}`)
  assert(pastes[0] === 'first half second half', 'split paste: reassembled')
}

// 7. Empty lines skipped
{
  const lines = []
  const h = new InputHandler({ onLine: (l) => lines.push(l) })
  h.feed('\n\n\n')
  assert(lines.length === 0, 'empty lines: skipped')
}

// 8. flush() emits remaining buffer
{
  const lines = []
  const h = new InputHandler({ onLine: (l) => lines.push(l) })
  h.feed('no newline')
  assert(lines.length === 0, 'flush: not emitted before flush')
  h.flush()
  assert(lines.length === 1 && lines[0] === 'no newline', 'flush: emitted after flush')
}

// 9. summarizePaste
{
  const summary = InputHandler.summarizePaste('a\nb\nc')
  assert(summary.includes('3줄'), 'summarize: line count')
  assert(summary.includes('5자'), 'summarize: char count')
}

// 10. No onPaste → falls back to onLine
{
  const lines = []
  const h = new InputHandler({ onLine: (l) => lines.push(l) })
  h.feed(`${PASTE_START}fallback${PASTE_END}`)
  assert(lines[0] === 'fallback', 'no onPaste: falls back to onLine')
}

summary()
