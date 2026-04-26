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
const SendA2aMessage = makeOp('SendA2aMessage')
const Observe       = makeOp('Observe')
const UpdateState   = makeOp('UpdateState')
const GetState      = makeOp('GetState')
const Parallel      = makeOp('Parallel')
const Spawn         = makeOp('Spawn')
// KG-23 — Cedar 권한 평가의 도메인 어휘. 서비스 레이어와 (미래) LLM 트리거
// 시나리오가 같은 Op data 를 통해 evaluator 를 호출하도록 채널 통일.
// 결과: { decision: 'allow'|'deny', matchedPolicies: string[], errors: string[] }
const CheckAccess   = makeOp('CheckAccess')

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
// SendA2aMessage: 같은 유저 agent 간 비동기 A2A 메시지 전달 (a2a-internal.md §4.4).
// 반환: { requestId, accepted, error? } — accepted 와 requestId 는 독립. category 는 분류 필드 (기본 'todo').
const sendA2aMessageR = Reader.asks(({ to, payload, timeoutMs, category }) =>
  Free.liftF(SendA2aMessage({ to, payload, timeoutMs, category })))
const observeR     = Reader.asks(({ source, data }) => Free.liftF(Observe({ source, data })))
const updateStateR = Reader.asks(({ path, value }) => Free.liftF(UpdateState({ path, value })))
const getStateR    = Reader.asks(({ path }) => Free.liftF(GetState({ path })))
const parallelR    = Reader.asks(({ programs }) => Free.liftF(Parallel({ programs })))
const spawnR       = Reader.asks(({ programs }) => Free.liftF(Spawn({ programs })))
const checkAccessR = Reader.asks(({ principal, action, resource, context }) =>
  Free.liftF(CheckAccess({ principal, action, resource, context: context ?? {} })))

// --- 레거시 브릿지 (기존 호출처 호환, 단일 라인 위임) ---

const askLLM       = (params) => askLLMR.run(params)
const executeTool  = (name, args) => executeToolR.run({ name, args })
const respond      = (message) => respondR.run({ message })
const approve      = (description) => approveR.run({ description })
const delegate     = (target, task) => delegateR.run({ target, task })
const observe      = (source, data) => observeR.run({ source, data })
const updateState  = (path, value) => updateStateR.run({ path, value })
const getState     = (path) => getStateR.run({ path })
const parallel     = (programs) => parallelR.run({ programs })
const spawn        = (programs) => spawnR.run({ programs })
const checkAccess  = (params) => checkAccessR.run(params)

export {
  AskLLM, ExecuteTool, Respond, Approve, Delegate, SendA2aMessage,
  Observe, UpdateState, GetState, Parallel, Spawn, CheckAccess,
  askLLMR, executeToolR, respondR, approveR, delegateR, sendA2aMessageR,
  observeR, updateStateR, getStateR, parallelR, spawnR, checkAccessR,
  askLLM, executeTool, respond, approve, delegate,
  observe, updateState, getState, parallel, spawn, checkAccess,
}
