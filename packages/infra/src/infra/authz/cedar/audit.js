// Cedar audit writer — JSONL append + 0600 권한 보정 + 디렉토리 0700.
// evaluator 가 매 호출마다 audit.append(entry) 호출. entry 는 plain object.
//
// 권한 정책 (plan §357 + cedar-infra.md §7):
//   - 디렉토리: 신규 생성 시 0700 (다른 사용자 접근 차단)
//   - 파일: append 시 mode 0o600 + chmodSync 보정 (기존 파일이 0644 인 경우 0600 으로 강제)
//   - Windows POSIX 권한 의미 차이는 운영 가정 (macOS/Linux) 으로 범위 밖

import { appendFileSync, chmodSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import fp from '@presence/core/lib/fun-fp.js'

const { Reader } = fp

const ensureDir = (logPath) => {
  const dir = dirname(logPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
}

const safeChmod = (path, mode) => {
  try { chmodSync(path, mode) } catch { /* best effort — Windows / 권한 없음 */ }
}

const createAuditWriterR = Reader.asks(({ logPath }) => {
  if (typeof logPath !== 'string' || logPath.length === 0) {
    throw new Error('createAuditWriter: logPath 부재')
  }
  ensureDir(logPath)
  return {
    append: (entry) => {
      const line = JSON.stringify(entry) + '\n'
      appendFileSync(logPath, line, { mode: 0o600 })
      safeChmod(logPath, 0o600)
    },
  }
})

const createAuditWriter = (deps) => createAuditWriterR.run(deps)

export { createAuditWriter, createAuditWriterR }
