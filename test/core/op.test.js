import {
  FUNCTOR, Free,
  AskLLM, ExecuteTool, Respond, Approve, Delegate,
  Observe, UpdateState, GetState, Parallel, Spawn,
  askLLM, executeTool, respond, approve, delegate,
  observe, updateState, getState, parallel, spawn,
} from '@presence/core/core/op.js'

import { assert, summary } from '../lib/assert.js'

console.log('Op ADT tests')

// --- 1. All 10 constructors exist and produce correct tags ---
const ops = [
  ['AskLLM',      AskLLM({ messages: 'hi' })],
  ['ExecuteTool',  ExecuteTool({ name: 'test', args: {} })],
  ['Respond',      Respond({ message: 'ok' })],
  ['Approve',      Approve({ description: 'send?' })],
  ['Delegate',     Delegate({ target: 'agent1', task: 'do stuff' })],
  ['Observe',      Observe({ source: 'tool', data: { x: 1 } })],
  ['UpdateState',  UpdateState({ path: 'a.b', value: 42 })],
  ['GetState',     GetState({ path: 'a.b' })],
  ['Parallel',     Parallel({ programs: [] })],
  ['Spawn',        Spawn({ programs: [] })],
]

for (const [tag, op] of ops) {
  assert(op.tag === tag, `${tag} has correct tag`)
  assert(op[FUNCTOR] === true, `${tag} has Functor Symbol`)
  assert(typeof op.map === 'function', `${tag} has map`)
  assert(typeof op.next === 'function', `${tag} has next`)
}

// --- 2. Data fields preserved ---
const askOp = AskLLM({ messages: [{ role: 'user', content: 'hello' }], tools: ['t1'], responseFormat: { type: 'json_schema' } })
assert(Array.isArray(askOp.messages), 'AskLLM preserves messages')
assert(askOp.tools[0] === 't1', 'AskLLM preserves tools')
assert(askOp.responseFormat.type === 'json_schema', 'AskLLM preserves responseFormat')

const execOp = ExecuteTool({ name: 'github_list_prs', args: { repo: 'my/repo' } })
assert(execOp.name === 'github_list_prs', 'ExecuteTool preserves name')
assert(execOp.args.repo === 'my/repo', 'ExecuteTool preserves args')

const stateOp = UpdateState({ path: 'status', value: 'working' })
assert(stateOp.path === 'status', 'UpdateState preserves path')
assert(stateOp.value === 'working', 'UpdateState preserves value')

// --- 3. DSL functions return Free.Impure ---
const dslFns = [
  ['askLLM',      askLLM({ messages: [{ role: 'user', content: 'test' }] })],
  ['executeTool',  executeTool('test', {})],
  ['respond',      respond('ok')],
  ['approve',      approve('send?')],
  ['delegate',     delegate('a1', 'task')],
  ['observe',      observe('src', {})],
  ['updateState',  updateState('a', 1)],
  ['getState',     getState('a')],
  ['parallel',     parallel([])],
  ['spawn',        spawn([])],
]

for (const [name, free] of dslFns) {
  assert(Free.isImpure(free), `${name}() returns Free.Impure`)
}

// --- 4. Chain composition works ---
const composed = askLLM({ messages: [{ role: 'user', content: 'hello' }] })
  .chain(result => respond(result))

assert(Free.isImpure(composed), 'askLLM.chain(respond) returns Impure')

// Verify full chain with mock runner
import fp from '../../src/lib/fun-fp.js'
const { Task } = fp

const runner = (functor) => {
  if (functor.tag === 'AskLLM') return Task.of(functor.next('llm-response'))
  if (functor.tag === 'Respond') return Task.of(functor.next('done'))
  return Task.rejected(new Error(`Unknown op: ${functor.tag}`))
}

Free.runWithTask(runner)(composed).then(result => {
  assert(result === 'done', 'chain: askLLM → respond resolves correctly')

  // --- 5. askLLM contract: messages must be an array ---

  // 5a. 거부해야 하는 입력들
  const rejectCases = [
    ['no args',        () => askLLM()],
    ['undefined',      () => askLLM({ messages: undefined })],
    ['string',         () => askLLM({ messages: 'hello' })],
    ['number',         () => askLLM({ messages: 42 })],
    ['object',         () => askLLM({ messages: { role: 'user' } })],
    ['null',           () => askLLM({ messages: null })],
  ]
  for (const [label, fn] of rejectCases) {
    try { fn(); assert(false, `askLLM(${label}): should throw`) }
    catch (e) { assert(e instanceof TypeError, `askLLM(${label}): throws TypeError`) }
  }

  // 5b. 허용해야 하는 입력
  const msgsOnly = askLLM({ messages: [{ role: 'user', content: 'hi' }] })
  assert(Free.isImpure(msgsOnly), 'askLLM([...]): valid Impure')
  const emptyArr = askLLM({ messages: [] })
  assert(Free.isImpure(emptyArr), 'askLLM([]): empty array is valid Impure')

  // askLLM with all fields
  const allFields = askLLM({
    messages: [{ role: 'user', content: 'test' }],
    tools: ['tool1'],
    responseFormat: { type: 'json_schema' },
    context: ['prev result'],
  })
  assert(Free.isImpure(allFields), 'askLLM(all fields): valid Impure')

  // Verify all fields arrive at the functor
  return Free.runWithTask((functor) => {
    assert(Array.isArray(functor.messages), 'askLLM all fields: messages preserved')
    assert(functor.tools[0] === 'tool1', 'askLLM all fields: tools preserved')
    assert(functor.responseFormat.type === 'json_schema', 'askLLM all fields: responseFormat preserved')
    assert(functor.context[0] === 'prev result', 'askLLM all fields: context preserved')
    return Task.of(functor.next('ok'))
  })(allFields)
}).then(() => {
  summary()
})
