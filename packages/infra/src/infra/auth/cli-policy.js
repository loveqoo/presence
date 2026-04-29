// KG-27 P4 — Cedar 정책 운영자 CLI 핸들러. cli.js 의 main switch 에서 dispatchPolicy 호출.
// lint (parse + schema validate) / list (카테고리 표) / reload (P5 후속, hot reload).

import { readFileSync } from 'node:fs'
import { lintPolicyText, listPolicyFiles, readSchemaText } from '../authz/cedar/index.js'
import { requireFlag } from './cli-utils.js'

// CLI handler 가 throw 하면 dispatchPolicy 가 catch + process.exit(1) 로 단일 수렴.
// 각 handler 는 비즈니스 로직만 — exit 처리는 dispatch 경계.
class CliPolicyError extends Error {
  constructor(stderrMessage) {
    super(stderrMessage)
    this.name = 'CliPolicyError'
  }
}

async function cmdPolicyLint({ file }) {
  const text = readFileSync(file, 'utf-8')
  const schemaText = readSchemaText()
  const result = await lintPolicyText({ text, schemaText })
  if (result.ok) {
    console.log(`OK: ${file}`)
    return
  }
  if (result.parseErrors.length > 0) {
    const lines = [`Parse error: ${file}`]
    for (const e of result.parseErrors) {
      lines.push(`  ${e.message ?? JSON.stringify(e)}`)
    }
    throw new CliPolicyError(lines.join('\n'))
  }
  if (result.schemaErrors.length > 0) {
    const lines = [`Schema mismatch: ${file}`]
    for (const e of result.schemaErrors) {
      const msg = e?.error?.message ?? e?.message ?? JSON.stringify(e)
      lines.push(`  ${msg}`)
    }
    throw new CliPolicyError(lines.join('\n'))
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
// PRESENCE_ADMIN_TOKEN env 의 admin access token 으로 인증.
//
// 단계 분리 — 함수 길이 단축 + Either-style 단일 exit 수렴점:
//   resolveAdminToken → fetchReload → handleAuthError → printReloadSuccess / formatReloadFailure
// 각 단계는 throw 또는 return 으로 dispatch — process.exit 는 dispatchPolicy 에서만 호출.

const RELOAD_PATH = '/api/admin/policy/reload'

const resolveAdminToken = () => {
  const token = process.env.PRESENCE_ADMIN_TOKEN
  if (!token) {
    throw new CliPolicyError([
      'policy reload: admin access token 필요.',
      '  1. admin 으로 로그인 — POST /api/auth/login',
      '  2. 응답의 access token 을 PRESENCE_ADMIN_TOKEN env 에 설정',
      '  3. 다시 실행 — npm run user -- policy reload',
      '  주의: process listing 으로 token 노출 가능. 신뢰된 환경에서만 사용.',
    ].join('\n'))
  }
  return token
}

const fetchReload = async (baseUrl, token) => {
  try {
    return await fetch(`${baseUrl}${RELOAD_PATH}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    })
  } catch (err) {
    // round 9 M 흡수: ECONNREFUSED 특화 제거. 모든 fetch 실패 동일 처리.
    throw new CliPolicyError([
      `policy reload: 서버 도달 실패 — ${err.message}`,
      '  서버 가동 상태 확인 후 재시도 — npm start',
    ].join('\n'))
  }
}

const printReloadSuccess = (body) => {
  console.log(`OK: 정책 reload 성공. version=${body.version}`)
  console.log(`     reloadStartedAt=${body.reloadStartedAt} reloadedAt=${body.reloadedAt}`)
  console.log('Tip: 자기 reload 가 새로 시작됐는지 확인하려면 명시적 두 번째 호출 후 reloadStartedAt 변화 관찰.')
  console.log('Tip: 변경 적용 전 lint 권장 — npm run user -- policy lint --file <path>')
}

const formatReloadFailure = (body) => {
  const lines = [`policy reload 실패: ${body.error}`]
  if (body.activeVersion != null) {
    lines.push(`  활성 정책: version=${body.activeVersion} reloadedAt=${body.activeReloadedAt}`)
  }
  lines.push('이전 정책이 유지됩니다 (fail-safe rollback — 메모리 내 evaluator 미교체).')
  lines.push('디스크 정책 파일 상태는 변경되지 않음 — 운영자가 별도 정정 필요.')
  return lines.join('\n')
}

async function cmdPolicyReload() {
  const baseUrl = process.env.PRESENCE_SERVER_URL || 'http://localhost:3000'
  const token = resolveAdminToken()
  const response = await fetchReload(baseUrl, token)
  if (response.status === 401 || response.status === 403) {
    throw new CliPolicyError(`policy reload: 권한 없음 (HTTP ${response.status}). admin role 토큰 사용 확인.`)
  }
  const body = await response.json()
  if (response.ok) {
    printReloadSuccess(body)
    return
  }
  throw new CliPolicyError(formatReloadFailure(body))
}

export const dispatchPolicy = async (action, flags) => {
  try {
    switch (action) {
      case 'lint':   return await cmdPolicyLint({ file: requireFlag(flags, 'file') })
      case 'list':   return cmdPolicyList()
      case 'reload': return await cmdPolicyReload()
      default:
        throw new CliPolicyError(`Unknown policy action: ${action}\nActions: lint, list, reload`)
    }
  } catch (err) {
    if (err instanceof CliPolicyError) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }
}
