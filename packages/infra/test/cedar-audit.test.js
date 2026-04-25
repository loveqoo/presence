// Cedar audit writer 단위 테스트 (CA1~CA6) — Y' 인프라 phase
// JSONL append + 0600 권한 + 디렉토리 0700 검증.

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { createAuditWriter, createAuditWriterR } from '@presence/infra/infra/authz/cedar/audit.js'
import { assert, summary } from '../../../test/lib/assert.js'

const createTmpDir = (label) => {
  const dir = join(tmpdir(), `cedar-audit-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

// POSIX permission bits (mode & 0o777)
const modeOf = (path) => statSync(path).mode & 0o777

const sampleEntry = {
  ts: '2026-04-26T01:00:00.000Z',
  caller: 'admin',
  action: 'create_agent',
  resource: 'admin',
  decision: 'allow',
  matchedPolicies: ['policy0'],
  errors: [],
}

const run = () => {
  console.log('Cedar audit tests')

  // CA1 — append 후 JSONL 한 줄 정확 (jq 파싱 가능) — CI-Y4
  {
    const dir = createTmpDir('ca1')
    const logPath = join(dir, 'logs', 'authz-audit.log')
    const writer = createAuditWriter({ logPath })
    writer.append(sampleEntry)
    writer.append({ ...sampleEntry, decision: 'deny', matchedPolicies: ['50-custom'] })

    const raw = readFileSync(logPath, 'utf-8')
    const lines = raw.split('\n').filter(l => l.length > 0)
    assert(lines.length === 2, `CA1: 2 줄 (got ${lines.length})`)

    const parsed0 = JSON.parse(lines[0])
    const parsed1 = JSON.parse(lines[1])
    assert(parsed0.decision === 'allow' && parsed0.caller === 'admin', 'CA1: line 0 decision=allow caller=admin')
    assert(parsed1.decision === 'deny' && parsed1.matchedPolicies[0] === '50-custom', 'CA1: line 1 decision=deny matchedPolicies')
    assert(raw.endsWith('\n'), 'CA1: 마지막에 newline 있음')
    rmSync(dir, { recursive: true, force: true })
  }

  // CA2 — 새 파일 생성 시 0600 권한
  {
    const dir = createTmpDir('ca2')
    const logPath = join(dir, 'logs', 'authz-audit.log')
    const writer = createAuditWriter({ logPath })
    writer.append(sampleEntry)
    assert(modeOf(logPath) === 0o600, `CA2: 파일 0600 (got ${modeOf(logPath).toString(8)})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CA3 — 기존 파일 권한이 0644 면 0600 으로 보정
  {
    const dir = createTmpDir('ca3')
    const logDir = join(dir, 'logs')
    mkdirSync(logDir, { recursive: true })
    const logPath = join(logDir, 'authz-audit.log')
    writeFileSync(logPath, '')
    chmodSync(logPath, 0o644)
    assert(modeOf(logPath) === 0o644, `CA3: 사전 조건 0644 (got ${modeOf(logPath).toString(8)})`)

    const writer = createAuditWriter({ logPath })
    writer.append(sampleEntry)
    assert(modeOf(logPath) === 0o600, `CA3: append 후 0600 보정 (got ${modeOf(logPath).toString(8)})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CA4 — 디렉토리 부재 시 0700 으로 생성
  {
    const dir = createTmpDir('ca4')
    const logDir = join(dir, 'logs')
    const logPath = join(logDir, 'authz-audit.log')
    assert(!existsSync(logDir), 'CA4: 사전 조건 디렉토리 없음')

    createAuditWriter({ logPath })
    assert(existsSync(logDir), 'CA4: 디렉토리 자동 생성')
    const dirMode = modeOf(logDir)
    // umask 영향 받을 수 있으나 mkdirSync 의 mode 옵션은 바닥값. 0700 이상 (other 비트 0) 이면 OK.
    assert((dirMode & 0o077) === 0, `CA4: 디렉토리 group/other 비트 0 (got ${dirMode.toString(8)})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CA5 — append 한 번 = 한 줄 (idempotency 보장 안 함, 매 호출이 1 entry)
  {
    const dir = createTmpDir('ca5')
    const logPath = join(dir, 'logs', 'authz-audit.log')
    const writer = createAuditWriter({ logPath })
    for (let i = 0; i < 5; i += 1) writer.append({ ...sampleEntry, n: i })
    const lines = readFileSync(logPath, 'utf-8').split('\n').filter(l => l.length > 0)
    assert(lines.length === 5, `CA5: 5 호출 → 5 줄 (got ${lines.length})`)
    const parsed = lines.map(l => JSON.parse(l))
    for (let i = 0; i < 5; i += 1) {
      assert(parsed[i].n === i, `CA5: 순서 보존 [${i}]`)
    }
    rmSync(dir, { recursive: true, force: true })
  }

  // CA5b — logPath 부재/빈문자열 → throw
  {
    let threw = false
    try { createAuditWriter({ logPath: '' }) } catch (_) { threw = true }
    assert(threw, 'CA5b: logPath 빈문자열 → throw')

    threw = false
    try { createAuditWriter({}) } catch (_) { threw = true }
    assert(threw, 'CA5b: logPath 부재 → throw')
  }

  // CA6 — Reader 브릿지 동치
  {
    const dirA = createTmpDir('ca6a')
    const dirB = createTmpDir('ca6b')
    const pathA = join(dirA, 'logs', 'authz-audit.log')
    const pathB = join(dirB, 'logs', 'authz-audit.log')
    const wA = createAuditWriter({ logPath: pathA })
    const wB = createAuditWriterR.run({ logPath: pathB })
    wA.append(sampleEntry)
    wB.append(sampleEntry)
    const ra = readFileSync(pathA, 'utf-8')
    const rb = readFileSync(pathB, 'utf-8')
    assert(ra === rb, 'CA6: 동일 entry 동일 출력')
    assert(modeOf(pathA) === modeOf(pathB), 'CA6: 권한 동일')
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }

  summary()
}

run()
