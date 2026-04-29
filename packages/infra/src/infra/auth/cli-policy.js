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
//   resolveAdminToken → fetchAdmin → handleAuthError → printReloadSuccess / formatReloadFailure
// 각 단계는 throw 또는 return 으로 dispatch — process.exit 는 dispatchPolicy 에서만 호출.

const RELOAD_PATH = '/api/admin/policy/reload'
const VERSION_PATH = '/api/admin/policy/version'

const resolveBaseUrl = () => process.env.PRESENCE_SERVER_URL || 'http://localhost:3000'

const resolveAdminToken = () => {
  const token = process.env.PRESENCE_ADMIN_TOKEN
  if (!token) {
    throw new CliPolicyError([
      'policy: admin access token 필요.',
      '  1. admin 으로 로그인 — POST /api/auth/login',
      '  2. 응답의 access token 을 PRESENCE_ADMIN_TOKEN env 에 설정',
      '  3. 다시 실행',
      '  주의: process listing 으로 token 노출 가능. 신뢰된 환경에서만 사용.',
    ].join('\n'))
  }
  return token
}

const fetchAdmin = async (path, { method = 'GET', token, baseUrl }) => {
  try {
    return await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Authorization': `Bearer ${token}` },
    })
  } catch (err) {
    // round 9 M 흡수: ECONNREFUSED 특화 제거. 모든 fetch 실패 동일 처리.
    throw new CliPolicyError([
      `policy: 서버 도달 실패 — ${err.message}`,
      '  서버 가동 상태 확인 후 재시도 — npm start',
    ].join('\n'))
  }
}

// FP-77: 401/403 분리 — 각 상황에 맞는 조치 안내. 401=token 자체 문제, 403=admin role 부재.
const handleAuthError = (response) => {
  if (response.status === 401) {
    throw new CliPolicyError([
      'policy: 인증이 필요합니다 (HTTP 401).',
      '  PRESENCE_ADMIN_TOKEN 이 올바른지 확인하거나 재로그인 후 token 을 갱신하세요.',
    ].join('\n'))
  }
  if (response.status === 403) {
    throw new CliPolicyError([
      'policy: admin 권한이 필요합니다 (HTTP 403).',
      '  현재 token 의 계정이 admin role 을 보유하고 있는지 확인하세요.',
      '  다른 계정으로 로그인하거나 admin 계정 token 을 사용하세요.',
    ].join('\n'))
  }
}

// FP-76: 운영자 친화 출력. version + 시작/완료 시각 분리 + single-flight 동작 명시.
const printReloadSuccess = (body) => {
  console.log('OK: 정책이 적용되었습니다.')
  console.log(`  버전: ${body.version}`)
  console.log(`  reload 시작: ${body.reloadStartedAt}`)
  console.log(`  적용 완료:   ${body.reloadedAt}`)
  console.log('')
  console.log('참고: 짧은 시간 내 여러 admin 이 동시에 reload 를 요청하면 한 번만 실행됩니다.')
  console.log('      "reload 시작" 시각이 이전 호출과 같으면 기존 reload 에 합류된 것입니다.')
  console.log('      새 reload 를 강제하려면 잠시 후 다시 실행하세요.')
}

// FP-75: 실패 시 복구 단계 명시 — 정책 파일 수정 → lint → reload 흐름 안내.
const formatReloadFailure = (body) => {
  const lines = ['정책 reload 실패.']
  lines.push(`원인: ${body.error}`)
  lines.push('')
  if (body.activeVersion != null) {
    lines.push(`현재 활성 정책은 그대로 유지됩니다 (버전 ${body.activeVersion}, 적용: ${body.activeReloadedAt}).`)
  }
  lines.push('디스크의 정책 파일은 변경되지 않았습니다.')
  lines.push('')
  lines.push('복구 방법:')
  lines.push('  1. 문제가 되는 .cedar 파일을 수정하거나 제거하세요')
  lines.push('  2. lint 로 검증하세요 — npm run user -- policy lint --file <파일>')
  lines.push('  3. 다시 reload 하세요   — npm run user -- policy reload')
  return lines.join('\n')
}

async function cmdPolicyReload() {
  const baseUrl = resolveBaseUrl()
  const token = resolveAdminToken()
  const response = await fetchAdmin(RELOAD_PATH, { method: 'POST', token, baseUrl })
  handleAuthError(response)
  const body = await response.json()
  if (response.ok) {
    printReloadSuccess(body)
    return
  }
  throw new CliPolicyError(formatReloadFailure(body))
}

// FP-74: GET /api/admin/policy/version CLI wrapper. 변경 적용 후 운영자가 활성 버전 재확인.
async function cmdPolicyVersion() {
  const baseUrl = resolveBaseUrl()
  const token = resolveAdminToken()
  const response = await fetchAdmin(VERSION_PATH, { method: 'GET', token, baseUrl })
  handleAuthError(response)
  const body = await response.json()
  if (!response.ok) {
    throw new CliPolicyError(`policy version 조회 실패: ${body?.error ?? `HTTP ${response.status}`}`)
  }
  console.log(`현재 활성 정책: 버전 ${body.version} (적용: ${body.reloadedAt})`)
}

export const dispatchPolicy = async (action, flags) => {
  try {
    switch (action) {
      case 'lint':    return await cmdPolicyLint({ file: requireFlag(flags, 'file') })
      case 'list':    return cmdPolicyList()
      case 'reload':  return await cmdPolicyReload()
      case 'version': return await cmdPolicyVersion()
      default:
        throw new CliPolicyError(`Unknown policy action: ${action}\nActions: lint, list, reload, version`)
    }
  } catch (err) {
    if (err instanceof CliPolicyError) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }
}
