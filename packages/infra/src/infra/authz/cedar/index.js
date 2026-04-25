// Cedar 인프라 public entry — server 가 호출하는 단일 helper.
// 정적 자산 경로 노출 없이 boot + evaluator + audit 을 일괄 조립.

import fp from '@presence/core/lib/fun-fp.js'
import { bootCedar } from './boot.js'
import { createEvaluator } from './evaluator.js'
import { createAuditWriter } from './audit.js'
import { POLICIES_DIR, SCHEMA_PATH } from './paths.js'

const { Reader } = fp

const AUDIT_LOG_FILENAME = 'authz-audit.log'

const bootCedarSubsystemR = Reader.asks(({ presenceDir }) => async () => {
  if (typeof presenceDir !== 'string' || presenceDir.length === 0) {
    throw new Error('bootCedarSubsystem: presenceDir 부재')
  }
  const { cedar, schemaText, policiesText } = await bootCedar({
    policiesDir: POLICIES_DIR,
    schemaPath:  SCHEMA_PATH,
  })
  const auditWriter = createAuditWriter({ logPath: `${presenceDir}/logs/${AUDIT_LOG_FILENAME}` })
  return createEvaluator({ cedar, schemaText, policiesText, auditWriter })
})

const bootCedarSubsystem = (deps) => bootCedarSubsystemR.run(deps)()

export { bootCedarSubsystem, bootCedarSubsystemR, AUDIT_LOG_FILENAME }
