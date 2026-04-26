// Cedar audit writer — JSONL append + 0600 권한 보정 + 디렉토리 0700 + size-based rotation (KG-25).
// evaluator 가 매 호출마다 audit.append(entry) 호출. entry 는 plain object.
//
// 권한 정책 (plan §357 + cedar-infra.md §7):
//   - 디렉토리: 신규 생성 시 0700 (다른 사용자 접근 차단)
//   - 파일: append 시 mode 0o600 + chmodSync 보정 (기존 파일이 0644 인 경우 0600 으로 강제)
//   - Windows POSIX 권한 의미 차이는 운영 가정 (macOS/Linux) 으로 범위 밖
//
// Rotation 정책 (KG-25, cedar-infra.md §7 1차 옵션):
//   - size 가 maxBytes 초과 시 회전. 기본 10MB.
//   - 현재 파일 → `.1.gz` (gzip 압축, 0600). 기존 `.1.gz` 부터 `.(N).gz` 까지 cascade shift.
//   - `.maxBackups.gz` 초과분은 삭제. 기본 5 파일 보존.
//   - 매 append 직전 statSync 한 번 → microsecond 비용, 동기 처리.
//   - 단일 프로세스 가정 — 멀티 프로세스 동시 append 시 race 가능 (Y' 단계 범위 밖).

import {
  appendFileSync, chmodSync, existsSync, mkdirSync,
  readFileSync, writeFileSync, renameSync, unlinkSync, statSync,
} from 'fs'
import { dirname } from 'path'
import { gzipSync } from 'zlib'
import fp from '@presence/core/lib/fun-fp.js'

const { Reader } = fp

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_BACKUPS = 5

const ensureDir = (logPath) => {
  const dir = dirname(logPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
}

const safeChmod = (path, mode) => {
  try { chmodSync(path, mode) } catch { /* best effort — Windows / 권한 없음 */ }
}

const safeUnlink = (path) => {
  try { if (existsSync(path)) unlinkSync(path) } catch { /* best effort */ }
}

// .N.gz → .(N+1).gz cascade. 역순 순회로 덮어쓰기 방지.
// .maxBackups.gz 는 cascade 전에 삭제 (없을 수도 있음).
const cascadeBackups = (logPath, maxBackups) => {
  safeUnlink(`${logPath}.${maxBackups}.gz`)
  for (let i = maxBackups - 1; i >= 1; i -= 1) {
    const src = `${logPath}.${i}.gz`
    const dst = `${logPath}.${i + 1}.gz`
    if (existsSync(src)) renameSync(src, dst)
  }
}

// 현재 로그 → .1.gz. 압축 후 원본 삭제.
const archiveCurrent = (logPath) => {
  const content = readFileSync(logPath)
  const gz = gzipSync(content)
  const dest = `${logPath}.1.gz`
  writeFileSync(dest, gz, { mode: 0o600 })
  safeChmod(dest, 0o600)
  unlinkSync(logPath)
}

const rotateIfNeeded = (logPath, maxBytes, maxBackups) => {
  if (!existsSync(logPath)) return
  if (statSync(logPath).size < maxBytes) return
  cascadeBackups(logPath, maxBackups)
  archiveCurrent(logPath)
}

const createAuditWriterR = Reader.asks((env) => {
  const { logPath, maxBytes, maxBackups } = env
  if (typeof logPath !== 'string' || logPath.length === 0) {
    throw new Error('createAuditWriter: logPath 부재')
  }
  const limitBytes = maxBytes ?? DEFAULT_MAX_BYTES
  const limitBackups = maxBackups ?? DEFAULT_MAX_BACKUPS
  ensureDir(logPath)
  return {
    append: (entry) => {
      rotateIfNeeded(logPath, limitBytes, limitBackups)
      const line = JSON.stringify(entry) + '\n'
      appendFileSync(logPath, line, { mode: 0o600 })
      safeChmod(logPath, 0o600)
    },
  }
})

const createAuditWriter = (deps) => createAuditWriterR.run(deps)

export { createAuditWriter, createAuditWriterR, DEFAULT_MAX_BYTES, DEFAULT_MAX_BACKUPS }
