// =============================================================================
// Session: 세션이 무엇인지, 어떤 순서로 생성되고 종료되는지 정의.
// 직접 인스턴스화하지 않음 — Session.create() 팩토리 사용.
// =============================================================================

import { isPathAllowed } from '../tools/local-tools.js'
import { assertValidAgentId } from '@presence/core/core/agent-id.js'

// workingDir 결정 (생성 시점):
// 1. opts.workingDir — POST /sessions body 또는 명시 생성
// 2. userContext.config.tools.allowedDirs[0] — fallback. pendingBackfill 플래그 세움
// 3. 둘 다 없으면 throw (process.cwd() fallback 없음)
// 경계 검증: workingDir 은 반드시 allowedDirs 안쪽. 위반 시 throw.
const resolveWorkingDir = (userContext, opts) => {
  const allowedDirs = userContext.config.tools?.allowedDirs || []
  if (allowedDirs.length === 0) {
    throw new Error('Session: workingDir not resolvable (config.tools.allowedDirs is empty)')
  }
  const explicit = opts.workingDir
  if (explicit) {
    if (!isPathAllowed(explicit, allowedDirs)) {
      throw new Error(`Session: workingDir "${explicit}" outside allowedDirs [${allowedDirs.join(', ')}]`)
    }
    return { workingDir: explicit, pendingBackfill: false }
  }
  return { workingDir: allowedDirs[0], pendingBackfill: true }
}

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
    // workingDir: 세션 실행 컨텍스트의 기준점. tool, prompt, API 응답의 단일 진실.
    const resolved = resolveWorkingDir(userContext, opts)
    this.workingDir = resolved.workingDir
    this.pendingBackfill = resolved.pendingBackfill
    this.logger.info(`Session agentId=${this.agentId} workingDir=${this.workingDir}${this.pendingBackfill ? ' (pending backfill)' : ''}`)
    this.initState()
    this.initTurnControl()
    this.initFsm()
    this.initPersistence(opts)
    this.restoreState()
    this.initToolRegistry(userContext)
    this.initInterpreter(userContext)
    this.initActors(userContext, opts)
    this.initAgent(userContext)
    this.initScheduler(userContext, opts)
    this.initTools(userContext, opts)
    this.initMonitor(opts)
  }

  // --- 생성 단계 (서브클래스에서 구현) ---

  initState() {}
  initTurnControl() {}
  initFsm() {}
  initPersistence() {}
  restoreState() {}
  initToolRegistry() {}
  initInterpreter() {}
  initActors() {}
  initAgent() {}
  initScheduler() {}
  initTools() {}
  initMonitor() {}

  // --- 공개 인터페이스 (서브클래스에서 구현) ---

  async handleInput() {}
  handleApproveResponse() {}
  handleCancel() {}
  emit() {}

  // --- 종료 알고리즘 ---

  async shutdown() {
    this.shutdownScheduler()
    this.shutdownActors()
    this.shutdownFsm()
    this.clearTimers()
    await this.flushPersistence()
  }

  // --- 데이터 삭제 (세션 destroy 시) ---

  async cleanup() {
    await this.shutdown()
    this.clearPersistence()
  }

  // --- 종료 단계 (서브클래스에서 구현) ---

  shutdownScheduler() {}
  shutdownActors() {}
  shutdownFsm() {}
  clearTimers() {}
  async flushPersistence() {}
  clearPersistence() {}
}

export { Session }
