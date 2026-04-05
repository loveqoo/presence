// Workspace smoke test: @presence/* export map이 실제로 resolve되는지 검증.
// 각 패키지의 핵심 진입점을 import하고 최소한의 shape를 확인한다.

import { assert, check, summary } from '../lib/assert.js'

// --- @presence/core ---
import { PHASE } from '@presence/core/core/policies.js'
import { Agent } from '@presence/core/core/agent.js'
import { askLLM, executeTool, respond, updateState, getState } from '@presence/core/core/op.js'
import { DEBUG, HISTORY, PROMPT } from '@presence/core/core/policies.js'
import { SESSION_TYPE } from '@presence/infra/infra/constants.js'
import { createTestInterpreter } from '@presence/core/interpreter/test.js'
import fp from '@presence/core/lib/fun-fp.js'
import { getByPath } from '@presence/core/lib/path.js'

// --- @presence/infra ---
import { UserContext } from '@presence/infra/infra/user-context.js'
import { Session } from '@presence/infra/infra/sessions/index.js'
import { createSessionManager } from '@presence/infra/infra/sessions/session-manager.js'
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { prodInterpreterR } from '@presence/infra/interpreter/prod.js'
import { delegateInterpreterR } from '@presence/infra/interpreter/delegate.js'
import { initI18n, t } from '@presence/infra/i18n'

console.log('Workspace smoke tests')

// @presence/core
assert(typeof Agent === 'function',                  'core: Agent is a class/function')
assert(typeof new Agent({}).run === 'function',      'core: Agent.run is a method')
assert(new Agent({}).planner != null,                'core: Agent.planner exists')
assert(PHASE.IDLE === 'idle',                       'core: PHASE.IDLE === "idle"')
assert(PHASE.WORKING === 'working',                 'core: PHASE.WORKING === "working"')
assert(typeof askLLM === 'function',                'core: op.askLLM is a function')
assert(typeof executeTool === 'function',           'core: op.executeTool is a function')
assert(typeof respond === 'function',               'core: op.respond is a function')
assert(typeof updateState === 'function',           'core: op.updateState is a function')
assert(typeof getState === 'function',              'core: op.getState is a function')
assert(typeof SESSION_TYPE.USER === 'string',       'core: SESSION_TYPE.USER is a string')
assert(typeof HISTORY === 'object' && HISTORY !== null, 'core: HISTORY is an object')
assert(typeof PROMPT === 'object' && PROMPT !== null,   'core: PROMPT is an object')
assert(typeof createTestInterpreter === 'function', 'core: createTestInterpreter is a function')
assert(fp != null,                                  'core: fun-fp default export exists')
assert(getByPath({ a: { b: 42 } }, 'a.b') === 42,  'core: getByPath utility works')

// @presence/infra
assert(typeof UserContext === 'function',   'infra: createGlobalContext is a function')
assert(typeof Session === 'function',               'infra: Session is a class')
assert(typeof createSessionManager === 'function',  'infra: createSessionManager is a function')
assert(typeof createOriginState === 'function',   'infra: createOriginState is a function')
assert(prodInterpreterR != null && typeof prodInterpreterR.run === 'function', 'infra: prodInterpreterR is a Reader')
assert(delegateInterpreterR != null && typeof delegateInterpreterR.run === 'function', 'infra: delegateInterpreterR is a Reader')

initI18n('ko')
assert(typeof t === 'function',                     'infra: i18n t is a function')
assert(typeof t('startup.memory_loaded') === 'string', 'infra: i18n t returns string')

summary()
