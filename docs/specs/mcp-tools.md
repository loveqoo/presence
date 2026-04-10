# MCP/도구 정책

## 목적

presence의 도구 등록, MCP 서버 통합, 게이트웨이 패턴, persona 필터링 규칙을 정의한다. 도구는 단일 ToolRegistry를 통해 관리되며, LLM에 노출되는 도구와 내부용 도구가 명확히 구분된다.

## 도구 source 유형

| source | 설명 | 예시 |
|--------|------|------|
| `local` | 로컬 내장 도구 | `file_read`, `shell_exec`, `calculate` |
| `mcp` | MCP 서버 제공 도구 | `mcp0__github_issue_list` |
| `system` | 시스템 게이트웨이 도구 | `mcp_search_tools`, `mcp_call_tool` |

## 불변식 (Invariants)

- I1. **ToolRegistry 단일 진원**: 모든 도구는 UserContext의 `toolRegistry`에 등록된다. 인터프리터, 프롬프트 빌더, 슬래시 커맨드 모두 동일 registry를 참조한다.
- I2. **MCP 도구는 `promptVisible: false`**: MCP 도구는 개별적으로 LLM 프롬프트에 노출되지 않는다. 게이트웨이 도구(`mcp_search_tools`, `mcp_call_tool`)를 통해서만 LLM이 접근한다.
- I3. **게이트웨이 도구는 MCP 도구가 있을 때만 등록**: `initMcpIntegration()`에서 MCP 도구가 하나라도 등록되면 `registerGatewayTools()` 실행. MCP 도구 없으면 게이트웨이 도구도 없음.
- I4. **MCP 도구는 group 단위 enable/disable**: `toolRegistry.disableGroup(group)`, `enableGroup(group)`으로만 MCP 도구 일괄 제어. `disableGroup(group)`은 group 일치 도구를 source 무관하게 비활성화한다. 개별 `disable(name)` / `enable(name)` 은 `source === 'mcp'`이면 false를 반환하고 상태를 변경하지 않는다.
- I5. **MCP prefix 구조**: MCP 도구 이름은 `mcp{idx}{__}{originalName}` 형식. `mcp0__github_issue_list` 등. idx는 연결 순서(0-based). MCP_PREFIX_DELIMITER = `__`.
- I6. **ToolRegistryView는 세션 뷰**: 세션은 UserContext의 `toolRegistry`를 직접 사용하지 않고, persona 필터가 적용된 `ToolRegistryView`를 사용한다.
- I7. **persona 필터**: persona에 `tools` 배열이 정의된 경우, 해당 이름의 도구만 세션에 노출. 빈 배열이거나 tools 미정의 시 전체 노출.
- I8. **mcp_call_tool은 이중 검증**: 전역 registry로 disabled/nonexistent를 먼저 구분하고, 세션의 ToolRegistryView로 persona 적용 여부를 추가 검증한다.
- I9. **도구 핸들러 두 번째 인자**: 도구 `handler(args, context)`의 `context`는 인터프리터 env 전체인 `{ llm, toolRegistry, userDataStore, state, agentRegistry, turnController, logger }` (`ephemeral-session.js:66-70`). MCP 게이트웨이 핸들러(`mcp-tools.js:63-65`)는 그 중 `context.toolRegistry`만 사용한다. `userDataStore`는 env에 포함되지만 게이트웨이 핸들러에서 실제로 사용되지 않는다.
- I10. **MCP 연결 실패는 non-fatal**: 개별 MCP 서버 연결 실패 시 `logger.warn` + 해당 서버 스킵. 나머지 서버와 서버 시작은 계속.
- I11. **도구 allowedTools 필터**: 에이전트 실행 시 `allowedTools` regex 배열로 도구를 추가 제한할 수 있다. `runAgent`에서 적용.

## 경계 조건 (Edge Cases)

- E1. MCP 서버가 0개 설정 → 게이트웨이 도구 미등록. LLM 프롬프트에 MCP 관련 도구 없음.
- E2. `mcp_call_tool(toolName)`에서 toolName이 존재하지 않는 경우 → 핸들러가 `throw new Error('MCP tool not found: ...')` 로 예외 발생. `packages/core/src/interpreter/tool.js`의 `Promise.catch(err => '[ERROR] ${f.name}: ${err.message}')` 경계에서 catch하여 에러 메시지 문자열로 변환 후 턴 계속 진행.
- E3. `mcp_call_tool(toolName)`에서 해당 MCP 서버가 disabled 된 경우 → 핸들러가 `throw new Error('MCP server disabled: ...')` 로 예외 발생. 동일하게 `tool.js` Promise catch 경계에서 에러 메시지 문자열로 변환.
- E4. persona.tools에 없는 도구를 `mcp_call_tool`로 호출 → ToolRegistryView.get()에서 null 반환 → `"MCP tool not found"` 에러.
- E5. `/mcp enable <id>`에서 존재하지 않는 group id → `"Unknown MCP id: {group}"` 반환.
- E6. 같은 이름으로 두 번 `toolRegistry.register()` 호출 → 두 번째가 덮어씀 (last-write-wins). 중복 등록 경고 없음.
- E7. allowedTools regex가 잘못된 정규식 → `new RegExp(pattern)` 예외를 catch하고 false 반환 (해당 패턴 무시).
- E8. `config.mcp` 항목에 `enabled: false` → 연결 시도 자체를 건너뜀. `if (!server.enabled) continue`.

## 테스트 커버리지

- I1 → `packages/infra/test/tools.test.js` (ToolRegistry 단일 관리)
- I2, I3 → `packages/infra/test/tools.test.js` (MCP promptVisible=false, 게이트웨이 조건부 등록)
- I4 → `packages/infra/test/tools.test.js` (group enable/disable)
- I6, I7 → `packages/infra/test/tools.test.js` (ToolRegistryView, persona 필터)
- I8 → `packages/infra/test/tools.test.js` (mcp_call_tool 이중 검증)
- I10 → `packages/infra/test/mcp.test.js` (연결 실패 non-fatal)
- E2, E3 → `packages/infra/test/tools.test.js` (mcp_call_tool 에러 메시지)
- E6 → (미커버) ⚠️ 중복 등록 last-write-wins 동작 테스트 없음
- I11 → `packages/infra/test/session.test.js` (allowedTools 필터)

## 관련 코드

- `packages/infra/src/infra/tools/tool-registry.js` — ToolRegistry, ToolRegistryView, TOOL_SOURCE
- `packages/infra/src/infra/tools/local-tools.js` — 내장 로컬 도구 6개
- `packages/infra/src/infra/tools/mcp-tools.js` — MCP 연결, 게이트웨이 도구 등록
- `packages/infra/src/infra/mcp/connection.js` — MCP 서버 연결
- `packages/infra/src/infra/sessions/ephemeral-session.js` — ToolRegistryView 생성, persona 필터
- `packages/server/src/server/session-api.js` — `/mcp` 슬래시 커맨드

## 변경 이력

- 2026-04-10: 초기 작성
- 2026-04-10: I4 disableGroup 동작 정정 — disableGroup은 source 무관, disable(name)/enable(name)만 source='mcp' 체크
- 2026-04-10: I9 정정 — context 필드를 { toolRegistry, userDataStore }에서 인터프리터 env 전체({ llm, toolRegistry, userDataStore, state, agentRegistry, turnController, logger })로 정정. 게이트웨이 핸들러는 toolRegistry만 사용함을 명시.
- 2026-04-10: E2/E3 정정 — "에러 메시지 반환"에서 "throw new Error + tool.js Promise.catch 경계에서 에러 문자열 변환"으로 정정.
