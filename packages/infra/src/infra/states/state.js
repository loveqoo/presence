import fp from '@presence/core/lib/fun-fp.js'

const { Reader } = fp

// =============================================================================
// State: agent state 추상 계층.
// 구현체: OriginState(서버 authoritative), MirrorState(WS 미러).
//
// 공통 계약: { get(path), set(path, value), hooks: { on, off } }
// 공통 메커니즘: HookBus (path 기반 pub/sub + StateChange 전파)
// =============================================================================

// --- StateChange ADT: 상태 전이를 값으로 표현 ---
// prevRoot/nextRoot 는 포함하지 않음 — full root 참조가 hook 콜백에 남으면
// old tree 가 GC 되지 않아 메모리 누수 위험. 소비처는 prevValue/nextValue 만 사용.
const StateChange = (path, prevValue, nextValue) => ({
  path,
  prevValue,
  nextValue,
})

// --- Wildcard 매칭: 'events.*'가 'events.github'를 매치 (한 단계만) ---
const matchesWildcard = (pattern, path) => {
  if (!pattern.includes('*')) return false
  const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]+') + '$')
  return regex.test(path)
}

// --- HookBus: 구독/발행 전담 (StateChange 기반) ---
class HookBus {
  static MAX_DEPTH = 10

  constructor() {
    this.subscribers = new Map()
    this.depth = 0
  }

  on(pattern, handler) {
    if (!this.subscribers.has(pattern)) this.subscribers.set(pattern, [])
    this.subscribers.get(pattern).push(handler)
  }

  off(pattern, handler) {
    const handlers = this.subscribers.get(pattern)
    if (!handlers) return
    const idx = handlers.indexOf(handler)
    if (idx !== -1) handlers.splice(idx, 1)
  }

  publish(change, state) {
    if (this.depth >= HookBus.MAX_DEPTH) return
    this.depth++
    try {
      this.invokeHandlers(this.subscribers.get(change.path) || [], change, state)
      for (const [pattern, handlers] of this.subscribers) {
        if (matchesWildcard(pattern, change.path)) this.invokeHandlers(handlers, change, state)
      }
    } finally {
      this.depth--
    }
  }

  // 예외 격리 + async rejection fire-and-forget.
  invokeHandlers(handlers, change, state) {
    for (const handler of [...handlers]) {
      try {
        const result = handler(change, state)
        if (result && typeof result.catch === 'function') result.catch(() => {})
      }
      catch (_) { /* error isolation */ }
    }
  }
}

// --- State: 추상 base. HookBus 소유 + hooks 퍼사드 노출 ---
class State {
  constructor() {
    this.bus = new HookBus()
    this.hooks = {
      on: this.bus.on.bind(this.bus),
      off: this.bus.off.bind(this.bus),
    }
  }

  get(path) { throw new Error('State.get: not implemented') }
  set(path, value) { throw new Error('State.set: not implemented') }
}

// --- Reader factories (테스트·합성용) ---
const hookBusR = Reader.asks(() => new HookBus())
const createHookBus = () => hookBusR.run({})

export { State, HookBus, StateChange, createHookBus, hookBusR }
