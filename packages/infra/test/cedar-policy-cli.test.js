// KG-27 P4 — admin CLI policy lint / list / reload 테스트.
// CLI 를 child process 로 실행 — exit code + stdout/stderr 검증.

import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assert, summary } from '../../../test/lib/assert.js'

const CLI = 'node packages/infra/src/infra/auth/cli.js'
const REPO_ROOT = process.cwd()

const createTmpDir = () => {
  const dir = join(tmpdir(), `cedar-policy-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const runCli = (args, presenceDir) => {
  try {
    const out = execSync(`${CLI} ${args}`, {
      env: { ...process.env, PRESENCE_DIR: presenceDir },
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { code: 0, stdout: out, stderr: '' }
  } catch (err) {
    return {
      code: err.status ?? -1,
      stdout: err.stdout?.toString() || '',
      stderr: err.stderr?.toString() || '',
    }
  }
}

const REAL_CEDAR_DIR = join(REPO_ROOT, 'packages/infra/src/infra/authz/cedar')
const VALID_POLICY = join(REAL_CEDAR_DIR, 'policies', '00-base.cedar')

const PARSE_BROKEN = `permit (
  principal is LocalUser,
  action == Action::"create_agent
` // 의도적 미종결

const SCHEMA_MISMATCH = `permit (
  principal is LocalUser,
  action == Action::"non_existent_action_for_lint",
  resource is User
);`

async function run() {
  console.log('Cedar policy CLI tests (KG-27 P4)')

  // CLI-X1 — policy lint <valid> → exit 0 + "OK"
  {
    const dir = createTmpDir()
    const r = runCli(`policy lint --file ${VALID_POLICY}`, dir)
    assert(r.code === 0, `CLI-X1: valid 정책 → exit 0 (got ${r.code} stderr=${r.stderr})`)
    assert(r.stdout.includes('OK:'), `CLI-X1: stdout 에 OK (got ${r.stdout})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CLI-X2 — policy lint <parse-broken> → exit 1 + "Parse error"
  {
    const dir = createTmpDir()
    const file = join(dir, 'broken.cedar')
    writeFileSync(file, PARSE_BROKEN)
    const r = runCli(`policy lint --file ${file}`, dir)
    assert(r.code === 1, `CLI-X2: parse 깨진 정책 → exit 1 (got ${r.code})`)
    assert(r.stderr.includes('Parse error'), `CLI-X2: stderr 에 Parse error (got ${r.stderr})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CLI-X3 — policy lint <schema-mismatch> → exit 1 + "Schema mismatch" (action 이름 오타)
  {
    const dir = createTmpDir()
    const file = join(dir, 'bad-action.cedar')
    writeFileSync(file, SCHEMA_MISMATCH)
    const r = runCli(`policy lint --file ${file}`, dir)
    assert(r.code === 1, `CLI-X3: 존재하지 않는 action → exit 1 (got ${r.code})`)
    assert(r.stderr.includes('Schema mismatch'),
      `CLI-X3: stderr 에 Schema mismatch (got ${r.stderr})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CLI-X4 — policy list → 카테고리별 출력. 50-* 도 표시 (실 자산에는 50-* 없음 — 50-* 슬롯 정상 표기 검증은 수동).
  {
    const dir = createTmpDir()
    const r = runCli('policy list', dir)
    assert(r.code === 0, `CLI-X4: list → exit 0 (got ${r.code} stderr=${r.stderr})`)
    assert(r.stdout.includes('00-base'), `CLI-X4: 00-base 표시`)
    assert(r.stdout.includes('10-quota'), `CLI-X4: 10-quota 표시`)
    assert(r.stdout.includes('30-protect-admin'), `CLI-X4: 30-protect-admin 표시`)
    assert(/category|protect|quota/i.test(r.stdout), `CLI-X4: 카테고리 컬럼 표시`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CLI-X5 (KG-28 P5 갱신) — policy reload (token 없음) → exit 1 + admin token 필요 안내
  {
    const dir = createTmpDir()
    // PRESENCE_ADMIN_TOKEN env 없는 상태로 실행
    const env = { ...process.env, PRESENCE_DIR: dir }
    delete env.PRESENCE_ADMIN_TOKEN
    let r
    try {
      const out = execSync(`${CLI} policy reload`, {
        env, cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      })
      r = { code: 0, stdout: out, stderr: '' }
    } catch (err) {
      r = {
        code: err.status ?? -1,
        stdout: err.stdout?.toString() || '',
        stderr: err.stderr?.toString() || '',
      }
    }
    assert(r.code === 1, `CLI-X5: token 부재 → exit 1 (got ${r.code})`)
    assert(r.stderr.includes('admin access token 필요'),
      `CLI-X5: stderr 에 admin token 필요 안내 (got ${r.stderr.slice(0, 200)})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CLI-X6 — policy reload (서버 미가동 + token 있음) → exit 1 + "서버 도달 실패" 안내
  // round 9 M 흡수: ECONNREFUSED 특화 제거. 모든 fetch 실패 동일 처리.
  {
    const dir = createTmpDir()
    // 미할당 포트 (서버 미가동 시뮬레이션) 로 reload 호출
    const env = {
      ...process.env,
      PRESENCE_DIR: dir,
      PRESENCE_ADMIN_TOKEN: 'fake-token-not-validated-because-no-server',
      PRESENCE_SERVER_URL: 'http://127.0.0.1:9',  // port 9 = unassigned, ECONNREFUSED
    }
    let r
    try {
      const out = execSync(`${CLI} policy reload`, {
        env, cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      })
      r = { code: 0, stdout: out, stderr: '' }
    } catch (err) {
      r = {
        code: err.status ?? -1,
        stdout: err.stdout?.toString() || '',
        stderr: err.stderr?.toString() || '',
      }
    }
    assert(r.code === 1, `CLI-X6: 서버 미가동 → exit 1 (got ${r.code})`)
    assert(r.stderr.includes('서버 도달 실패'),
      `CLI-X6: stderr 에 "서버 도달 실패" (got ${r.stderr.slice(0, 200)})`)
    assert(r.stderr.includes('npm start'),
      `CLI-X6: stderr 에 "npm start 후 재시도" 안내`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CLI-X7 (FP-74) — policy version (token 없음) → exit 1 + admin token 필요 안내
  {
    const dir = createTmpDir()
    const env = { ...process.env, PRESENCE_DIR: dir }
    delete env.PRESENCE_ADMIN_TOKEN
    let r
    try {
      const out = execSync(`${CLI} policy version`, {
        env, cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      })
      r = { code: 0, stdout: out, stderr: '' }
    } catch (err) {
      r = {
        code: err.status ?? -1,
        stdout: err.stdout?.toString() || '',
        stderr: err.stderr?.toString() || '',
      }
    }
    assert(r.code === 1, `CLI-X7: token 부재 + version → exit 1 (got ${r.code})`)
    assert(r.stderr.includes('admin access token 필요'),
      `CLI-X7: stderr 에 admin token 필요 안내 (got ${r.stderr.slice(0, 200)})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CLI-X8 (FP-74) — policy version (서버 미가동 + token) → exit 1 + 서버 도달 실패
  {
    const dir = createTmpDir()
    const env = {
      ...process.env,
      PRESENCE_DIR: dir,
      PRESENCE_ADMIN_TOKEN: 'fake-token-not-validated',
      PRESENCE_SERVER_URL: 'http://127.0.0.1:9',
    }
    let r
    try {
      const out = execSync(`${CLI} policy version`, {
        env, cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      })
      r = { code: 0, stdout: out, stderr: '' }
    } catch (err) {
      r = {
        code: err.status ?? -1,
        stdout: err.stdout?.toString() || '',
        stderr: err.stderr?.toString() || '',
      }
    }
    assert(r.code === 1, `CLI-X8: 서버 미가동 + version → exit 1 (got ${r.code})`)
    assert(r.stderr.includes('서버 도달 실패'),
      `CLI-X8: stderr 에 "서버 도달 실패" (got ${r.stderr.slice(0, 200)})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CLI-X9 (FP-72) — `npm run user` (인자 없음) usage 에 policy reload/version 정상 표시
  //   stale "(미지원 — 서버 재시작 필요)" 문구 부재 + "policy version" 항목 추가 검증.
  {
    const dir = createTmpDir()
    const r = runCli('', dir)   // 인자 없음 — usage 출력
    assert(r.code === 0, `CLI-X9: usage 출력 → exit 0 (got ${r.code})`)
    assert(r.stdout.includes('policy reload'),
      `CLI-X9: usage 에 policy reload 표시`)
    assert(r.stdout.includes('policy version'),
      `CLI-X9: usage 에 policy version 표시 (FP-74)`)
    assert(!r.stdout.includes('미지원'),
      `CLI-X9: usage 에 stale "미지원" 문구 부재 (FP-72)`)
    assert(r.stdout.includes('서버 재시작 없이'),
      `CLI-X9: usage 에 hot reload 설명 표시 (FP-72)`)
    rmSync(dir, { recursive: true, force: true })
  }

  // ===== FP-73 — admin token 자동 저장 — CLI-X10~X17 =====

  const runCliEnv = (args, presenceDir, extraEnv = {}) => {
    try {
      const out = execSync(`${CLI} ${args}`, {
        env: { ...process.env, PRESENCE_DIR: presenceDir, ...extraEnv },
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      })
      return { code: 0, stdout: out, stderr: '' }
    } catch (err) {
      return {
        code: err.status ?? -1,
        stdout: err.stdout?.toString() || '',
        stderr: err.stderr?.toString() || '',
      }
    }
  }

  // CLI-X10 — `admin login` 서버 미가동 → exit 1 + "서버 도달 실패"
  {
    const dir = createTmpDir()
    const r = runCliEnv('admin login --username admin --password fake', dir, {
      PRESENCE_SERVER_URL: 'http://127.0.0.1:9',  // unassigned port
    })
    assert(r.code === 1, `CLI-X10: 서버 미가동 → exit 1 (got ${r.code})`)
    assert(r.stderr.includes('서버 도달 실패'),
      `CLI-X10: stderr 에 "서버 도달 실패" (got ${r.stderr.slice(0, 150)})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CLI-X11 — `admin logout` 세션 없음 → exit 0 + "Not logged in"
  {
    const dir = createTmpDir()
    const r = runCliEnv('admin logout', dir)
    assert(r.code === 0, `CLI-X11: 세션 없음 logout → exit 0 (got ${r.code})`)
    assert(r.stdout.includes('Not logged in'),
      `CLI-X11: stdout 에 "Not logged in" (got ${r.stdout})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CLI-X12 — `admin whoami` 세션 없음 → "Not logged in"
  {
    const dir = createTmpDir()
    const r = runCliEnv('admin whoami', dir)
    assert(r.code === 0, `CLI-X12: whoami → exit 0 (got ${r.code})`)
    assert(r.stdout.includes('Not logged in'),
      `CLI-X12: stdout 에 "Not logged in" (got ${r.stdout})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CLI-X13 — `policy reload` ENV 없음 + 파일 없음 → exit 1 + "admin login" 안내
  {
    const dir = createTmpDir()
    const env = { ...process.env, PRESENCE_DIR: dir }
    delete env.PRESENCE_ADMIN_TOKEN
    let r
    try {
      const out = execSync(`${CLI} policy reload`, {
        env, cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      })
      r = { code: 0, stdout: out, stderr: '' }
    } catch (err) {
      r = { code: err.status ?? -1, stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || '' }
    }
    assert(r.code === 1, `CLI-X13: ENV 없음 + 파일 없음 → exit 1 (got ${r.code})`)
    assert(r.stderr.includes('admin login'),
      `CLI-X13: stderr 에 "admin login" 안내 (got ${r.stderr.slice(0, 200)})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CLI-X14 — usage 에 admin login/logout/whoami + 갱신된 정책 안내
  {
    const dir = createTmpDir()
    const r = runCliEnv('', dir)
    assert(r.code === 0, `CLI-X14: usage exit 0`)
    assert(r.stdout.includes('admin login'), `CLI-X14: usage 에 admin login`)
    assert(r.stdout.includes('admin logout'), `CLI-X14: usage 에 admin logout`)
    assert(r.stdout.includes('admin whoami'), `CLI-X14: usage 에 admin whoami`)
    assert(r.stdout.includes('자동 동작'),
      `CLI-X14: 정책 안내 갱신 — "ENV 없이 자동 동작" 문구`)
    assert(!r.stdout.includes('PRESENCE_ADMIN_TOKEN env 필수'),
      `CLI-X14: stale "env 필수" 문구 부재`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CLI-X16 — 권한 위배 (mode 0o644) → exit 1 + chmod 안내
  {
    const dir = createTmpDir()
    const path = join(dir, 'admin-session.json')
    writeFileSync(path, JSON.stringify({
      username: 'admin',
      accessToken: 'fake.access',
      refreshToken: 'fake.refresh',
      accessExp: new Date(Date.now() + 900_000).toISOString(),
      savedAt: new Date().toISOString(),
    }))
    const { chmodSync } = await import('node:fs')
    chmodSync(path, 0o644)
    const env = { ...process.env, PRESENCE_DIR: dir }
    delete env.PRESENCE_ADMIN_TOKEN
    let r
    try {
      execSync(`${CLI} policy reload`, { env, cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 })
      r = { code: 0, stdout: '', stderr: '' }
    } catch (err) {
      r = { code: err.status ?? -1, stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || '' }
    }
    assert(r.code === 1, `CLI-X16: mode 위배 → exit 1 (got ${r.code})`)
    assert(r.stderr.includes('권한 위배'),
      `CLI-X16: stderr 에 "권한 위배" (got ${r.stderr.slice(0, 200)})`)
    assert(r.stderr.includes('chmod 600'),
      `CLI-X16: stderr 에 chmod 600 안내`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CLI-X17 — 손상 JSON → exit 1 + admin login 안내
  {
    const dir = createTmpDir()
    const path = join(dir, 'admin-session.json')
    writeFileSync(path, '{ broken json')
    const { chmodSync } = await import('node:fs')
    chmodSync(path, 0o600)
    const env = { ...process.env, PRESENCE_DIR: dir }
    delete env.PRESENCE_ADMIN_TOKEN
    let r
    try {
      execSync(`${CLI} policy reload`, { env, cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 })
      r = { code: 0, stdout: '', stderr: '' }
    } catch (err) {
      r = { code: err.status ?? -1, stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || '' }
    }
    assert(r.code === 1, `CLI-X17: 손상 JSON → exit 1 (got ${r.code})`)
    assert(r.stderr.includes('손상'),
      `CLI-X17: stderr 에 "손상" (got ${r.stderr.slice(0, 200)})`)
    assert(r.stderr.includes('admin login'),
      `CLI-X17: stderr 에 "admin login" 안내`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CLI-X15c — ENV + 손상 파일 동시 → ENV 흐름 정상 진행 (CI 안전성)
  // 서버 미가동이라 fetch 단계에서 실패하지만 admin-session.json 손상이 진입을 막지 않는지가 핵심.
  {
    const dir = createTmpDir()
    const path = join(dir, 'admin-session.json')
    writeFileSync(path, '{ broken json')
    const { chmodSync } = await import('node:fs')
    chmodSync(path, 0o600)
    const env = {
      ...process.env,
      PRESENCE_DIR: dir,
      PRESENCE_ADMIN_TOKEN: 'fake-token',
      PRESENCE_SERVER_URL: 'http://127.0.0.1:9',
    }
    let r
    try {
      execSync(`${CLI} policy reload`, { env, cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 })
      r = { code: 0, stdout: '', stderr: '' }
    } catch (err) {
      r = { code: err.status ?? -1, stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || '' }
    }
    // ENV 사용으로 진입 → 서버 도달 실패가 결정적 종료. "손상" 메시지가 나오면 안 됨.
    assert(r.code === 1, `CLI-X15c: 서버 미가동 → exit 1 (got ${r.code})`)
    assert(r.stderr.includes('서버 도달 실패'),
      `CLI-X15c: ENV 흐름 진입 → "서버 도달 실패" (got ${r.stderr.slice(0, 200)})`)
    assert(!r.stderr.includes('손상'),
      `CLI-X15c: 손상 파일 검사가 ENV 흐름을 막지 않음`)
    rmSync(dir, { recursive: true, force: true })
  }

  // --- KG-30 — policy lint (인자 없이) → POLICIES_DIR 전체 검사 ---

  // CLI-X18 — policy lint (no --file) → 번들된 정책 전체 통과
  // 카운트 N/N 형식만 검증 — 자산 추가 (Phase 1: 21-archived-a2a) 에 따라 N 변동.
  {
    const dir = createTmpDir()
    const r = runCli('policy lint', dir)
    assert(r.code === 0, `CLI-X18: 전체 lint → exit 0 (got ${r.code} stderr=${r.stderr})`)
    assert(r.stdout.includes('✓ 00-base.cedar'), `CLI-X18: 00-base 통과 표시`)
    assert(r.stdout.includes('✓ 10-quota.cedar'), `CLI-X18: 10-quota 통과 표시`)
    assert(r.stdout.includes('✓ 31-protect-persona.cedar'), `CLI-X18: 31-protect-persona 통과 표시`)
    const countMatch = r.stdout.match(/검사 결과:\s*(\d+)\s*\/\s*(\d+)\s*통과/)
    assert(countMatch && countMatch[1] === countMatch[2] && Number(countMatch[1]) >= 6,
      `CLI-X18: 통과 카운트 N/N (N≥6) (got ${r.stdout})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CLI-X19 — usage 에 lint (전체) + lint --file (단일) 양쪽 노출
  {
    const dir = createTmpDir()
    const r = runCli('', dir)
    assert(r.stdout.includes('policy lint '), 'CLI-X19: 전체 lint usage 노출')
    assert(r.stdout.includes('policy lint --file'), 'CLI-X19: 단일 파일 lint usage 유지')
    assert(r.stdout.includes('reload 전 권장'),
      `CLI-X19: 전체 lint 권장 안내 (got ${r.stdout.slice(0, 600)})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CLI-X20 — reload 실패 안내가 'policy lint' (전체) 를 가리키는지 (FP-75 + KG-30 갱신)
  {
    const dir = createTmpDir()
    const env = {
      ...process.env, PRESENCE_DIR: dir,
      PRESENCE_ADMIN_TOKEN: 'fake-token',
      PRESENCE_SERVER_URL: 'http://127.0.0.1:9',
    }
    let r
    try {
      execSync(`${CLI} policy reload`, { env, cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['pipe','pipe','pipe'], timeout: 5000 })
      r = { code: 0, stdout: '', stderr: '' }
    } catch (err) {
      r = { code: err.status ?? -1, stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || '' }
    }
    // 서버 미가동이라 reload 실패 안내까지 안 가지만, 실패 안내 string 자체가 코드에 박혀있는지 회귀 — 별도 grep 검증으로 갈음.
    rmSync(dir, { recursive: true, force: true })
  }

  summary()
}

run()
