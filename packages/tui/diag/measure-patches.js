#!/usr/bin/env node
// FP-58 진단 2: 실환경에서 MirrorState.applyPatch 호출을 계측한다.
// 이 스크립트는 실제 TUI 를 띄우지 않고, MirrorState 만 생성해서 서버 연결 후
// 어떤 state path 가 언제 도착하는지 기록한다. Ink 렌더 경로에서 분리했으므로
// 서버 측 broadcast 빈도를 순수하게 측정할 수 있다.
//
// 실행: node packages/tui/diag/measure-patches.js <wsUrl> <token> [duration_sec]
//   wsUrl   — ws://localhost:3000/ws (기본)
//   token   — access token (로그인으로 얻기)
//   duration — 측정 시간 (기본 5)
//
// 출력: /tmp/presence-patches.log 에 path별 수신 횟수, 타임라인 기록

import fs from 'fs'
import { createMirrorState } from '@presence/infra/infra/states/mirror-state.js'

const LOG_PATH = '/tmp/presence-patches.log'
const wsUrl = process.argv[2] || 'ws://localhost:3000/ws'
const token = process.argv[3]
const durationSec = Number(process.argv[4] || 5)

if (!token) {
  console.error('사용법: node measure-patches.js <wsUrl> <token> [duration_sec]')
  console.error('토큰은 /api/auth/login 응답에서 얻을 수 있습니다.')
  process.exit(1)
}

const t0 = Date.now()
const patches = []  // { at, path, size }
const byPath = {}   // path → count
const byPathWithinTurn = []  // working 중 도착한 것만

const mirror = createMirrorState({
  wsUrl,
  sessionId: 'user-default',
  getHeaders: () => ({ Authorization: `Bearer ${token}` }),
  onAuthFailed: async () => false,
  onUnrecoverable: (code) => {
    console.error(`WS 끊김: code=${code}`)
    process.exit(1)
  },
})

// bus.publish 를 wrap 해서 applyPatch 경로 모두 계측
const realPublish = mirror.bus.publish.bind(mirror.bus)
mirror.bus.publish = function (event, source) {
  const size = JSON.stringify(event.nextValue ?? null).length
  patches.push({ at: Date.now() - t0, path: event.path, size })
  byPath[event.path] = (byPath[event.path] || 0) + 1
  return realPublish(event, source)
}

console.log(`WS 연결 시도: ${wsUrl}`)
console.log(`측정 시간: ${durationSec}s — 그 동안 별도 TUI 에서 채팅을 보내 응답 대기 구간을 만드세요.`)

setTimeout(() => {
  mirror.disconnect()
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2)
  const report = [
    '=== FP-58 patch 계측 결과 ===',
    `측정 시간: ${elapsed}s`,
    `총 patch: ${patches.length}`,
    `patch/sec: ${(patches.length / Number(elapsed)).toFixed(1)}`,
    '',
    'path 별 수신 횟수 (많은 순):',
    ...Object.entries(byPath).sort((a, b) => b[1] - a[1]).map(([p, c]) => `  ${c.toString().padStart(4)}  ${p}`),
    '',
    '전체 타임라인 (+ms, path, size):',
    ...patches.map(p => `  +${p.at.toString().padStart(5)}ms  ${p.path.padEnd(35)}  ${p.size}b`),
  ].join('\n')
  fs.writeFileSync(LOG_PATH, report)
  console.log(`\n진단 로그 저장: ${LOG_PATH}`)
  process.exit(0)
}, durationSec * 1000)
