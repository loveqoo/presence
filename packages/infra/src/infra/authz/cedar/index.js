// Cedar 인프라 public entry — server 가 호출하는 단일 helper.
// 정적 자산 경로 노출 없이 boot + evaluator + audit 을 일괄 조립.

import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import fp from '@presence/core/lib/fun-fp.js'
import { bootCedar } from './boot.js'
import { createEvaluator } from './evaluator.js'
import { createAuditWriter, getAuditStatus } from './audit.js'
import { createEvaluatorRef } from './evaluator-ref.js'
import { POLICIES_DIR, SCHEMA_PATH } from './paths.js'

const { Reader } = fp

const AUDIT_LOG_FILENAME = 'authz-audit.log'

const auditLogPath = (presenceDir) => `${presenceDir}/logs/${AUDIT_LOG_FILENAME}`

// KG-28 P5 — wrapper + auditWriter 둘 다 반환 (destructuring contract).
// wrapper.snapshot 을 audit writer 의 getPolicyVersion closure 로 주입 → reload 후 audit entry 자동 첨부.
// reload 는 wrapperHandle.ref.replace(newEvaluator, newVersion) 으로 evaluator 함수만 교체.
const bootCedarSubsystemR = Reader.asks(({ presenceDir, logger }) => async () => {
  if (typeof presenceDir !== 'string' || presenceDir.length === 0) {
    throw new Error('bootCedarSubsystem: presenceDir 부재')
  }
  const { cedar, schemaText, policiesMap } = await bootCedar({
    policiesDir: POLICIES_DIR,
    schemaPath:  SCHEMA_PATH,
  })
  // wrapper handle — getPolicyVersion closure 에서 lazy 참조.
  const wrapperHandle = { ref: null }
  const auditWriter = createAuditWriter({
    logPath: auditLogPath(presenceDir),
    logger,
    getPolicyVersion: () => wrapperHandle.ref?.snapshot().version ?? null,
  })
  const innerEvaluator = createEvaluator({ cedar, schemaText, policiesMap, auditWriter })
  wrapperHandle.ref = createEvaluatorRef(innerEvaluator, { version: 1 })
  return { evaluator: wrapperHandle.ref, auditWriter }
})

const bootCedarSubsystem = (deps) => bootCedarSubsystemR.run(deps)()

// KG-28 P5 — reload 전용. evaluator 함수만 부팅 (wrapper 미생성, audit writer 재사용).
// 부팅 실패 시 throw → 호출자 (UserContextManager.#doReload) 가 wrapper.replace 미호출 = fail-safe rollback.
// auditWriter 재사용으로 wrapper.snapshot closure 가 단일 wrapper 만 가리키게 유지.
const rebootCedarSubsystem = async ({ auditWriter }) => {
  if (!auditWriter || typeof auditWriter.append !== 'function') {
    throw new Error('rebootCedarSubsystem: auditWriter (with append) 필수')
  }
  const { cedar, schemaText, policiesMap } = await bootCedar({
    policiesDir: POLICIES_DIR,
    schemaPath:  SCHEMA_PATH,
  })
  return createEvaluator({ cedar, schemaText, policiesMap, auditWriter })
}

// audit 만 필요한 경로 (예: agent approve 의 manual_approve 기록 — Cedar 호출 없이 감사 추적만).
// boot 비용 (wasm 로딩 + parse 검증) 회피.
const createSubsystemAuditWriterR = Reader.asks(({ presenceDir, logger }) => {
  if (typeof presenceDir !== 'string' || presenceDir.length === 0) {
    throw new Error('createSubsystemAuditWriter: presenceDir 부재')
  }
  return createAuditWriter({
    logPath: auditLogPath(presenceDir),
    logger,
  })
})

const createSubsystemAuditWriter = (deps) => createSubsystemAuditWriterR.run(deps)

