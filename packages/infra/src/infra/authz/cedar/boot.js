// Cedar 인프라 부팅 — 정적 자산 read + parse 검증 + 호출자가 쓸 텍스트 반환.
//
// cedar-wasm 4.10.0: createInstance 부재. 함수는 모두 stateless top-level.
// boot 의 역할 = 정적 자산을 텍스트로 읽어 parse 검증 + evaluator 가 쓸 수 있는 텍스트로 반환.
// nodejs export (@cedar-policy/cedar-wasm/nodejs) 가 fs.readFileSync 로 wasm 동기 로딩 → import 자체가 sync 효과.

import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import fp from '@presence/core/lib/fun-fp.js'

const { Reader } = fp

// governance-cedar v2.11 §X5 (KG-27) — 정책 파일을 { basename: rawText } 맵으로 반환.
// 50-* 운영자 슬롯 개방 — boot 시 차단하지 않고 정상 부팅.
// 다중 statement 분리는 bootCedarR 가 cedar.policySetTextToParts 로 처리 (split 시점에 cedar 필요).
const readPoliciesDir = (policiesDir) => {
  if (!existsSync(policiesDir)) {
    throw new Error(`Cedar policies dir 부재: ${policiesDir}`)
  }
  const policyFiles = readdirSync(policiesDir)
    .filter(f => f.endsWith('.cedar'))
    .sort()
  if (policyFiles.length === 0) {
    throw new Error(`Cedar policies dir 비어있음: ${policiesDir}`)
  }
  const map = {}
  for (const f of policyFiles) {
    const id = f.replace(/\.cedar$/, '')
    map[id] = readFileSync(join(policiesDir, f), 'utf-8')
  }
  return map
}

// cedar.policySetTextToParts(rawText) → { type, policies: [stmtText, ...] }
// 단일 statement 파일: key = basename. 다중: key = `${basename}-${idx}` (prefix 분류 호환).
const splitPoliciesByStatement = (cedar, rawByFile) => {
  const map = {}
  for (const [basename, rawText] of Object.entries(rawByFile)) {
    const parts = cedar.policySetTextToParts(rawText)
    if (parts.type !== 'success') failed(`policy split (${basename})`, parts.errors)
    const stmts = parts.policies
    if (stmts.length === 0) {
      throw new Error(`Cedar policy split: ${basename} 가 statement 0 개 — 빈 정책 파일`)
    }
    if (stmts.length === 1) {
      map[basename] = stmts[0]
    } else {
      stmts.forEach((stmt, idx) => { map[`${basename}-${idx}`] = stmt })
    }
  }
  return map
}

const readSchemaFile = (schemaPath) => {
  if (!existsSync(schemaPath)) {
    throw new Error(`Cedar schema 부재: ${schemaPath}`)
  }
  return readFileSync(schemaPath, 'utf-8')
}

const failed = (kind, errors) => {
  throw new Error(`Cedar ${kind} failed: ${JSON.stringify(errors)}`)
}

const bootCedarR = Reader.asks(({ policiesDir, schemaPath }) => async () => {
  const cedar = await import('@cedar-policy/cedar-wasm/nodejs')

  const schemaText = readSchemaFile(schemaPath)
  const rawByFile = readPoliciesDir(policiesDir)
  const policiesMap = splitPoliciesByStatement(cedar, rawByFile)

  const schemaCheck = cedar.checkParseSchema(schemaText)
  if (schemaCheck.type !== 'success') failed('schema parse', schemaCheck.errors)

  const policiesCheck = cedar.checkParsePolicySet({ staticPolicies: policiesMap })
  if (policiesCheck.type !== 'success') failed('policies parse', policiesCheck.errors)

  const validation = cedar.validate({ schema: schemaText, policies: { staticPolicies: policiesMap } })
  if (validation.type === 'failure') failed('validation call', validation.errors)
  if (validation.type === 'success' && validation.validationErrors.length > 0) {
    failed('validation', validation.validationErrors)
  }

  return { cedar, schemaText, policiesMap }
})

const bootCedar = (deps) => bootCedarR.run(deps)()

export { bootCedar, bootCedarR }
