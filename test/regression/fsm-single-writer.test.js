/**
 * INV-FSM-SINGLE-WRITER 정적 검사.
 *
 * FSM runtime / bridge 외의 경로에서 `state.set(STATE_PATH.TURN_STATE | APPROVE | DELEGATES)`
 * 호출을 금지한다. 새 호출이 추가되면 실패해서 배선 우회를 조기에 드러낸다.
 *
 * 간접 커버만 있는 INV 를 직접 assertion 으로 고정 (docs/specs/tui-server-contract.md).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, summary } from '../lib/assert.js'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCAN_DIRS = [
  'packages/core/src',
  'packages/infra/src',
  'packages/server/src',
  'packages/tui/src',
]
const ALLOWED_FILES = new Set([
  'packages/infra/src/infra/fsm/turn-gate-bridge.js',
  'packages/infra/src/infra/fsm/approve-bridge.js',
  'packages/infra/src/infra/fsm/delegate-bridge.js',
])
const PATTERN = /state\.set\(\s*STATE_PATH\.(TURN_STATE|APPROVE|DELEGATES)\b/g

const walk = (dir) => {
  const out = []
  for (const ent of readdirSync(dir)) {
    const full = join(dir, ent)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.js')) out.push(full)
  }
  return out
}

console.log('INV-FSM-SINGLE-WRITER static check')

const violations = []
for (const scanDir of SCAN_DIRS) {
  const absDir = join(REPO_ROOT, scanDir)
  for (const filePath of walk(absDir)) {
    const rel = relative(REPO_ROOT, filePath)
    if (ALLOWED_FILES.has(rel)) continue
    const content = readFileSync(filePath, 'utf8')
    for (const match of content.matchAll(PATTERN)) {
      const upTo = content.slice(0, match.index)
      const lineNo = upTo.split('\n').length
      const line = content.split('\n')[lineNo - 1]?.trim() ?? ''
      violations.push(`${rel}:${lineNo}: ${line}`)
    }
  }
}

const msg = violations.length === 0
  ? 'FSM state path 는 bridge 에서만 set — 외부 위반 0건'
  : `INV-FSM-SINGLE-WRITER 위반 ${violations.length}건:\n` +
    violations.map(v => '  ' + v).join('\n') +
    `\nallowed: ${[...ALLOWED_FILES].join(', ')}`

assert(violations.length === 0, msg)

summary()