// FP-70 — admin CLI 가 호출. presenceDir 만 받아 audit log 상태 조회.
const getSubsystemAuditStatusR = Reader.asks(({ presenceDir }) => {
  if (typeof presenceDir !== 'string' || presenceDir.length === 0) {
    throw new Error('getSubsystemAuditStatus: presenceDir 부재')
  }
  return getAuditStatus({ logPath: auditLogPath(presenceDir) })
})

const getSubsystemAuditStatus = (deps) => getSubsystemAuditStatusR.run(deps)

// KG-27 P4 — admin CLI 가 호출. 정책 파일 lint (parse + schema 적합성).
// 다중 statement 파일도 처리 — policySetTextToParts 로 split 후 각 statement 를
// { p0: stmt, p1: stmt, ... } 맵으로 검증.
// schemaText 가 없으면 schema validate skip — parse 만 검증.
const lintPolicyText = async ({ text, schemaText }) => {
  if (typeof text !== 'string') throw new Error('lintPolicyText: text 부재')
  const cedar = await import('@cedar-policy/cedar-wasm/nodejs')

  const split = cedar.policySetTextToParts(text)
  if (split.type !== 'success') {
    return { ok: false, parseErrors: split.errors ?? [], schemaErrors: [] }
  }
  const stmts = split.policies
  if (stmts.length === 0) {
    return { ok: false, parseErrors: [{ message: 'no policy statement found' }], schemaErrors: [] }
  }
  const policies = {}
  stmts.forEach((stmt, i) => { policies[`p${i}`] = stmt })

  const parseResult = cedar.checkParsePolicySet({ staticPolicies: policies })
  if (parseResult.type !== 'success') {
    return { ok: false, parseErrors: parseResult.errors ?? [], schemaErrors: [] }
  }
  if (typeof schemaText !== 'string') {
    return { ok: true, parseErrors: [], schemaErrors: [] }
  }
  const validation = cedar.validate({ schema: schemaText, policies: { staticPolicies: policies } })
  if (validation.type === 'failure') {
    return { ok: false, parseErrors: [], schemaErrors: validation.errors ?? [] }
  }
  if (validation.type === 'success' && validation.validationErrors.length > 0) {
    return { ok: false, parseErrors: [], schemaErrors: validation.validationErrors }
  }
  return { ok: true, parseErrors: [], schemaErrors: [] }
}

// KG-27 P4 — admin CLI policy list. POLICIES_DIR 스캔 + prefix 카테고리 매핑.
const POLICY_CATEGORIES = Object.freeze([
  { prefix: '00-', category: 'base' },
  { prefix: '10-', category: 'quota' },
  { prefix: '11-', category: 'admin-limit' },
  { prefix: '20-', category: 'archived' },
  { prefix: '30-', category: 'protect' },
  { prefix: '31-', category: 'protect' },
  { prefix: '50-', category: 'operator' },
])

const categorizePolicy = (filename) => {
  for (const { prefix, category } of POLICY_CATEGORIES) {
    if (filename.startsWith(prefix)) return category
  }
  return 'unknown'
}

const listPolicyFiles = (policiesDir = POLICIES_DIR) => {
  if (!existsSync(policiesDir)) return []
  return readdirSync(policiesDir)
    .filter(f => f.endsWith('.cedar'))
    .sort()
    .map(filename => ({
      filename,
      category: categorizePolicy(filename),
      size: statSync(join(policiesDir, filename)).size,
    }))
}

const readSchemaText = (schemaPath = SCHEMA_PATH) => {
  if (!existsSync(schemaPath)) return null
  return readFileSync(schemaPath, 'utf-8')
}

export {
  bootCedarSubsystem, bootCedarSubsystemR,
  rebootCedarSubsystem,
  createSubsystemAuditWriter, createSubsystemAuditWriterR,
  getSubsystemAuditStatus, getSubsystemAuditStatusR,
  lintPolicyText, listPolicyFiles, readSchemaText,
  AUDIT_LOG_FILENAME,
}
