// Cedar 인프라 부팅 — 정적 자산 read + parse 검증 + 호출자가 쓸 텍스트 반환.
//
// cedar-wasm 4.10.0: createInstance 부재. 함수는 모두 stateless top-level.
// boot 의 역할 = 정적 자산을 텍스트로 읽어 parse 검증 + evaluator 가 쓸 수 있는 텍스트로 반환.
// nodejs export (@cedar-policy/cedar-wasm/nodejs) 가 fs.readFileSync 로 wasm 동기 로딩 → import 자체가 sync 효과.

import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import fp from '@presence/core/lib/fun-fp.js'

const { Reader } = fp

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
  return policyFiles
    .map(f => readFileSync(join(policiesDir, f), 'utf-8'))
    .join('\n\n')
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
  const policiesText = readPoliciesDir(policiesDir)

  const schemaCheck = cedar.checkParseSchema(schemaText)
  if (schemaCheck.type !== 'success') failed('schema parse', schemaCheck.errors)

  const policiesCheck = cedar.checkParsePolicySet({ staticPolicies: policiesText })
  if (policiesCheck.type !== 'success') failed('policies parse', policiesCheck.errors)

  const validation = cedar.validate({ schema: schemaText, policies: { staticPolicies: policiesText } })
  if (validation.type === 'failure') failed('validation call', validation.errors)
  if (validation.type === 'success' && validation.validationErrors.length > 0) {
    failed('validation', validation.validationErrors)
  }

  return { cedar, schemaText, policiesText }
})

const bootCedar = (deps) => bootCedarR.run(deps)()

export { bootCedar, bootCedarR }
