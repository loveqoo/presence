#!/usr/bin/env node
// FP-58 진단: 실제 TTY 에서 process.stdout.write 호출을 계측한다.
//
// 이 스크립트는 실제 터미널에서 직접 실행해야 한다. PTY 환경에서만 Ink raw mode
// 가 동작하기 때문이다. 측정 결과는 /tmp/presence-writes.log 에 기록된다.
//
// 사용법:
//   node packages/tui/diag/measure-writes.js
//   (3초 후 자동 종료. 그 동안은 평소처럼 화면을 지켜보고 깜빡임을 관찰)
//   이후 cat /tmp/presence-writes.log 로 결과 확인.

import React from 'react'
import { render } from 'ink'
import fs from 'fs'
import { App } from '../src/ui/App.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { TurnState } from '@presence/core/core/policies.js'
import { initI18n } from '@presence/infra/i18n'

const h = React.createElement
const LOG_PATH = '/tmp/presence-writes.log'
const durationSec = Number(process.argv[2] || 3)

await initI18n('ko')

// write 계측기: 원본 write 를 보존하고 wrapper 로 교체.
const realWrite = process.stdout.write.bind(process.stdout)
const writes = []
const bucket = { count: 0, bytes: 0, patterns: {} }

const classify = (chunk) => {
  const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  if (s.includes('\x1b[2K')) return 'erase-line'
  if (s.includes('\x1b[J')) return 'erase-down'
  if (s.includes('\x1b[A')) return 'cursor-up'
  if (s.includes('\x1b[?25')) return 'cursor-vis'
  if (/^\x1b\[/.test(s)) return 'escape-only'
  return 'content'
}

const t0 = Date.now()
process.stdout.write = function (chunk, encoding, cb) {
  const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  bucket.count++
  bucket.bytes += s.length
  const kind = classify(s)
  bucket.patterns[kind] = (bucket.patterns[kind] || 0) + 1
  if (writes.length < 60) {
    writes.push({ at: Date.now() - t0, kind, size: s.length, preview: s.replace(/\x1b/g, '\\e').slice(0, 80) })
  }
  return realWrite(chunk, encoding, cb)
}

const state = createOriginState({
  turnState: TurnState.working('데모 질문'),
  lastTurn: null,
  turn: 3,
  context: {
    memories: [],
    conversationHistory: [
      { input: '첫 질문입니다. 긴 질문을 입력해서 화면을 채워봅니다.', output: '답변 1: 여러 줄에 걸친 응답을 반환합니다.\n계속해서 두 번째 줄입니다.' },
      { input: '두 번째 질문', output: '답변 2: 짧은 답변.' },
    ],
  },
  todos: [],
  events: { queue: [], deadLetter: [] },
  delegates: { pending: [] },
  _toolResults: [],
})

const rendered = render(h(App, {
  state,
  onInput: () => {}, onApprove: () => {}, onCancel: () => {},
  agentName: 'Presence', tools: [], agents: [],
  cwd: process.cwd(), gitBranch: 'main', model: 'claude-sonnet-4-6',
  sessionId: 'diag-session',
}))

setTimeout(() => {
  rendered.unmount()
  process.stdout.write = realWrite
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2)
  const report = [
    '=== FP-58 write 계측 결과 ===',
    `측정 시간: ${elapsed}s`,
    `총 write: ${bucket.count}회, ${bucket.bytes} bytes`,
    `write/sec: ${(bucket.count / Number(elapsed)).toFixed(1)}`,
    `패턴별: ${JSON.stringify(bucket.patterns)}`,
    '',
    '첫 60 write (시간 순):',
    ...writes.map(w => `  +${w.at}ms [${w.kind}] size=${w.size} ${w.preview}`),
  ].join('\n')
  fs.writeFileSync(LOG_PATH, report)
  // 파일로만 기록 (Ink 가 화면 정리한 후에도 stdout 오염 방지)
  realWrite(`\n진단 로그 저장: ${LOG_PATH}\n`)
  process.exit(0)
}, durationSec * 1000)
