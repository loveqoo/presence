// KG-27 P4 — Cedar 정책 운영자 CLI 핸들러. cli.js 의 main switch 에서 dispatchPolicy 호출.
// lint (parse + schema validate) / list (카테고리 표) / reload (미지원, P5 후속).

import { readFileSync } from 'node:fs'
import { lintPolicyText, listPolicyFiles, readSchemaText } from '../authz/cedar/index.js'
import { requireFlag } from './cli-utils.js'

async function cmdPolicyLint({ file }) {
  const text = readFileSync(file, 'utf-8')
  const schemaText = readSchemaText()
  const result = await lintPolicyText({ text, schemaText })
  if (result.ok) {
    console.log(`OK: ${file}`)
    return
  }
  if (result.parseErrors.length > 0) {
    console.error(`Parse error: ${file}`)
    for (const e of result.parseErrors) {
      console.error(`  ${e.message ?? JSON.stringify(e)}`)
    }
    process.exit(1)
    return
  }
  if (result.schemaErrors.length > 0) {
    console.error(`Schema mismatch: ${file}`)
    for (const e of result.schemaErrors) {
      const msg = e?.error?.message ?? e?.message ?? JSON.stringify(e)
      console.error(`  ${msg}`)
    }
    process.exit(1)
  }
}

function cmdPolicyList() {
  const files = listPolicyFiles()
  if (files.length === 0) {
    console.log('(no policies)')
    return
  }
  const widthName = Math.max(...files.map(f => f.filename.length), 'filename'.length)
  const widthCat = Math.max(...files.map(f => f.category.length), 'category'.length)
  console.log(`${'filename'.padEnd(widthName)}  ${'category'.padEnd(widthCat)}  size`)
  console.log(`${'-'.repeat(widthName)}  ${'-'.repeat(widthCat)}  ----`)
  for (const f of files) {
    console.log(`${f.filename.padEnd(widthName)}  ${f.category.padEnd(widthCat)}  ${f.size} B`)
  }
}

// KG-28 P5 — POST /api/admin/policy/reload 호출. 서버 측 hot reload 트리거.
// PRESENCE_ADMIN_TOKEN env 의 admin access token 으로 인증. 서버 미가동 / 권한 / 부팅 실패 분기.
async function cmdPolicyReload() {
  const baseUrl = process.env.PRESENCE_SERVER_URL || 'http://localhost:3000'
  const token = process.env.PRESENCE_ADMIN_TOKEN
  if (!token) {
    console.error('policy reload: admin access token 필요.')
    console.error('  1. admin 으로 로그인 — POST /api/auth/login')
    console.error('  2. 응답의 access token 을 PRESENCE_ADMIN_TOKEN env 에 설정')
    console.error('  3. 다시 실행 — npm run user -- policy reload')
    console.error('  주의: process listing 으로 token 노출 가능. 신뢰된 환경에서만 사용.')
    process.exit(1)
  }
  let response
  try {
    response = await fetch(`${baseUrl}/api/admin/policy/reload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    })
  } catch (err) {
    // round 9 M 흡수: ECONNREFUSED 특화 제거. 모든 fetch 실패 동일 처리.
    console.error(`policy reload: 서버 도달 실패 — ${err.message}`)
    console.error('  서버 가동 상태 확인 후 재시도 — npm start')
    process.exit(1)
  }
  if (response.status === 401 || response.status === 403) {
    console.error(`policy reload: 권한 없음 (HTTP ${response.status}). admin role 토큰 사용 확인.`)
    process.exit(1)
  }
  const body = await response.json()
  if (response.ok) {
    console.log(`OK: 정책 reload 성공. version=${body.version}`)
    console.log(`     reloadStartedAt=${body.reloadStartedAt} reloadedAt=${body.reloadedAt}`)
    console.log('Tip: 자기 reload 가 새로 시작됐는지 확인하려면 명시적 두 번째 호출 후 reloadStartedAt 변화 관찰.')
    console.log('Tip: 변경 적용 전 lint 권장 — npm run user -- policy lint --file <path>')
    return
  }
  console.error(`policy reload 실패: ${body.error}`)
  if (body.activeVersion != null) {
    console.error(`  활성 정책: version=${body.activeVersion} reloadedAt=${body.activeReloadedAt}`)
  }
  console.error('이전 정책이 유지됩니다 (fail-safe rollback — 메모리 내 evaluator 미교체).')
  console.error('디스크 정책 파일 상태는 변경되지 않음 — 운영자가 별도 정정 필요.')
  process.exit(1)
}

export const dispatchPolicy = async (action, flags) => {
  switch (action) {
    case 'lint':   return cmdPolicyLint({ file: requireFlag(flags, 'file') })
    case 'list':   return cmdPolicyList()
    case 'reload': return cmdPolicyReload()
    default:
      console.error(`Unknown policy action: ${action}`)
      console.error('Actions: lint, list, reload')
      process.exit(1)
  }
}
