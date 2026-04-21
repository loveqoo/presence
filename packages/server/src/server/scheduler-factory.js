import { SESSION_TYPE } from '@presence/infra/infra/constants.js'
import { DelegationMode } from '@presence/infra/infra/agents/delegation.js'
import { createSchedulerActor } from '@presence/infra/infra/actors/scheduler-actor.js'
import { fireAndForget } from '@presence/core/lib/task.js'

// =============================================================================
// 스케줄러 팩토리 + 에이전트 세션 등록
// =============================================================================

const createServerScheduler = (userContext) => {
  let scheduler
  // SCHEDULED session 의 workingDir — WS join 이 없어 backfill 대상 아님.
  // jobEvent.workingDir 있으면 사용, 없으면 user config 의 allowedDirs[0] 명시 전달
  // (명시 전달해야 Session 생성 시 pendingBackfill=false 로 확정됨).
  const defaultWd = userContext.config.tools?.allowedDirs?.[0]
  scheduler = createSchedulerActor({
    store: userContext.jobStore,
    onDispatch: (jobEvent) => {
      const sessionId = `scheduled-${jobEvent.runId}`
      const entry = userContext.sessions.create({
        type: SESSION_TYPE.SCHEDULED,
        id: sessionId,
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
    const agentEntry = userContext.sessions.create({
      id: `agent-${agentDef.name}`, type: SESSION_TYPE.AGENT, userId,
      workingDir: agentDef.workingDir || defaultWd,
    })
    userContext.agentRegistry.register({
      name: agentDef.name,
      description: agentDef.description,
      capabilities: agentDef.capabilities || [],
      type: DelegationMode.LOCAL,
      run: (task) => agentEntry.session.handleInput(task),
    })
    fireAndForget(agentEntry.session.delegateActor.start())
  }
}

export { createServerScheduler, registerAgentSessions }
