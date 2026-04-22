import { SESSION_TYPE } from '@presence/infra/infra/constants.js'
import { DelegationMode } from '@presence/infra/infra/agents/delegation.js'
import { createSchedulerActor } from '@presence/infra/infra/actors/scheduler-actor.js'
import { canAccessAgent, INTENT } from '@presence/infra/infra/authz/agent-access.js'
import { fireAndForget } from '@presence/core/lib/task.js'

// =============================================================================
// 스케줄러 팩토리 + 에이전트 세션 등록
// =============================================================================

const createServerScheduler = (userContext, opts = {}) => {
  const defaultUserId = opts.username || 'default'
  let scheduler
  // SCHEDULED session 의 workingDir — WS join 이 없어 backfill 대상 아님.
  // user config 의 allowedDirs[0] 을 명시 전달해 Session 에서 pendingBackfill=false 로 확정.
  //
  // 의도적 단순화: job 별 workingDir 옵션은 제공하지 않는다. 이유:
  //  - 추적 난이도: job 마다 다른 디렉토리면 사용자가 "이 job 이 어디서 실행되는지" 파악 어려움
  //  - allowedDirs 내부의 민감 경로 지정 위험 (경계 검증은 외곽만 막음)
  //  - capability 모델 (docs/design/platform.md §4-3) 도입 전 파편 정책 쌓지 않음
  // 장래에 capability 가 통합되면 그 축에서 job 의 실행 환경을 표현한다.
  const defaultWd = userContext.config.tools?.allowedDirs?.[0]
  scheduler = createSchedulerActor({
    store: userContext.jobStore,
    onDispatch: (jobEvent) => {
      const sessionId = `scheduled-${jobEvent.runId}`
      // docs §4.3 — job 생성 시 owner 가 확정되어 있으므로 event 에서 직접 사용.
      // legacy row (owner null) 는 scheduler-actor 가 null 로 전파 → fallback 으로 막음.
      const agentId = jobEvent.ownerAgentId || `${defaultUserId}/default`
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

      const entry = userContext.sessions.create({
        type: SESSION_TYPE.SCHEDULED,
        id: sessionId,
        userId,
        agentId,
        workingDir: jobEvent.workingDir || defaultWd,
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

// 에이전트 세션 등록: config.agents 기반
// Agent session 도 SCHEDULED 와 마찬가지로 WS join 없음 → workingDir 명시 전달로
// pendingBackfill=false 확정. agentDef.workingDir 있으면 사용, 없으면 allowedDirs[0].
const registerAgentSessions = (userContext, username) => {
  const userId = username || 'default'
  const defaultWd = userContext.config.tools?.allowedDirs?.[0]
  for (const agentDef of (userContext.config.agents || [])) {
    // agentId: qualifying 현재 agent name. identity §3 qualified form.
    const agentId = `${userId}/${agentDef.name}`
    const agentEntry = userContext.sessions.create({
      id: `agent-${agentDef.name}`, type: SESSION_TYPE.AGENT, userId,
      agentId,
      workingDir: agentDef.workingDir || defaultWd,
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
