import { SESSION_TYPE } from '@presence/infra/infra/constants.js'
import { DelegationMode } from '@presence/infra/infra/agents/delegation.js'
import { createSchedulerActor } from '@presence/infra/infra/actors/scheduler-actor.js'
import { canAccessAgent, INTENT } from '@presence/infra/infra/authz/agent-access.js'
import { resolvePrimaryAgent } from '@presence/core/core/agent-id.js'
import { fireAndForget } from '@presence/core/lib/task.js'

// =============================================================================
// 스케줄러 팩토리 + 에이전트 세션 등록
// =============================================================================

const createServerScheduler = (userContext, opts = {}) => {
  const defaultUserId = opts.username || 'default'
  let scheduler
  scheduler = createSchedulerActor({
    store: userContext.jobStore,
    onDispatch: (jobEvent) => {
      const sessionId = `scheduled-${jobEvent.runId}`
      // docs §4.3 — job 생성 시 owner 가 확정되어 있으므로 event 에서 직접 사용.
      // legacy row (owner null) 는 scheduler-actor 가 null 로 전파 → fallback 으로 막음.
      // KG-16: fallback agentId 도 primaryAgentId 경유 (admin/manager 등 반영).
      const { agentId: primaryAgentId } = resolvePrimaryAgent(userContext.config, defaultUserId)
      const agentId = jobEvent.ownerAgentId || primaryAgentId
      const userId = jobEvent.ownerUserId || defaultUserId

      // docs §9.4 진입점 #4 — scheduled-run intent 로 canAccessAgent.
      // jwtSub=owner (agent 소유자 본인이 자기 agent 를 실행 → ownership 트리비얼),
      // 실효 게이트는 archived 체크 (§5.4 — archived agent 는 새 scheduled run 차단).
      const access = canAccessAgent({
        jwtSub: userId, agentId, intent: INTENT.SCHEDULED_RUN, registry: userContext.agentRegistry,
      })
      if (!access.allow) {
        userContext.logger?.warn?.(`Scheduler: dispatch denied for ${agentId} (${access.reason}) — job ${jobEvent.jobId} skipped`)
        fireAndForget(scheduler.jobFail(jobEvent.runId, jobEvent.jobId, jobEvent.attempt ?? 1, `access-denied: ${access.reason}`))
        return
      }

      // workingDir 은 Session 이 userId 에서 자동 결정 (`~/.presence/users/{userId}/`).
      const entry = userContext.sessions.create({
        type: SESSION_TYPE.SCHEDULED,
        id: sessionId,
        userId,
        agentId,
        onScheduledJobDone: (event, outcome) => {
          const task = outcome.success
            ? scheduler.jobDone(event.runId, event.jobId, outcome.result)
            : scheduler.jobFail(event.runId, event.jobId, event.attempt ?? 1, outcome.error)
          fireAndForget(task)
          userContext.sessions.destroy(sessionId).catch(Function.prototype)
        },
      })
      fireAndForget(entry.session.eventActor.enqueue(jobEvent))
    },
    logger: userContext.logger,
    pollIntervalMs: userContext.config.scheduler.pollIntervalMs,
  })
  return scheduler
}

// 에이전트 세션 등록: config.agents 기반.
// workingDir 은 userId 기반 자동 결정 — 별도 명시 불필요.
const registerAgentSessions = (userContext, username) => {
  const userId = username || 'default'
  for (const agentDef of (userContext.config.agents || [])) {
    // agentId: qualifying 현재 agent name. identity §3 qualified form.
    const agentId = `${userId}/${agentDef.name}`
    const agentEntry = userContext.sessions.create({
      id: `agent-${agentDef.name}`, type: SESSION_TYPE.AGENT, userId, agentId,
    })
    userContext.agentRegistry.register({
      agentId,
      description: agentDef.description,
      capabilities: agentDef.capabilities || [],
      type: DelegationMode.LOCAL,
      run: (task) => agentEntry.session.handleInput(task),
      archived: agentDef.archived === true,
    })
    fireAndForget(agentEntry.session.delegateActor.start())
  }
}

export { createServerScheduler, registerAgentSessions }
