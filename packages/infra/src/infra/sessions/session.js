// =============================================================================
// Session: 세션이 무엇인지, 어떤 순서로 생성되고 종료되는지 정의.
// 직접 인스턴스화하지 않음 — Session.create() 팩토리 사용.
// =============================================================================

class Session {

  // --- 생성 알고리즘 ---

  constructor(userContext, opts = {}) {
    this.userContext = userContext
    this.userId = opts.userId || 'default'
    this.logger = userContext.logger
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
