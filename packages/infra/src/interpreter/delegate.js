import fp from '@presence/core/lib/fun-fp.js'
import { Delegation, DelegationMode } from '../infra/agents/delegation.js'
import { A2AClient } from '../infra/agents/a2a-client.js'
import { resolveDelegateTarget } from '../infra/agents/resolve-delegate-target.js'
import { canAccessAgent, INTENT } from '../infra/authz/agent-access.js'
import { Interpreter } from '@presence/core/interpreter/compose.js'

const { Task, Maybe, Reader, Either } = fp

// --- DelegateInterpreter ---
// Delegate — 로컬/리모트 에이전트 위임.
// f.target → resolveDelegateTarget(currentUserId) → canAccessAgent(DELEGATE) → registry.get
// docs/design/agent-identity-model.md §9.4 진입점 #5.

const delegateInterpreterR = Reader.asks(({ ST, agentRegistry, delegateUi, fetchFn, currentUserId, a2aSigner, evaluator }) => {
  const a2a = new A2AClient({ fetchFn })
  return new Interpreter(['Delegate'], (f) => {
    const resolved = resolveDelegateTarget(f.target, { currentUserId })
    if (Either.isLeft(resolved)) {
      const reason = Either.fold(e => e, () => '', resolved)
      return ST.of(f.next(Delegation.failed(f.target, `Unknown agent: ${f.target} (${reason})`)))
    }
    const agentId = Either.fold(() => '', v => v, resolved)

    // §9.4 진입점 #5 — delegate intent 로 접근 판정. currentUserId 가 없으면 skip (legacy 호환).
    if (currentUserId) {
      const access = canAccessAgent({
        jwtSub: currentUserId, agentId, intent: INTENT.DELEGATE, registry: agentRegistry,
        evaluator,
      })
      if (!access.allow) {
        return ST.of(f.next(Delegation.failed(f.target, `Access denied: ${access.reason} (agent=${agentId})`)))
      }
    }

    const maybeEntry = agentRegistry ? agentRegistry.get(agentId) : Maybe.Nothing()

    // Delegation.target 은 user 원본 (f.target) 유지 — 감사/로그에서 사용자 의도 보존.
    // registry lookup 은 qualified agentId 로 수행.
    const runLocal = (entry) =>
      ST.lift(Task.fromPromise(() =>
        entry.run(f.task)
          .then(output => Delegation.completed(f.target, output, DelegationMode.LOCAL))
          .catch(e => Delegation.failed(f.target, e.message || String(e), DelegationMode.LOCAL))
      )()).map(r => f.next(r))

    // KG-17: a2aSigner 가 있으면 currentUserId 로 짧은 만료 token sign 후 첨부.
    // self-A2A scope — 같은 머신의 receiver 가 같은 secret 으로 verifyA2aToken.
    const runRemote = (entry) =>
      ST.lift(Task.fromPromise(async () => {
        const callerToken = (a2aSigner && currentUserId) ? a2aSigner(currentUserId) : null
        const result = await a2a.sendTask(f.target, entry.endpoint, f.task, { callerToken })
        if (result.isPending()) {
          delegateUi.addPending({
            target: f.target,     // user 원본 (UI 표시용)
            agentId,              // qualified (registry lookup 용)
            taskId: result.taskId,
            endpoint: entry.endpoint, submittedAt: Date.now(),
          })
        }
        return result
      })()).map(r => f.next(r))

    return Maybe.fold(
      () => ST.of(f.next(Delegation.failed(f.target, `Unknown agent: ${f.target}`))),
      entry =>
        entry.type === DelegationMode.LOCAL && entry.run ? runLocal(entry)
        : entry.type === DelegationMode.REMOTE && entry.endpoint ? runRemote(entry)
        : ST.of(f.next(Delegation.failed(f.target, `Agent '${f.target}' has no run function or endpoint`))),
      maybeEntry,
    )
  })
})

/**
 * `delegateInterpreterR` — Reader that creates Delegate op handler.
 * Routes to a local `run()` function or a remote A2A endpoint based on the registry entry type.
 * Adds pending remote tasks to `delegateUi` for UI tracking.
 */
export { delegateInterpreterR }
