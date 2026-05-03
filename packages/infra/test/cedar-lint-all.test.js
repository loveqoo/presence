// KG-30 — lintAllPolicies 단위 테스트.
// 격리 디렉토리에서 통과/실패 케이스를 검증. CLI 통합은 cedar-policy-cli.test.js 가 담당.

import { mkdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { lintAllPolicies, POLICIES_DIR } from '../src/infra/authz/cedar/index.js'
import { assert, summary } from '../../../test/lib/assert.js'

const SCHEMA_PATH = join(POLICIES_DIR, '..', 'schema.cedarschema')

const VALID_POLICY = `permit (
  principal is LocalUser,
  action == Action::"create_agent",
  resource is User
);`

const PARSE_BROKEN = `permit (
  principal is LocalUser,
  action == Action::"create_agent
` // 의도적 미종결

const SCHEMA_MISMATCH = `permit (
  principal is LocalUser,
  action == Action::"non_existent_action_for_lint",
  resource is User
);`

const createTmpPoliciesDir = () => {
  const dir = join(tmpdir(), `cedar-lint-all-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function run() {
  console.log('Cedar lintAllPolicies tests (KG-30)')

  // LA1 — 빈 디렉토리 → 빈 배열
  {
    const dir = createTmpPoliciesDir()
    const results = await lintAllPolicies(dir, SCHEMA_PATH)
    assert(Array.isArray(results) && results.length === 0,
      `LA1: 빈 디렉토리 → [] (got ${JSON.stringify(results)})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // LA2 — 모든 파일 통과 → 결과 배열의 ok 모두 true
  {
    const dir = createTmpPoliciesDir()
    writeFileSync(join(dir, '50-a.cedar'), VALID_POLICY)
    writeFileSync(join(dir, '50-b.cedar'), VALID_POLICY)
    const results = await lintAllPolicies(dir, SCHEMA_PATH)
    assert(results.length === 2, `LA2: 2개 파일 (got ${results.length})`)
    assert(results.every(r => r.ok === true), `LA2: 모두 ok=true`)
    assert(results[0].filename === '50-a.cedar', 'LA2: filename 0')
    assert(results[1].filename === '50-b.cedar', 'LA2: filename 1 (정렬)')
    assert(results[0].fullPath.includes('50-a.cedar'), 'LA2: fullPath 포함')
    rmSync(dir, { recursive: true, force: true })
  }

  // LA3 — 일부 실패 → 첫 실패에서 멈추지 않고 끝까지 진행
  {
    const dir = createTmpPoliciesDir()
    writeFileSync(join(dir, '50-good.cedar'), VALID_POLICY)
    writeFileSync(join(dir, '50-broken.cedar'), PARSE_BROKEN)
    writeFileSync(join(dir, '50-zlast.cedar'), VALID_POLICY)
    const results = await lintAllPolicies(dir, SCHEMA_PATH)
    assert(results.length === 3, `LA3: 3개 파일 (got ${results.length})`)
    const goodResult = results.find(r => r.filename === '50-good.cedar')
    const brokenResult = results.find(r => r.filename === '50-broken.cedar')
    const zlastResult = results.find(r => r.filename === '50-zlast.cedar')
    assert(goodResult.ok === true, 'LA3: good ok=true')
    assert(brokenResult.ok === false, 'LA3: broken ok=false')
    assert(brokenResult.parseErrors.length > 0, 'LA3: broken parse errors')
    assert(zlastResult.ok === true, 'LA3: zlast 도 검사됨 (broken 에서 멈추지 않음)')
    rmSync(dir, { recursive: true, force: true })
  }

  // LA4 — schema mismatch (action 이름 오타) → schemaErrors 채워짐
  {
    const dir = createTmpPoliciesDir()
    writeFileSync(join(dir, '50-bad-action.cedar'), SCHEMA_MISMATCH)
    const results = await lintAllPolicies(dir, SCHEMA_PATH)
    assert(results.length === 1, `LA4: 1개 파일`)
    assert(results[0].ok === false, 'LA4: 실패 표시')
    assert(results[0].parseErrors.length === 0, 'LA4: parse 자체는 OK')
    assert(results[0].schemaErrors.length > 0, 'LA4: schema 오류 채워짐')
    rmSync(dir, { recursive: true, force: true })
  }

  // LA5 — .cedar 가 아닌 파일은 무시
  {
    const dir = createTmpPoliciesDir()
    writeFileSync(join(dir, '50-a.cedar'), VALID_POLICY)
    writeFileSync(join(dir, 'README.md'), '# not a policy')
    writeFileSync(join(dir, '.hidden'), 'x')
    const results = await lintAllPolicies(dir, SCHEMA_PATH)
    assert(results.length === 1, `LA5: .cedar 만 1개 (got ${results.length})`)
    assert(results[0].filename === '50-a.cedar', 'LA5: cedar 파일만')
    rmSync(dir, { recursive: true, force: true })
  }

  // LA6 — 번들된 실 자산 (POLICIES_DIR) 6개 모두 통과 (회귀 가드)
  {
    const results = await lintAllPolicies()
    assert(results.length === 6, `LA6: 번들된 정책 6개 (got ${results.length})`)
    const fails = results.filter(r => !r.ok)
    assert(fails.length === 0,
      `LA6: 번들 자산 회귀 — 모두 통과 기대 (실패: ${fails.map(r => r.filename).join(', ')})`)
  }

  // LA7 — schemaText 누락 시 (schema 파일 부재) parse 만 검증
  {
    const dir = createTmpPoliciesDir()
    writeFileSync(join(dir, '50-a.cedar'), SCHEMA_MISMATCH)  // schema 없으면 통과해야 함 (parse 만 OK)
    const noSchemaPath = join(dir, 'nope.cedarschema')  // 존재하지 않음
    const results = await lintAllPolicies(dir, noSchemaPath)
    assert(results[0].ok === true, 'LA7: schema 없으면 parse 만 검증, 통과')
    rmSync(dir, { recursive: true, force: true })
  }

  summary()
}

run().catch(err => { console.error(err); process.exit(1) })
