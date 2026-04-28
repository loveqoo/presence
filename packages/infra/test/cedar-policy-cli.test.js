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

  // CLI-X5 — policy reload → exit 1 + 미지원 안내 (P5 후속)
  {
    const dir = createTmpDir()
    const r = runCli('policy reload', dir)
    assert(r.code === 1, `CLI-X5: reload → exit 1 (got ${r.code})`)
    assert(r.stderr.includes('미지원'), `CLI-X5: stderr 에 미지원 안내 (got ${r.stderr})`)
    rmSync(dir, { recursive: true, force: true })
  }

  summary()
}

run()
