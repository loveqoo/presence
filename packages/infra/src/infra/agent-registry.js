import fp from '@presence/core/lib/fun-fp.js'

const { Maybe } = fp

// --- Delegate 결과 shape (local/remote 공통 계약) ---

const DelegateResult = {
  completed: (target, output, mode = 'local') => ({
    mode, target, status: 'completed', taskId: null, output, artifact: null,
  }),
  submitted: (target, taskId, mode = 'remote') => ({
    mode, target, status: 'submitted', taskId, output: null, artifact: null,
  }),
  failed: (target, error, mode = null) => ({
    mode, target, status: 'failed', taskId: null, output: null, artifact: null, error,
  }),
}

// --- 에이전트 레지스트리 ---

const createAgentRegistry = () => {
  const agents = new Map()

  const register = ({ name, description = '', capabilities = [], type = 'local', run, endpoint, agentCard }) => {
    agents.set(name, { name, description, capabilities, type, run, endpoint, agentCard })
  }

  // Maybe<Entry>
  const get = (name) => Maybe.fromNullable(agents.get(name))

  const list = () => [...agents.values()]

  const has = (name) => agents.has(name)

  return { register, get, list, has }
}

export { createAgentRegistry, DelegateResult }
