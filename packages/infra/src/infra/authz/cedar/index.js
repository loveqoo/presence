// Cedar 인프라 public entry — server 가 호출하는 단일 helper.
// 정적 자산 경로 노출 없이 boot + evaluator + audit 을 일괄 조립.

import fp from '@presence/core/lib/fun-fp.js'
import { bootCedar } from './boot.js'
import { createEvaluator } from './evaluator.js'
import { createAuditWriter, getAuditStatus } from './audit.js'
import { POLICIES_DIR, SCHEMA_PATH } from './paths.js'

const { Reader } = fp

const AUDIT_LOG_FILENAME = 'authz-audit.log'

const auditLogPath = (presenceDir) => `${presenceDir}/logs/${AUDIT_LOG_FILENAME}`

const bootCedarSubsystemR = Reader.asks(({ presenceDir, logger }) => async () => {
  if (typeof presenceDir !== 'string' || presenceDir.length === 0) {
    throw new Error('bootCedarSubsystem: presenceDir 부재')
  }
  const { cedar, schemaText, policiesText } = await bootCedar({
    policiesDir: POLICIES_DIR,
    schemaPath:  SCHEMA_PATH,
  })
  const auditWriter = createAuditWriter({
    logPath: auditLogPath(presenceDir),
    logger,
  })
  return createEvaluator({ cedar, schemaText, policiesText, auditWriter })
})

const bootCedarSubsystem = (deps) => bootCedarSubsystemR.run(deps)()

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

export {
  bootCedarSubsystem, bootCedarSubsystemR,
  createSubsystemAuditWriter, createSubsystemAuditWriterR,
  getSubsystemAuditStatus, getSubsystemAuditStatusR,
  AUDIT_LOG_FILENAME,
}
