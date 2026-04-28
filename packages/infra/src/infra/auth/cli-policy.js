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

function cmdPolicyReload() {
  console.error('policy reload: 미지원 — 서버 재시작 필요. (P5 후속 phase 에서 hot reload 검토)')
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
