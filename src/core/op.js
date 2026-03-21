import fp from '../lib/fun-fp.js'

const { Free, Either, Task, identity, once, pipe } = fp
const FUNCTOR = Symbol.for('fun-fp-js/Functor')

// --- makeOp factory ---
const makeOp = tag => (data, next = identity) => ({
  tag, ...data, next,
  [FUNCTOR]: true,
  map: f => makeOp(tag)(data, x => f(next(x)))
})

// --- Op constructors (10) ---
const AskLLM       = makeOp('AskLLM')
const ExecuteTool   = makeOp('ExecuteTool')
const Respond       = makeOp('Respond')
const Approve       = makeOp('Approve')
const Delegate      = makeOp('Delegate')
const Observe       = makeOp('Observe')
const UpdateState   = makeOp('UpdateState')
const GetState      = makeOp('GetState')
const Parallel      = makeOp('Parallel')
const Spawn         = makeOp('Spawn')

// --- DSL functions (lift each Op into Free) ---
const askLLM       = ({ messages, tools, responseFormat, context } = {}) => {
  if (!Array.isArray(messages)) {
    throw new TypeError(`askLLM: messages must be an array, got ${typeof messages}`)
  }
  return Free.liftF(AskLLM({ messages, tools, responseFormat, context }))
}
const executeTool  = (name, args)      => Free.liftF(ExecuteTool({ name, args }))
const respond      = (message)         => Free.liftF(Respond({ message }))
const approve      = (description)     => Free.liftF(Approve({ description }))
const delegate     = (target, task)    => Free.liftF(Delegate({ target, task }))
const observe      = (source, data)    => Free.liftF(Observe({ source, data }))
const updateState  = (path, value)     => Free.liftF(UpdateState({ path, value }))
const getState     = (path)            => Free.liftF(GetState({ path }))
const parallel     = (programs)        => Free.liftF(Parallel({ programs }))
const spawn        = (programs)        => Free.liftF(Spawn({ programs }))

export {
  makeOp, FUNCTOR, Free, Either, Task, identity, once, pipe,
  AskLLM, ExecuteTool, Respond, Approve, Delegate,
  Observe, UpdateState, GetState, Parallel, Spawn,
  askLLM, executeTool, respond, approve, delegate,
  observe, updateState, getState, parallel, spawn,
}
