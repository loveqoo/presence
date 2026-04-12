# Transcript 오버레이 정책

## 목적

TranscriptOverlay는 에이전트 턴의 내부 상태를 사용자가 사후 검토할 수 있도록 4개 탭으로 노출한다.
이 스펙은 각 탭이 무엇을 보장해야 하는지, 특히 멀티턴(반복 계획 수정) 시 데이터 가시성 계약을 정의한다.

## 4탭 계약

| 탭 | i18n 키 | 데이터 원천 | 표시 내용 |
|----|---------|------------|---------|
| Op Chain | `tab_op_chain` | `agentState.opTrace` | 마지막 턴의 Free Op 실행 순서 (summary / detailed 토글) |
| Turn | `tab_turn` | `agentState.debug`, `agentState.recalledMemories` | 입력, 파싱 결과, 예산, 회수된 메모리 |
| Prompt | `tab_prompt` | `STATE_PATH.DEBUG_LAST_PROMPT` (state 직접) | 마지막 LLM 요청 메시지 배열, role별 색상 |
| Response | `tab_response` | `STATE_PATH.DEBUG_LAST_RESPONSE` (state 직접) | 마지막 LLM 응답 원문, JSON이면 syntax highlighting |

## 불변식 (Invariants)

- I1. **탭 순서 고정**: `TAB_KEYS = ['tab_op_chain', 'tab_turn', 'tab_prompt', 'tab_response']` 순서는 변경하지 않는다. 키바인딩(←/→)이 이 순서에 의존한다.

- I2. **스크롤 상태 탭별 독립**: 각 탭의 스크롤 오프셋은 서로 영향을 주지 않는다. 탭 전환 시 스크롤 위치가 유지된다.

- I3. **데이터 없음 처리**: 각 탭은 데이터가 null/빈 배열일 때 회색으로 "데이터 없음" 메시지를 반환해야 한다. 빈 화면이나 에러로 크래시하면 안 된다.

- I4. **`iterationHistory` 구독**: `useAgentState`는 `STATE_PATH.DEBUG_ITERATION_HISTORY` 경로를 구독하고 `iterationHistory`로 보관한다. 이 데이터는 `Planner.DebugRecorder.record()`가 각 LLM 호출(iteration)마다 기록하는 내역이다.

- I5. **`iterationHistory` 최대 보관**: 한 턴 내 최대 `DEBUG.MAX_ITERATION_HISTORY`(현재 10)개 iteration을 보관한다. 초과 시 오래된 항목부터 제거된다.

## 경계 조건 (Edge Cases)

- E1. **싱글턴(iteration 1회)**: `iterationHistory.length === 1`이면 "Iteration 1" 항목만 있고 중간 응답이 없다. Response 탭과 동일한 내용이다.

- E2. **멀티턴(iteration 2회 이상)**: `iterationHistory.length > 1`일 때 Response 탭은 `DEBUG_LAST_RESPONSE` — 마지막 iteration의 응답만 보여준다. 1번, 2번 등 중간 iteration의 응답·프롬프트는 TranscriptOverlay 어디에도 표시되지 않는다.

- E3. **`/clear` 후 오버레이 진입**: `clearDebugState()`가 `DEBUG_ITERATION_HISTORY`를 `[]`로 초기화하므로 오버레이는 빈 데이터를 표시한다. 크래시하지 않아야 한다.

- E4. **오버레이 열린 상태에서 새 턴 시작**: `Executor.run()`이 `DEBUG_ITERATION_HISTORY`를 `[]`로 리셋하고 새 항목을 append한다. React 상태는 `STATE_PATH.DEBUG_ITERATION_HISTORY` 핸들러를 통해 자동 동기화된다. 오버레이가 열려 있는 동안 데이터가 갱신될 수 있다.

- E5. **`maxIterations` 초과로 실패**: `ERROR_KIND.MAX_ITERATIONS` 실패 시에도 그 시점까지의 `iterationHistory`는 보관된다. Turn 탭의 `debug.error`에 에러 종류가 표시된다.

