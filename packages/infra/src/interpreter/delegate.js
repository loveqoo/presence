import fp from '@presence/core/lib/fun-fp.js'
import { DelegateResult } from '../infra/agent-registry.js'
import { sendA2ATask } from '../infra/a2a-client.js'
import { Interpreter } from '@presence/core/interpreter/compose.js'

const { Task, Maybe } = fp

// --- DelegateInterpreter ---
// Delegate — 로컬/리모트 에이전트 위임.

const createDelegateInterpreter = ({ ST, agentRegistry, delegateUi, fetchFn }) =>
  new Interpreter(['Delegate'], (f) => {
    const maybeEntry = agentRegistry ? agentRegistry.get(f.target) : Maybe.Nothing()

    const runLocal = (entry) =>
      ST.lift(Task.fromPromise(() =>
        entry.run(f.task)
          .then(output => DelegateResult.completed(f.target, output, 'local'))
          .catch(e => DelegateResult.failed(f.target, e.message || String(e), 'local'))
      )()).map(r => f.next(r))

    const runRemote = (entry) =>
      ST.lift(Task.fromPromise(async () => {
        const result = await sendA2ATask(f.target, entry.endpoint, f.task, { fetchFn })
        if (result.status === 'submitted') {
          delegateUi.addPending({
            target: f.target, taskId: result.taskId,
            endpoint: entry.endpoint, submittedAt: Date.now(),
          })
        }
        return result
      })()).map(r => f.next(r))

    return Maybe.fold(
      () => ST.of(f.next(DelegateResult.failed(f.target, `Unknown agent: ${f.target}`))),
      entry =>
        entry.type === 'local' && entry.run ? runLocal(entry)
        : entry.type === 'remote' && entry.endpoint ? runRemote(entry)
        : ST.of(f.next(DelegateResult.failed(f.target, `Agent '${f.target}' has no run function or endpoint`))),
      maybeEntry,
    )
  })

export { createDelegateInterpreter }
