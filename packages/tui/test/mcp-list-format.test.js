/**
 * MCP list 포맷 단위 테스트 (Phase 22 Step C, ux-guardian 권장: 그룹화).
 *
 * 공용/개인 혼재 시에만 [공용] / [개인] 헤더. 한쪽만 있거나 origin 미태깅이면
 * 기존 평평한 포맷.
 */

import { formatMcpList } from '@presence/tui/ui/slash-commands.js'
import { assert, summary } from '../../../test/lib/assert.js'

// --- 공용만 — 평평 ---
{
  const out = formatMcpList([
    { group: 'mcp0', serverName: 'github-mcp', origin: 'server', enabled: true, toolCount: 24 },
  ])
  assert(!out.includes('[공용]'), '공용만: 그룹 헤더 없음')
  assert(out.includes('● mcp0  github-mcp  (24 tools)'), '공용만: 기존 포맷')
}

// --- 개인만 — 평평 ---
{
  const out = formatMcpList([
    { group: 'mcp0', serverName: 'my-db', origin: 'user', enabled: true, toolCount: 8 },
  ])
  assert(!out.includes('[개인]'), '개인만: 그룹 헤더 없음')
  assert(out.includes('● mcp0  my-db  (8 tools)'), '개인만: 기존 포맷')
}

// --- 공용+개인 혼재 — 그룹화 ---
{
  const out = formatMcpList([
    { group: 'mcp0', serverName: 'github', origin: 'server', enabled: true, toolCount: 24 },
    { group: 'mcp1', serverName: 'my-db', origin: 'user', enabled: true, toolCount: 8 },
    { group: 'mcp2', serverName: 'local', origin: 'user', enabled: false, toolCount: 5 },
  ])
  assert(out.includes('[공용]'), '혼재: [공용] 헤더')
  assert(out.includes('[개인]'), '혼재: [개인] 헤더')
  // 순서: [공용] → server 항목 → [개인] → user 항목
  const idxServerHeader = out.indexOf('[공용]')
  const idxGithub = out.indexOf('github')
  const idxUserHeader = out.indexOf('[개인]')
  const idxMyDb = out.indexOf('my-db')
  assert(idxServerHeader < idxGithub && idxGithub < idxUserHeader && idxUserHeader < idxMyDb,
    '혼재: 순서 ([공용] → server → [개인] → user)')
  assert(out.includes('○ mcp2  local  (5 tools)'), '혼재: disabled 표시 유지')
}

// --- origin 미태깅 항목 포함 (혼재 시) — [공용]/[개인] 뒤에 뒷부분에 평평하게 ---
{
  const out = formatMcpList([
    { group: 'mcp0', serverName: 'github', origin: 'server', enabled: true, toolCount: 24 },
    { group: 'mcp1', serverName: 'my-db', origin: 'user', enabled: true, toolCount: 8 },
    { group: 'mcp2', serverName: 'legacy', origin: undefined, enabled: true, toolCount: 3 },
  ])
  assert(out.includes('legacy'), 'origin 미태깅: 포함됨')
  // legacy 는 공용/개인 섹션 밖에 나옴
  const idxUser = out.indexOf('my-db')
  const idxLegacy = out.indexOf('legacy')
  assert(idxLegacy > idxUser, 'origin 미태깅: 그룹 섹션 뒤에 배치')
}

// --- 빈 배열 ---
{
  assert(formatMcpList([]) === '', '빈 입력 → 빈 문자열')
}

summary()
