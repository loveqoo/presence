// =============================================================================
// Session: 세션이 무엇인지, 어떤 순서로 생성되고 종료되는지 정의.
// 직접 인스턴스화하지 않음 — Session.create() 팩토리 사용.
//
// init/shutdown 단계는 subclass 가 override — 빈 placeholder 대신
// optional chaining 으로 호출 (undefined 이면 skip).
// =============================================================================

import { Config } from '../config.js'
import { assertValidAgentId } from '@presence/core/core/agent-id.js'

// docs/specs/agent-identity.md — workingDir 은 유저 workspace 로 고정.
// `~/.presence/users/{userId}/`. tool / shell_exec / persistence 의 유일 기준점.
// 런타임 변경 불가. 세션별 차등 없음. 모든 유저 동일 규칙 (admin 포함).
const resolveWorkspace = (userId) => Config.userDataPath(userId)

class Session {

  // --- 생성 알고리즘 ---

  constructor(userContext, opts = {}) {
    this.userContext = userContext
    this.userId = opts.userId || 'default'
    // agentId: 세션 소속 agent 식별자 ({username}/{agentName}). 생성 후 불변.
    // docs/design/agent-identity-model.md §5.1. 호출처가 반드시 제공.
    if (typeof opts.agentId !== 'string' || opts.agentId.length === 0) {
      throw new Error(`Session: agentId required (got ${typeof opts.agentId})`)
    }
    assertValidAgentId(opts.agentId)
    this.agentId = opts.agentId
    this.logger = userContext.logger
    // workingDir: userId 에서 자동 결정. 외부 입력 (opts.workingDir) 무시.
    this.workingDir = resolveWorkspace(this.userId)
    this.logger.info(`Session agentId=${this.agentId} workingDir=${this.workingDir}`)
    // 각 단계를 subclass override 에 맡김 — 없으면 skip.
    this.initState?.()
    this.initTurnControl?.()
    this.initFsm?.()
    this.initPersistence?.(opts)
    this.restoreState?.()
    this.initToolRegistry?.(userContext)
    this.initInterpreter?.(userContext)
    this.initActors?.(userContext, opts)
    this.initAgent?.(userContext)
    this.initScheduler?.(userContext, opts)
    this.initTools?.(userContext, opts)
    this.initMonitor?.(opts)
  }

  // --- 종료 알고리즘 ---

  async shutdown() {
    this.shutdownScheduler?.()
    this.shutdownActors?.()
    this.shutdownFsm?.()
    this.clearTimers?.()
    await this.flushPersistence?.()
  }

  // --- 데이터 삭제 (세션 destroy 시) ---

  async cleanup() {
    await this.shutdown()
    this.clearPersistence?.()
  }
}

export { Session }
