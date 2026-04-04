// =============================================================================
// Session: 세션이 무엇인지, 어떤 순서로 생성되고 종료되는지 정의.
// 직접 인스턴스화하지 않음 — Session.create() 팩토리 사용.
// =============================================================================

class Session {

  // --- 생성 알고리즘 ---

  constructor(globalCtx, opts = {}) {
    this.logger = globalCtx.logger
    this.initState()
    this.initTurnControl()
    this.initPersistence(opts)
    this.restoreState()
    this.initToolRegistry(globalCtx)
    this.initInterpreter(globalCtx)
    this.initActors(globalCtx, opts)
    this.initAgent(globalCtx)
    this.initScheduler(globalCtx, opts)
    this.initTools(globalCtx, opts)
    this.initMonitor(opts)
  }

  // --- 생성 단계 (서브클래스에서 구현) ---

  initState() {}
  initTurnControl() {}
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
    this.clearTimers()
    await this.flushPersistence()
  }

  // --- 종료 단계 (서브클래스에서 구현) ---

  shutdownScheduler() {}
  shutdownActors() {}
  clearTimers() {}
  async flushPersistence() {}
}

export { Session }
