import fp from '../lib/fun-fp.js'

const { Free, Reader, identity } = fp

const FUNCTOR = Symbol.for('fun-fp-js/Functor')

// map은 continuation(next)에만 적용. data 필드 변경 금지
const makeOp = tag => (data, next = identity) => ({
  tag, ...data, next,
  [FUNCTOR]: true,
  map: f => makeOp(tag)(data, x => f(next(x)))
})

// --- Op constructors ---

const AskLLM       = makeOp('AskLLM')
const ExecuteTool   = makeOp('ExecuteTool')
const Respond       = makeOp('Respond')
const Approve       = makeOp('Approve')
const Delegate      = makeOp('Delegate')
const SendTodo      = makeOp('SendTodo')
const Observe       = makeOp('Observe')
const UpdateState   = makeOp('UpdateState')
const GetState      = makeOp('GetState')
const Parallel      = makeOp('Parallel')
const Spawn         = makeOp('Spawn')

// --- DSL Reader (Op → Free, Reader 기반 합성 가능) ---

const askLLMR = Reader.asks(({ messages, tools, responseFormat, maxTokens, context }) => {
  if (!Array.isArray(messages)) {
    throw new TypeError(`askLLM: messages must be an array, got ${typeof messages}`)
  }
  return Free.liftF(AskLLM({ messages, tools, responseFormat, maxTokens, context }))
})
const executeToolR = Reader.asks(({ name, args }) => Free.liftF(ExecuteTool({ name, args })))
const respondR     = Reader.asks(({ message }) => Free.liftF(Respond({ message })))
const approveR     = Reader.asks(({ description }) => Free.liftF(Approve({ description })))
const delegateR    = Reader.asks(({ target, task }) => Free.liftF(Delegate({ target, task })))
// SendTodo: 같은 유저 agent 간 비동기 TODO 전달 (a2a-internal.md §4.4).
// 반환: { requestId, accepted, error? } — accepted 와 requestId 는 독립.
const sendTodoR    = Reader.asks(({ to, payload, timeoutMs }) => Free.liftF(SendTodo({ to, payload, timeoutMs })))
const observeR     = Reader.asks(({ source, data }) => Free.liftF(Observe({ source, data })))
const updateStateR = Reader.asks(({ path, value }) => Free.liftF(UpdateState({ path, value })))
const getStateR    = Reader.asks(({ path }) => Free.liftF(GetState({ path })))
const parallelR    = Reader.asks(({ programs }) => Free.liftF(Parallel({ programs })))
const spawnR       = Reader.asks(({ programs }) => Free.liftF(Spawn({ programs })))

// --- 레거시 브릿지 (기존 호출처 호환, 단일 라인 위임) ---

const askLLM       = (params) => askLLMR.run(params)
const executeTool  = (name, args) => executeToolR.run({ name, args })
const respond      = (message) => respondR.run({ message })
const approve      = (description) => approveR.run({ description })
const delegate     = (target, task) => delegateR.run({ target, task })
const sendTodo     = (to, payload, timeoutMs) => sendTodoR.run({ to, payload, timeoutMs })
const observe      = (source, data) => observeR.run({ source, data })
const updateState  = (path, value) => updateStateR.run({ path, value })
const getState     = (path) => getStateR.run({ path })
const parallel     = (programs) => parallelR.run({ programs })
const spawn        = (programs) => spawnR.run({ programs })

export {
  AskLLM, ExecuteTool, Respond, Approve, Delegate, SendTodo,
  Observe, UpdateState, GetState, Parallel, Spawn,
  askLLMR, executeToolR, respondR, approveR, delegateR, sendTodoR,
  observeR, updateStateR, getStateR, parallelR, spawnR,
  askLLM, executeTool, respond, approve, delegate, sendTodo,
  observe, updateState, getState, parallel, spawn,
}
