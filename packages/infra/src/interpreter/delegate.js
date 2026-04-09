import fp from '@presence/core/lib/fun-fp.js'
import { Delegation, DelegationMode } from '../infra/agents/delegation.js'
import { A2AClient } from '../infra/agents/a2a-client.js'
import { Interpreter } from '@presence/core/interpreter/compose.js'

const { Task, Maybe, Reader } = fp

// --- DelegateInterpreter ---
// Delegate — 로컬/리모트 에이전트 위임.

const delegateInterpreterR = Reader.asks(({ ST, agentRegistry, delegateUi, fetchFn }) => {
  const a2a = new A2AClient({ fetchFn })
  return new Interpreter(['Delegate'], (f) => {
    const maybeEntry = agentRegistry ? agentRegistry.get(f.target) : Maybe.Nothing()

    const runLocal = (entry) =>
      ST.lift(Task.fromPromise(() =>
        entry.run(f.task)
          .then(output => Delegation.completed(f.target, output, DelegationMode.LOCAL))
          .catch(e => Delegation.failed(f.target, e.message || String(e), DelegationMode.LOCAL))
      )()).map(r => f.next(r))

    const runRemote = (entry) =>
      ST.lift(Task.fromPromise(async () => {
        const result = await a2a.sendTask(f.target, entry.endpoint, f.task)
        if (result.isPending()) {
          delegateUi.addPending({
            target: f.target, taskId: result.taskId,
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
