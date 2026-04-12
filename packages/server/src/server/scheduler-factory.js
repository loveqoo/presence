import { SESSION_TYPE } from '@presence/infra/infra/constants.js'
import { DelegationMode } from '@presence/infra/infra/agents/delegation.js'
import { createSchedulerActor } from '@presence/infra/infra/actors/scheduler-actor.js'
import { fireAndForget } from '@presence/core/lib/task.js'

// =============================================================================
// 스케줄러 팩토리 + 에이전트 세션 등록
// =============================================================================

const createServerScheduler = (userContext) => {
  let scheduler
  scheduler = createSchedulerActor({
    store: userContext.jobStore,
    onDispatch: (jobEvent) => {
      const sessionId = `scheduled-${jobEvent.runId}`
      const entry = userContext.sessions.create({
        type: SESSION_TYPE.SCHEDULED,
        id: sessionId,
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
const registerAgentSessions = (userContext, username) => {
  const userId = username || 'default'
  for (const agentDef of (userContext.config.agents || [])) {
    const agentEntry = userContext.sessions.create({
      id: `agent-${agentDef.name}`, type: SESSION_TYPE.AGENT, userId,
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
