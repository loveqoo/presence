// Agent governance CLI 핸들러. cli.js main switch 에서 dispatchAgent 호출.
// add (submit + Cedar evaluate) / review (pending list) / approve / deny.

import { readFileSync } from 'node:fs'
import { Config } from '../config.js'
import {
  STATUS as GV_STATUS,
  submitUserAgent,
  approveUserAgent,
  denyUserAgent,
  listPending,
  loadAgentPolicies,
  readPendingRequest,
} from '../authz/agent-governance.js'
import { bootCedarSubsystem, createSubsystemAuditWriter } from '../authz/cedar/index.js'
import { requireFlag } from './cli-utils.js'

const loadPersonaFromFile = (filePath) => {
  if (!filePath) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch (err) {
    console.error(`Failed to read persona file: ${err.message}`)
    process.exit(1)
  }
}

const defaultPersona = () => ({
  name: 'Presence',
  systemPrompt: null,
  rules: [],
  tools: [],
})

async function cmdAgentAdd(params) {
  const presenceDir = Config.presenceDir()
  const persona = params.personaPath ? loadPersonaFromFile(params.personaPath) : defaultPersona()
  // governance-cedar v2.1: CLI 도 Cedar 부팅 필수 (PresenceServer 와 같은 invariant).
  const evaluator = await bootCedarSubsystem({ presenceDir })
  const result = submitUserAgent({
    requester: params.requester, agentName: params.name, persona,
    basePath: presenceDir, presenceDir, evaluator,
  })
  switch (result.status) {
    case GV_STATUS.APPROVED:
      console.log(`Agent '${params.requester}/${params.name}' auto-approved. ${result.detail || ''}`)
      return
    case GV_STATUS.PENDING:
      console.log(`Agent '${params.requester}/${params.name}' pending admin review.`)
      console.log(`  reqId: ${result.reqId}`)
      console.log(`  Admin can approve:  npm run user -- agent approve --id ${result.reqId}`)
      return
    case GV_STATUS.ALREADY_EXISTS:
      console.error(`Agent '${params.requester}/${params.name}' already exists.`)
      process.exit(1)
      return
    case GV_STATUS.DENIED:
      console.error(`Agent '${params.requester}/${params.name}' denied by Cedar policy. ${result.detail || ''}`)
      process.exit(1)
      return
  }
}

function cmdAgentReview() {
  const presenceDir = Config.presenceDir()
  const pending = listPending(presenceDir)
  if (pending.length === 0) {
    console.log('No pending agent requests.')
    return
  }
  const policies = loadAgentPolicies(presenceDir)
  console.log(`Pending requests (${pending.length}):`)
  console.log(`  policy: maxAgentsPerUser=${policies.maxAgentsPerUser}, autoApproveUnderQuota=${policies.autoApproveUnderQuota}`)
  for (const req of pending) {
    console.log('')
    console.log(`  [${req.id}]`)
    console.log(`    requester: ${req.requester}`)
    console.log(`    agentName: ${req.agentName}`)
    console.log(`    submitted: ${req.submittedAt}`)
    console.log(`    reason:    ${req.reason} (current ${req.currentCount}/${req.maxAgentsPerUser})`)
  }
  console.log('')
  console.log('Approve: npm run user -- agent approve --id <reqId>')
  console.log('Deny:    npm run user -- agent deny --id <reqId> --reason "<text>"')
}

function cmdAgentApprove(params) {
  const presenceDir = Config.presenceDir()
  // governance-cedar v2.1 §1.4: admin override 는 Cedar 호출 없음, audit 만 기록.
  // 요청 정보는 approve 전 캡처 (파일 이동 후엔 pending 에서 사라짐).
  const req = readPendingRequest(presenceDir, params.id)
  const result = approveUserAgent(params.id, { presenceDir, basePath: presenceDir })
  if (result.status === GV_STATUS.APPROVED || result.status === GV_STATUS.ALREADY_APPLIED) {
    createSubsystemAuditWriter({ presenceDir }).append({
      ts: new Date().toISOString(), caller: 'admin', action: 'manual_approve', resource: req?.requester ?? 'unknown',
      decision: 'allow', matchedPolicies: [], errors: [], reqId: params.id, agentName: req?.agentName ?? null,
      idempotent: result.status === GV_STATUS.ALREADY_APPLIED,
    })
  }
  switch (result.status) {
    case GV_STATUS.APPROVED:
      console.log(`Request ${params.id} approved.`)
      return
    case GV_STATUS.ALREADY_APPLIED:
      console.log(`Request ${params.id} already applied (idempotent replay, file cleaned).`)
      return
    case GV_STATUS.NOT_FOUND:
      console.error(`Request ${params.id} not found in pending.`)
      process.exit(1)
      return
  }
}

function cmdAgentDeny(params) {
  const presenceDir = Config.presenceDir()
  const reason = params.reason || 'denied by admin'
  const result = denyUserAgent(params.id, reason, { presenceDir })
  switch (result.status) {
    case GV_STATUS.REJECTED:
      console.log(`Request ${params.id} denied. Reason: ${reason}`)
      return
    case GV_STATUS.NOT_FOUND:
      console.error(`Request ${params.id} not found in pending.`)
      process.exit(1)
      return
  }
}

export const dispatchAgent = (action, flags) => {
  switch (action) {
    case 'add':
      return cmdAgentAdd({
        requester: requireFlag(flags, 'requester'),
        name: requireFlag(flags, 'name'),
        personaPath: flags.persona,
      })
    case 'review':
      return cmdAgentReview()
    case 'approve':
      return cmdAgentApprove({ id: requireFlag(flags, 'id') })
    case 'deny':
      return cmdAgentDeny({ id: requireFlag(flags, 'id'), reason: flags.reason })
    default:
      console.error(`Unknown agent action: ${action}`)
      console.error('Actions: add, review, approve, deny')
      process.exit(1)
  }
}
