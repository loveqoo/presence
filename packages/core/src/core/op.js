import fp from '../lib/fun-fp.js'

const { Free, Either, Task, StateT, identity, once, pipe } = fp

/**
 * Well-known Symbol used to tag Op objects as functors for the Free interpreter.
 * @type {symbol}
 */
const FUNCTOR = Symbol.for('fun-fp-js/Functor')

/**
 * @typedef {Object} AgentOp
 * @property {string} tag - Discriminant tag identifying the Op variant.
 * @property {function(*): AgentOp} map - Maps over the continuation; never over data fields.
 * @property {function(*): *} next - Continuation: receives the effect result and returns the next Free step.
 */

/**
 * Factory that creates a tagged Op constructor.
 * The returned constructor merges `data` into the Op object and sets the functor symbol.
 * `map` applies `f` to the continuation (`next`), not to the data payload.
 * @param {string} tag - Op variant name (e.g. `'AskLLM'`).
 * @returns {function(data: Object, next?: function): AgentOp}
 */
const makeOp = tag => (data, next = identity) => ({
  tag, ...data, next,
  [FUNCTOR]: true,
  map: f => makeOp(tag)(data, x => f(next(x)))
})

// --- Op constructors (10) ---
/**
 * Op constructor: send messages to the LLM and receive a response.
 * @type {function(data: {messages: Array, tools?: Array, responseFormat?: *, context?: *}, next?: function): AgentOp}
 */
const AskLLM       = makeOp('AskLLM')

/**
 * Op constructor: execute a named tool with given arguments.
 * @type {function(data: {name: string, args: *}, next?: function): AgentOp}
 */
const ExecuteTool   = makeOp('ExecuteTool')

/**
 * Op constructor: emit a response message to the user/caller.
 * @type {function(data: {message: string}, next?: function): AgentOp}
 */
const Respond       = makeOp('Respond')

/**
 * Op constructor: request human approval before continuing.
 * @type {function(data: {description: string}, next?: function): AgentOp}
 */
const Approve       = makeOp('Approve')

/**
 * Op constructor: delegate a task to another agent instance.
 * @type {function(data: {target: string, task: *}, next?: function): AgentOp}
 */
const Delegate      = makeOp('Delegate')

/**
 * Op constructor: observe an external event or data source.
 * @type {function(data: {source: string, data: *}, next?: function): AgentOp}
 */
const Observe       = makeOp('Observe')

/**
 * Op constructor: update a value at a path in the agent state.
 * @type {function(data: {path: string, value: *}, next?: function): AgentOp}
 */
const UpdateState   = makeOp('UpdateState')

/**
 * Op constructor: read a value at a path from the agent state.
 * @type {function(data: {path: string}, next?: function): AgentOp}
 */
const GetState      = makeOp('GetState')

/**
 * Op constructor: run multiple Free programs concurrently and collect results.
 * @type {function(data: {programs: Array}, next?: function): AgentOp}
 */
const Parallel      = makeOp('Parallel')

/**
 * Op constructor: spawn multiple Free programs as independent agents.
 * @type {function(data: {programs: Array}, next?: function): AgentOp}
 */
const Spawn         = makeOp('Spawn')

// --- DSL functions (lift each Op into Free) ---
/**
 * Lift an LLM call into the Free monad.
 * @param {{ messages: Array, tools?: Array, responseFormat?: *, context?: * }} params
 * @returns {Free<AgentOp, *>}
 */
const askLLM       = ({ messages, tools, responseFormat, context } = {}) => {
  if (!Array.isArray(messages)) {
    throw new TypeError(`askLLM: messages must be an array, got ${typeof messages}`)
  }
  return Free.liftF(AskLLM({ messages, tools, responseFormat, context }))
}

/**
 * Lift a tool execution into the Free monad.
 * @param {string} name - Tool name.
 * @param {*} args - Arguments passed to the tool.
 * @returns {Free<AgentOp, *>}
 */
const executeTool  = (name, args)      => Free.liftF(ExecuteTool({ name, args }))

/**
 * Lift a respond action into the Free monad.
 * @param {string} message
 * @returns {Free<AgentOp, void>}
 */
const respond      = (message)         => Free.liftF(Respond({ message }))

/**
 * Lift a human-approval request into the Free monad.
 * @param {string} description
 * @returns {Free<AgentOp, boolean>}
 */
const approve      = (description)     => Free.liftF(Approve({ description }))

/**
 * Lift a delegation request into the Free monad.
 * @param {string} target - Target agent identifier.
 * @param {*} task
 * @returns {Free<AgentOp, *>}
 */
const delegate     = (target, task)    => Free.liftF(Delegate({ target, task }))

/**
 * Lift an observation into the Free monad.
 * @param {string} source - Event/data source identifier.
 * @param {*} data
 * @returns {Free<AgentOp, void>}
 */
const observe      = (source, data)    => Free.liftF(Observe({ source, data }))

/**
 * Lift a state-update operation into the Free monad.
 * @param {string} path - Dot-separated path into agent state.
 * @param {*} value
 * @returns {Free<AgentOp, void>}
 */
const updateState  = (path, value)     => Free.liftF(UpdateState({ path, value }))

/**
 * Lift a state-read operation into the Free monad.
 * @param {string} path - Dot-separated path into agent state.
 * @returns {Free<AgentOp, *>}
 */
const getState     = (path)            => Free.liftF(GetState({ path }))

/**
 * Lift a parallel execution into the Free monad.
 * @param {Array<Free>} programs - Programs to run concurrently.
 * @returns {Free<AgentOp, Array>}
 */
const parallel     = (programs)        => Free.liftF(Parallel({ programs }))

/**
 * Lift a spawn operation into the Free monad.
 * @param {Array<Free>} programs - Programs to spawn as independent agents.
 * @returns {Free<AgentOp, void>}
 */
const spawn        = (programs)        => Free.liftF(Spawn({ programs }))

// --- StateT(Task) runner ---
// Free 프로그램을 StateT(Task) 인터프리터로 실행.
// 인터프리터: Op → StateT(Task), 순수 상태 전이 + 비동기 효과 분리.
// 반환: Promise<[result, finalState]>
/**
 * Execute a Free program step-by-step using a StateT(Task) interpreter.
 * @param {function(AgentOp): StateT<Task, [Free, *]>} interpret - Maps each Op to a StateT(Task) computation.
 * @param {*} ST - StateT constructor (unused at call-site, reserved for future combinator use).
 * @returns {function(Free): function(*): Promise<[*, *]>} Curried runner: program → initialState → Promise<[result, finalState]>
 */
const runFreeWithStateT = (interpret, ST) => program => initialState =>
  new Promise((resolve, reject) => {
    const step = (state, free) => {
      if (Free.isPure(free)) return resolve([free.value, state])
      if (Free.isImpure(free)) {
        try {
          interpret(free.functor)
            .run(state)
            .fork(reject, ([nextFree, newState]) => step(newState, nextFree))
        } catch (err) { reject(err) }
      } else {
        reject(new Error('runFreeWithStateT: unexpected Free node'))
      }
    }
    step(initialState, program)
  })

export {
  makeOp, FUNCTOR, Free, Either, Task, StateT, identity, once, pipe,
  runFreeWithStateT,
  AskLLM, ExecuteTool, Respond, Approve, Delegate,
  Observe, UpdateState, GetState, Parallel, Spawn,
  askLLM, executeTool, respond, approve, delegate,
  observe, updateState, getState, parallel, spawn,
}