## Known Gap

### KG-08: 멀티턴 시 중간 LLM 응답이 TranscriptOverlay에 표시되지 않음 (REGISTRY: KG-08)

**상황**: Planner가 `maxIterations > 1` 환경에서 멀티 iteration으로 실행될 때, 각 iteration의 LLM 응답은 `iterationHistory` 배열에 기록된다. 그러나 TranscriptOverlay에 `iterationHistory`가 전달되지 않아 중간 응답을 볼 수 없다.

**원인 위치**:
- `packages/tui/src/ui/App.js` — TranscriptOverlay 마운트 시 `iterationHistory`를 props에 포함하지 않음
- `packages/tui/src/ui/components/TranscriptOverlay.js` — `iterationHistory` prop 정의 없음
- `packages/tui/src/ui/components/transcript/` — iteration별 응답을 렌더링하는 컴포넌트 없음

**데이터 가용성**: `agentState.iterationHistory`는 `useAgentState`에서 이미 구독·보관 중이다. 데이터 파이프라인은 완성되어 있으며, UI 표시 경로만 없다.

**`report.js` 비교**: `packages/tui/src/ui/report.js:78-98`에는 `iterationHistory`를 순회하여 각 iteration 응답을 마크다운으로 출력하는 로직이 구현되어 있다. `/report` 커맨드(파일 저장 경로)는 동작하지만 인터랙티브 TranscriptOverlay 경로는 미구현이다.

**해소 방향**:
1. `App.js`에서 `iterationHistory: agentState.iterationHistory`를 `TranscriptOverlay` props에 추가
2. `TranscriptOverlay.js`에서 `iterationHistory` prop을 수신하고, iteration이 2개 이상일 때만 표시되는 "Iterations" 탭 또는 "Response" 탭 내 내비게이션 추가
3. 각 iteration 항목(`{ iteration, parsedType, stepCount, error, assembly, promptMessages, promptChars, response }`)을 렌더링하는 컴포넌트 작성

**판단**: 새 탭으로 추가할지, Response 탭 내에서 iteration 선택기를 추가할지는 UX 결정 사항이다.

## 테스트 커버리지

- I1 → (미커버) ⚠️ TAB_KEYS 순서 검증 없음
- I2 → (미커버) ⚠️ 탭별 스크롤 독립성 검증 없음
- I3 → (부분 커버) report.js 단위 수준. TranscriptOverlay 컴포넌트 레벨 테스트 없음 ⚠️
- I4 → `packages/tui/src/ui/hooks/useAgentState.js` 구독 확인 (코드 레벨). 시나리오 테스트 없음 ⚠️
- E2 (KG-08) → (미커버) 멀티턴 시 중간 응답 미표시에 대한 테스트 없음 ⚠️

## 관련 코드

- `packages/tui/src/ui/components/TranscriptOverlay.js` — 오버레이 컴포넌트, 탭 구조
- `packages/tui/src/ui/components/transcript/response.js` — Response 탭 렌더러
- `packages/tui/src/ui/components/transcript/turn.js` — Turn 탭 렌더러
- `packages/tui/src/ui/components/transcript/op-chain.js` — Op Chain 탭 렌더러 (summary/detailed)
- `packages/tui/src/ui/components/transcript/prompt.js` — Prompt 탭 렌더러
- `packages/tui/src/ui/hooks/useAgentState.js` — `iterationHistory` 구독 및 보관
- `packages/tui/src/ui/App.js` — TranscriptOverlay 마운트, props 조립
- `packages/core/src/core/planner.js` — `DebugRecorder.record()`, `iterationHistory` 기록
- `packages/core/src/core/policies.js` — `STATE_PATH.DEBUG_ITERATION_HISTORY`, `DEBUG.MAX_ITERATION_HISTORY`
- `packages/tui/src/ui/report.js` — `/report` 경로의 iterationHistory 렌더링 (참고 구현)

## 변경 이력

- 2026-04-12: 초기 작성 — 4탭 계약, 멀티턴 중간 응답 미표시 갭(KG-08) 식별
