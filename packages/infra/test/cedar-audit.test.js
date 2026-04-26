// Cedar audit writer 단위 테스트 (CA1~CA6) — Y' 인프라 phase
// JSONL append + 0600 권한 + 디렉토리 0700 검증.

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { gunzipSync } from 'zlib'
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

  // --- KG-25: size-based rotation ---

  // CA7 — maxBytes 초과 시 회전 (현재 → .1.gz, 새 빈 파일에 append)
  {
    const dir = createTmpDir('ca7')
    const logPath = join(dir, 'logs', 'authz-audit.log')
    const writer = createAuditWriter({ logPath, maxBytes: 200, maxBackups: 5 })
    // 200 bytes 초과 누적
    for (let i = 0; i < 10; i += 1) writer.append({ ...sampleEntry, n: i })
    // .1.gz 가 생성되어야 함
    assert(existsSync(`${logPath}.1.gz`), 'CA7: rotation 후 .1.gz 생성')
    // 현재 로그도 존재 (rotation 직후 새 entry append)
    assert(existsSync(logPath), 'CA7: rotation 후 새 로그 파일 존재')
    // .1.gz 압축 해제 시 JSONL 복원 가능
    const archived = gunzipSync(readFileSync(`${logPath}.1.gz`)).toString('utf-8')
    assert(archived.split('\n').filter(l => l.length > 0).length > 0, 'CA7: archived 내용 복원 가능')
    rmSync(dir, { recursive: true, force: true })
  }

  // CA8 — maxBackups 초과 시 가장 오래된 백업 삭제 + cascade
  {
    const dir = createTmpDir('ca8')
    const logPath = join(dir, 'logs', 'authz-audit.log')
    const writer = createAuditWriter({ logPath, maxBytes: 100, maxBackups: 3 })
    // 충분히 많이 append 하여 7회 이상 rotation 유도
    for (let i = 0; i < 100; i += 1) writer.append({ ...sampleEntry, n: i, padding: 'x'.repeat(50) })
    // .1.gz ~ .3.gz 만 존재, .4.gz 이상은 삭제됨
    assert(existsSync(`${logPath}.1.gz`), 'CA8: .1.gz 존재')
    assert(existsSync(`${logPath}.2.gz`), 'CA8: .2.gz 존재')
    assert(existsSync(`${logPath}.3.gz`), 'CA8: .3.gz 존재')
    assert(!existsSync(`${logPath}.4.gz`), 'CA8: .4.gz 미존재 (maxBackups=3 초과 삭제)')
    rmSync(dir, { recursive: true, force: true })
  }

  // CA9 — 백업 파일도 0600 권한
  {
    const dir = createTmpDir('ca9')
    const logPath = join(dir, 'logs', 'authz-audit.log')
    const writer = createAuditWriter({ logPath, maxBytes: 100, maxBackups: 5 })
    for (let i = 0; i < 20; i += 1) writer.append({ ...sampleEntry, n: i })
    assert(existsSync(`${logPath}.1.gz`), 'CA9: .1.gz 생성 사전 조건')
    assert(modeOf(`${logPath}.1.gz`) === 0o600, `CA9: 백업 파일 0600 (got ${modeOf(`${logPath}.1.gz`).toString(8)})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CA10 — 기본값 사용 시 rotation 발생 안 함 (10MB 미만에서 정상 append)
  {
    const dir = createTmpDir('ca10')
    const logPath = join(dir, 'logs', 'authz-audit.log')
    const writer = createAuditWriter({ logPath })
    for (let i = 0; i < 5; i += 1) writer.append({ ...sampleEntry, n: i })
    assert(!existsSync(`${logPath}.1.gz`), 'CA10: 기본 maxBytes(10MB) 미만에서 rotation 안 일어남')
    const lines = readFileSync(logPath, 'utf-8').split('\n').filter(l => l.length > 0)
    assert(lines.length === 5, `CA10: 5 줄 모두 보존 (got ${lines.length})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CA11 — cascade 정확성: 회전마다 .1.gz 가 가장 새것이고 .(N).gz 가 가장 오래됨.
  // A 세대 2 append (회전 1번) + B 세대 2 append (회전 2번 추가) 로 .1=B, .2=A 보존 확인.
  {
    const dir = createTmpDir('ca11')
    const logPath = join(dir, 'logs', 'authz-audit.log')
    const writer = createAuditWriter({ logPath, maxBytes: 200, maxBackups: 3 })
    // A1 append (size=0 → 회전 X), A2 append (size>=200 → 회전: .1.gz=A1, current=A2)
    writer.append({ ...sampleEntry, gen: 'A', n: 1, padding: 'x'.repeat(100) })
    writer.append({ ...sampleEntry, gen: 'A', n: 2, padding: 'x'.repeat(100) })
    // B1 append (회전: .1.gz=A2, .2.gz=A1, current=B1)
    writer.append({ ...sampleEntry, gen: 'B', n: 1, padding: 'x'.repeat(100) })
    // B2 append (회전: .1.gz=B1, .2.gz=A2, .3.gz=A1, current=B2)
    writer.append({ ...sampleEntry, gen: 'B', n: 2, padding: 'x'.repeat(100) })

    const gen1 = gunzipSync(readFileSync(`${logPath}.1.gz`)).toString('utf-8')
    const gen2 = gunzipSync(readFileSync(`${logPath}.2.gz`)).toString('utf-8')
    const gen3 = gunzipSync(readFileSync(`${logPath}.3.gz`)).toString('utf-8')
    assert(gen1.includes('"gen":"B"') && gen1.includes('"n":1'), 'CA11: .1.gz 가 가장 최근 (B1)')
    assert(gen2.includes('"gen":"A"') && gen2.includes('"n":2'), 'CA11: .2.gz 가 이전 세대 (A2)')
    assert(gen3.includes('"gen":"A"') && gen3.includes('"n":1'), 'CA11: .3.gz 가 가장 오래된 (A1)')
    rmSync(dir, { recursive: true, force: true })
  }

  // CA12 — FP-70: rotation 발생 시 logger.info 한 번 호출, rotation 안 일어나면 호출 없음
  {
    const dir = createTmpDir('ca12')
    const logPath = join(dir, 'logs', 'authz-audit.log')
    const lines = []
    const logger = { info: (msg) => lines.push(msg) }
    const writer = createAuditWriter({ logPath, maxBytes: 200, maxBackups: 5, logger })

    // 첫 append: rotation 미발생 (size 0)
    writer.append({ ...sampleEntry, n: 1, padding: 'x'.repeat(150) })
    assert(lines.length === 0, `CA12: 첫 append (rotation 미발생) → logger 호출 없음 (got ${lines.length})`)

    // 두 번째 append: 직전 size 가 200 초과 → rotation 발생
    writer.append({ ...sampleEntry, n: 2, padding: 'x'.repeat(150) })
    assert(lines.length === 1, `CA12: rotation 1 회 → logger 1 회 호출 (got ${lines.length})`)
    assert(lines[0].includes('[cedar-audit] rotation'), `CA12: 메시지 prefix 일치 (got ${lines[0]})`)
    assert(lines[0].includes('authz-audit.log'), `CA12: 파일명 포함 (got ${lines[0]})`)
    assert(lines[0].includes('backups: 1/5'), `CA12: 백업 카운트 1/5 (got ${lines[0]})`)
    assert(/size: \d+\.\d MB/.test(lines[0]), `CA12: size MB 포맷 (got ${lines[0]})`)

    // 세 번째 append: 또 rotation → 백업 2/5
    writer.append({ ...sampleEntry, n: 3, padding: 'x'.repeat(150) })
    assert(lines.length === 2, `CA12: rotation 2 회 누적 (got ${lines.length})`)
    assert(lines[1].includes('backups: 2/5'), `CA12: 두 번째 rotation 후 백업 2/5 (got ${lines[1]})`)

    rmSync(dir, { recursive: true, force: true })
  }

  // CA13 — logger 미주입 시 silent (기존 호출처 호환)
  {
    const dir = createTmpDir('ca13')
    const logPath = join(dir, 'logs', 'authz-audit.log')
    const writer = createAuditWriter({ logPath, maxBytes: 200, maxBackups: 5 })
    // throw 없이 진행되면 OK
    for (let i = 0; i < 5; i += 1) writer.append({ ...sampleEntry, n: i, padding: 'x'.repeat(150) })
    assert(existsSync(`${logPath}.1.gz`), 'CA13: logger 없어도 rotation 정상 작동')
    rmSync(dir, { recursive: true, force: true })
  }

  summary()
}

run()
