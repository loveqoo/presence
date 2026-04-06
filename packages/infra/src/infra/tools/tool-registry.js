// =============================================================================
// ToolRegistry: 모든 도구의 단일 관리 지점.
//
// 도구 엔트리: { name, description, parameters, handler, source, group, promptVisible, enabled }
// source: 'local' | 'mcp' | 'system'
// group: MCP 서버 단위 일괄 제어용 (null이면 개별)
// promptVisible: LLM 프롬프트 포함 여부
// enabled: 활성 상태
//
// MCP 도구는 group 단위만 enable/disable. 개별 disable(name) 시 source='mcp'이면 false 반환.
// =============================================================================

const TOOL_SOURCE = Object.freeze({
  LOCAL: 'local',
  MCP: 'mcp',
  SYSTEM: 'system',
})

class ToolRegistry {
  #tools = new Map()
  #groups = new Map()  // group → { group, serverName }

  // --- 등록 ---

  register(tool) {
    const entry = {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters,
      handler: tool.handler,
      source: tool.source || TOOL_SOURCE.LOCAL,
      group: tool.group || null,
      promptVisible: tool.promptVisible !== false,
      enabled: tool.enabled !== false,
    }
    this.#tools.set(entry.name, entry)
  }

  registerGroup({ group, serverName }) {
    this.#groups.set(group, { group, serverName })
  }

  // --- 조회 ---

  // enabled 도구만 (인터프리터용)
  get(name) {
    const tool = this.#tools.get(name)
    return (tool && tool.enabled) ? tool : null
  }

  // enabled 무관 (관리/게이트웨이용 — disabled vs nonexistent 구분)
  find(name) {
    return this.#tools.get(name) || null
  }

  // enabled + promptVisible (프롬프트 빌더용)
  list() {
    return [...this.#tools.values()].filter(t => t.enabled && t.promptVisible)
  }

  // 전체 (관리용)
  listAll() {
    return [...this.#tools.values()]
  }

  // enabled 중 name/description 매칭
  search(query) {
    if (!query) return [...this.#tools.values()].filter(t => t.enabled)
    const q = query.toLowerCase()
    return [...this.#tools.values()].filter(t =>
      t.enabled && (t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)),
    )
  }

  // 도구 이름 목록 (기존 호환)
  schema() {
    return [...this.#tools.keys()]
  }

  // --- enable/disable ---

  // 개별 제어. source='mcp'이면 false 반환 (MCP는 group 단위만).
  enable(name) {
    const tool = this.#tools.get(name)
    if (!tool) return false
    if (tool.source === TOOL_SOURCE.MCP) return false
    tool.enabled = true
    return true
  }

  disable(name) {
    const tool = this.#tools.get(name)
    if (!tool) return false
    if (tool.source === TOOL_SOURCE.MCP) return false
    tool.enabled = false
    return true
  }

  // 그룹 제어
  enableGroup(group) {
    let found = false
    for (const tool of this.#tools.values()) {
      if (tool.group === group) { tool.enabled = true; found = true }
    }
    return found
  }

  disableGroup(group) {
    let found = false
    for (const tool of this.#tools.values()) {
      if (tool.group === group) { tool.enabled = false; found = true }
    }
    return found
  }

  // 그룹 목록 (등록 순서 유지)
  groups() {
    return [...this.#groups.values()].map(({ group, serverName }) => {
      const tools = [...this.#tools.values()].filter(t => t.group === group)
      return {
        group,
        serverName,
        enabled: tools.length > 0 && tools.every(t => t.enabled),
        toolCount: tools.length,
      }
    })
  }
}

// =============================================================================
// ToolRegistryView: 읽기 전용 뷰. persona filter 적용.
// 세션이 인터프리터에 전달하는 인터페이스.
// =============================================================================

class ToolRegistryView {
  #registry
  #filter

  constructor(registry, filter) {
    this.#registry = registry
    this.#filter = filter
  }

  get(name) {
    const tool = this.#registry.get(name)
    return (tool && this.#filter(tool)) ? tool : null
  }

  list() {
    return this.#registry.list().filter(this.#filter)
  }

  search(query) {
    return this.#registry.search(query).filter(this.#filter)
  }

  // 기존 호환
  schema() {
    return this.list().map(t => t.name)
  }
}

// 레거시 팩토리 호환
const createToolRegistry = () => new ToolRegistry()

export { ToolRegistry, ToolRegistryView, TOOL_SOURCE, createToolRegistry }
