# Planner 정책

## 목적

에이전트 턴을 두 계층으로 분리하여 LLM의 관심사와 인터프리터의 관심사를 격리한다.
**Plan 계층**은 LLM이 JSON wire format으로 내보내는 실행 의도(Op 코드 목록)이고,
**Free 계층**은 인터프리터가 실제 효과를 실행하는 단위(Op ADT)다.
LLM은 플랜만 생성하고 실제 IO·상태 변경·에러 처리는 인터프리터 영역이기 때문에
계층이 두 개여야 한다: 하나로 합치면 LLM 출력 파싱 실패가 곧 부작용 실행 실패와 동치가 된다.
`Executor`는 이 두 계층 사이의 생명주기를 조율하는 조율자다.

## 불변식 (Invariants)

- I1. **두 계층 분리**: Plan Op(JSON wire)와 Free Op(ADT)는 서로 다른 표현이다.
  Plan Op 코드 문자열은 `op-handler.js`의 `ops` 테이블이 권위이고,
  Free Op는 `op.js`의 ADT 생성자가 권위다.
  변환은 `Planner.normalizeStep()` → `ops[step.op].execute()` 경로만 허용된다.
  Plan이 Free를 직접 생성하거나 인터프리터가 Plan을 읽는 역방향은 없다.

- I2. **Plan Op 목록 중앙화**: 유효한 Plan Op 코드는 `op-handler.js`의 `ops` 객체 키
  (`LOOKUP_MEMORY`, `ASK_LLM`, `EXEC`, `RESPOND`, `APPROVE`, `DELEGATE`)
  만 인정된다.
  `validatePlan`은 `ops[step.op]`가 없으면 `Either.Left`를 반환해 해당 플랜을 거부한다.

- I3. **EXEC 변환 규칙**: `normalizeStep`은 `EXEC` 단계에서 두 가지 특수 케이스를 변환한다.
  `EXEC(tool='delegate')` → `DELEGATE`, `EXEC(tool='approve')` → `APPROVE`.
  이 변환 이후에 일반 `ExecOp`로 처리되는 경로는 없다.
  즉, `delegate`·`approve` 이름의 MCP 도구가 존재해도 `EXEC`로 실행될 수 없다.

- I4. **Executor 의존성 계약**: `Executor`는 생성 시 `{ interpret, ST, state, actors }`를 받는다.
  `run(program, input)`은 이 의존성으로
  `beginLifecycle → recallMemories → runFreeWithStateT → afterTurn → persist` 순서를 수행한다.
  어떤 인터프리터를 쓰는지 Executor는 모른다: `interpret` 함수 하나만 받는다.

- I5. **실패 복구 원자성**: `recover(input, err)`는
  `STATE_PATH.STREAMING`, `STATE_PATH.LAST_TURN`, `STATE_PATH.TURN_STATE`
  세 경로를 하나의 for 루프에서 순차 set하고 즉시 persist한다.
  recover 완료 후 예외를 재전파한다. 재시도는 recover 책임이 아니다.

- I6. **`applyFinalState` epoch 가드**: 턴 완료 시 `MANAGED_PATHS`에 나열된 경로만
  ReactiveState로 커밋된다. `_compactionEpoch`가 턴 시작 시점 대비 변경된 경우
  `STATE_PATH.CONTEXT_CONVERSATION_HISTORY` 경로는 스킵된다.
  `MANAGED_PATHS` 순서는 `TURN_STATE`가 마지막으로 고정된다:
  idle 전이 시 hook이 발동되어 다음 턴이 시작될 수 있으므로
  그 시점에 `conversationHistory`·`lastTurn`이 이미 최신이어야 한다.

- I7. **비동기 부작용 분리**: memory save, compaction check, persistence는
  `fireAndForget`으로 실행되어 턴 완료 경로를 블로킹하지 않는다.
  실패해도 턴 결과에 영향을 주지 않는다.

- I8. **Planner 재시도 범위**: `Planner.executeCycle(turn, n, retriesLeft)`의
  재시도(`retryOrFail`)는 `safeJsonParse` 또는 `validatePlan` 실패(Either.Left)에만 발동된다.
  LLM 타임아웃·네트워크 오류는 `askLLM` Free Op가 예외를 throw하므로
  `runFreeWithStateT` 실행 스택에서 catch되어 `Executor.recover`로 이어진다.
  Planner 재시도가 아니다.

- I9. **ASK_LLM 종결 플랜 거부**: `validatePlan`은 `plan.steps`의 마지막 요소가
  `ASK_LLM`이고 `RESPOND`가 steps에 없으면 `Either.Left`를 반환한다.
  ASK_LLM 출력은 유저에게 전달되지 않으므로 RESPOND 없이 ASK_LLM으로 끝나는 플랜은
  결과 폐기 + 재계획 cascade를 유발한다.
  EXEC로 끝나는 플랜(RESPOND 없음)은 수렴 루프로 허용된다.

- I10. **`direct_response` 메시지 비어있지 않음**: `validatePlan`은 `direct_response` 타입에서
  `message`가 `string`이 아니거나 `trim()` 후 빈 문자열이면 `Either.Left`를 반환한다.
  빈 응답이 유저에게 전달되는 것을 방지한다.

## 경계 조건 (Edge Cases)

- E1. **턴 중 `/clear` 실행**: `clearDebugState`가 `_compactionEpoch`를 증가시키면
  `applyFinalState`의 epoch 가드가 발동되어 해당 턴의 `conversationHistory`는
  ReactiveState에 커밋되지 않는다.
  turnState·lastTurn 등 다른 MANAGED_PATHS는 정상 커밋된다.

- E2. **미정의 Plan Op 코드**: `validatePlan`이 `ops` 테이블에 없는 op 코드를 거부한다.
  `retryOrFail`이 호출되고, `retriesLeft`가 소진되면
  `lifecycle.respondAndFail`로 에러 메시지를 내보내고 턴이 종료된다.

- E3. **`runFreeWithStateT` 중 throw**: `Executor.run`의 try-catch가 잡아
  `recover(input, err)`를 실행한 뒤 예외를 재전파한다.
  이 경우 `afterTurn`은 실행되지 않으므로 memory save·persist는 recover 내부의
  `persist()` 한 번만 발생한다.

- E4. **`afterTurn` 내 memory save 실패**: `postTurnMemory`는 `fireAndForget`으로 분리된다.
  Task 실패는 경고 로그가 없이 무시된다(fire-and-forget 계약).
  turnState·conversationHistory 커밋은 이미 완료된 상태다.

- E5. **`RESPOND`가 마지막 스텝이 아닌 플랜**: `validatePlan`이
  `RESPOND`가 steps 배열 마지막이 아님을 감지하면 `Either.Left`로 거부한다.
  재시도 카운트에 합산된다.

- E6. **`$N` 프롬프트 참조 미구현**: `PLAN_RULES`의 이전 Rule 6에 `$N` 문자열로
  이전 스텝 결과를 참조하라는 가이드가 있었으나, 실제로 `$N` 치환 기능은 구현되지 않았다.
  LLM이 이 syntax를 사용하면 리터럴 `$1`/`$2` 문자가 그대로 전달된다.
  해당 규칙은 삭제되고 "ASK_LLM 마지막이면 RESPOND 필수" 가이드로 교체되었다 (2026-04-16).
  정상 참조 메커니즘: ASK_LLM의 `ctx` 배열, RESPOND의 `ref` 필드.

- E7. **Retry 탈출 `direct_response`**: 반복된 plan parse 실패 후 LLM이
  `direct_response`로 전환하여 포기성 응답을 내보내는 패턴이 관찰된다.
  이 응답은 `validatePlan`을 통과하고 `lifecycle.success`로 기록된다.
  내용의 품질(이전 step 결과 참조 여부 등)은 검증하지 않는다 — LLM 출력의 의미적 품질은
  현재 아키텍처의 관심 범위 밖이다.

## Known Gap

### ~~KG-10: retry 시 `DebugRecorder.record()`에 동일 iteration index 전달~~ (RESOLVED 2026-04-12)

**해소 내용**:
- `DebugRecorder.record(turn, n, prompt, rawResponse, parsed, retryAttempt = 0)` — `retryAttempt` 파라미터 추가 (기본값 0)
- `retryOrFail()`에서 `retryAttempt = this.maxRetries - retriesLeft + 1`을 계산하여 전달
- `iterEntry`에 `retryAttempt` 필드 포함 — 동일 `n`의 retry 항목이 `retryAttempt`로 구분됨
- `iterations.js` 렌더러: key에 `retryAttempt` 포함하여 React key 중복 방지, 헤더에 `(retry N)` 태그 표시

### ~~KG-12: Plan EXEC 가 검증되지 않은 URL 을 tool_args 로 생성~~ (RESOLVED 2026-04-16)

**관련 FP**: FP-59 (`docs/ux/tui-chat-transcript.md`)
**심각도**: medium

**관찰**

2026-04-15 debug report 에서 plan 타입 응답이 다음 EXEC 스텝을 생성했다.

- `web_fetch` 에 `url: "https://www.visitbusan.net/ko/guide/detail?gId=10234"` (존재 여부 미확인)
- `web_fetch` 에 `url: "https://www.tripadvisor.com/Attraction_Review-g293851-d470615-Reviews-Gwangalli_Beach-Busan_Gyeongsangnamdo_Province_of_South_Korea.html"` (존재 여부 미확인)

두 URL 모두 사용자 입력("바다가 보였으면 좋겠어요") 이나 recalled memories (광안리 카페 관심) 에 grounded 되지 않은 값이다. 대화 히스토리에도 등장하지 않는다. planner LLM 이 관광지 URL 의 "그럴듯한" 패턴으로 생성한 것으로 보인다.

**왜 gap 인가**

`Plan.steps[i].args.tool_args` 는 free-text JSON object 다. planner 는 임의의 문자열을 여기 넣을 수 있고, `plan.js` parser 는 스키마 검증 외에는 값 자체를 건드리지 않는다. 즉 이 필드는 Op ADT 가 약속하는 finite 선택 공간 밖이며, CLAUDE.md 설계 철학이 경고하는 "환각 침투 경로" 에 정확히 해당한다.

현재 불변식 (I1~I_n) 과 경계 조건 어디에도 tool_args 값에 대한 grounding 요구 또는 검증 의무가 명시되어 있지 않다.

**영향**

- web_fetch: 존재하지 않는 URL 호출 → 네트워크 왕복 + 시간 낭비. 설령 응답이 와도 사용자 의도와 무관한 페이지 내용이 다음 AskLLM 에 컨텍스트로 주입 → 환각 증폭.
- 일반화: 파일 경로, 쿼리 스트링, 토큰, ID 등 tool_args 의 모든 자유 텍스트 필드가 같은 취약점을 공유한다. 현재로서는 tool 종류/필드별로 환각 위험도가 다른데도 처리가 통일되어 있다.

**수정 방향 후보**

세 가지 방어선 (하나 이상 조합):

1. **Host whitelist (policies.js)**: web_fetch 허용 호스트 목록을 두고, 목록 외 URL 은 approval 요청으로 돌림. 구현 비용 낮음, planner 환각을 실행 경계에서 차단.
2. **Grounded reference 강제**: planner 프롬프트에 "URL 은 이전 turn 컨텍스트 (검색 결과, 메모리) 에 등장한 것만 사용" 명시. plan.js parser 가 tool_args 의 URL 을 `context` 레퍼런스 검색으로 검증. 이상적이나 프롬프트 설계 + parser 로직 확장 필요.
3. **Pre-execution approval default**: 모든 web_fetch (또는 tool_args 에 URL 이 포함된 모든 tool) 를 default 로 approval 요청으로 돌리고 유저 승인 후 실행. 유저 마찰 큼, back-up.

우선순위: 1 > 2 > 3.

**스펙 반영**

해소 시 새 불변식 (가칭 I_k) 으로 "plan.steps[i].args.tool_args 의 URL 필드는 { host whitelist ∨ grounded reference } 중 하나를 만족해야 한다" 를 추가 후보. 범위가 web_fetch 를 넘어서면 invariant 문구는 tool 카테고리별로 세분화될 수 있음.

**완화 조치 (2026-04-16, FP-59 해소)**

프롬프트 가이드 + 도구 설명 강화로 빈도를 낮추었으나 구조적 gap 은 여전히 open.

- `PLAN_RULES` Rule 10: "URL 환각 금지 — 대화·메모리·이전 스텝 결과에 등장한 URL 만 사용"
- `PLAN_RULES` Rule 11: "web_fetch 는 검색 엔진이 아님 — SERP URL 사용 금지"
- `web_fetch` 도구 설명에 "NOT a search engine — only use with URLs from conversation context or step results" 추가

이 조치는 프롬프트 준수에 의존하므로 LLM 모델/크기에 따라 효과가 달라진다. host whitelist (수정 방향 1) 또는 parser-level grounded reference 검증 (수정 방향 2) 이 구현되기 전까지 KG-12 는 open 으로 유지한다.

**해소 (2026-04-16)**

완화 조치 (프롬프트 가이드) 에 더해 구조적 차단을 추가하여 해소.

- `policies.js` `WEB_FETCH.BLOCKED_SERP_PATTERNS`: google, bing, yahoo, duckduckgo, yandex, baidu SERP URL 정규식 6개
- `validate.js` `isSerpUrl` + `validateExecArgs`: web_fetch tool_args.url 이 SERP 패턴에 매치하면 `Either.Left` → `retryOrFail` 경로로 진입. 에러 메시지: "search engine result pages cannot be fetched"
- `agent.test.js`: google SERP → Left, bing SERP → Left, normal URL → Right, google non-SERP (/maps) → Right 4건

프롬프트 가이드 (Rule 10/11) 와 구조적 차단 (SERP 정규식) 의 이중 방어. 임의 호스트 환각은 프롬프트 준수에 의존하지만, SERP URL (debug report 에서 가장 빈번한 패턴) 은 확정 차단된다.

**잔여 gap**: 임의 호스트의 환각 URL (예: visitbusan.net/ko/guide/detail?gId=10234) 은 프롬프트 가이드에만 의존. host whitelist 또는 grounded reference 검증은 향후 과제로 남지만, SERP 차단이 debug report 에서 관측된 가장 빈번한 패턴을 커버하므로 KG-12 를 resolved 로 전환한다.

**추가 사례 (2026-04-15 두 번째 report)**

같은 날 다른 debug report 에서는 plan 이 `web_fetch` 에 `https://www.google.com/search?q=busan+cafe+tour+...` 같은 Google SERP URL 을 두 건 꽂았다. 호스트는 실재하지만 용도가 틀렸다 — SERP 는 대부분 스크래핑이 막히며, planner LLM 이 "web_fetch 에 검색 URL 을 넣으면 검색이 된다" 고 환각한 것으로 보인다.

또한 같은 plan 의 `ASK_LLM` 스텝 prompt 에 `"$1과 $2 결과를 바탕으로..."` 라는 리터럴 placeholder 가 있었다. 실제로는 `$1`/`$2` 템플릿 치환 기능이 없으며 (정상 syntax 는 `ctx: [1, 2]` 배열), 내부 LLM 은 `$1`/`$2` 를 문자 그대로 받는다. 즉 **환각의 침투 경로는 `tool_args` 에 국한되지 않고** `args.prompt` 의 자유 텍스트에서도 동일하게 발생한다. planner LLM 이 학습 분포에서 자주 보던 템플릿 문법을 투사한 결과다.

**일반화**: `Plan.steps[i].args` 의 모든 자유 텍스트 필드는 finite 선택 공간 밖이며 환각에 취약하다. 현재 KG-12 의 수정 방향 (host whitelist, grounded reference, approval) 은 URL 필드에 집중되어 있지만, 같은 원칙이 prompt 텍스트, 파일 경로, 쿼리 스트링, 식별자 전반에 적용되어야 한다. 특히 planner 프롬프트에 "지원되지 않는 템플릿 syntax (`$N`, `{{var}}` 등) 를 사용하지 말고, 다른 스텝 결과를 참조하려면 반드시 전용 필드 (`ref`, `ctx`) 를 사용하라" 를 명시할 가치가 있다.

### ~~KG-13: Plan 의 마지막 스텝이 ASK_LLM 일 때 RESPOND 생략이 허용되어 결과가 폐기됨~~ (RESOLVED 2026-04-16)

**해소 내용**:
- `validatePlan`에 I9 검증 추가: 마지막 스텝이 ASK_LLM이고 RESPOND 없으면 `Either.Left` 반환 → `retryOrFail` 경로로 진입
- `PLAN_RULES` Rule 6 교체: `$N` 참조 → "ASK_LLM 마지막이면 RESPOND 필수" 가이드
- `ROLE_DEFINITION` 예제 추가: ASK_LLM + RESPOND 패턴 (web_fetch → ASK_LLM → RESPOND)
- `agent.test.js` 3건 검증 추가 (ASK_LLM last → Left, ASK_LLM+RESPOND → Right, EXEC last → Right)

**관련 FP**: FP-60 (`docs/ux/tui-chat-transcript.md`)
**심각도**: medium

**관찰**

2026-04-15 debug report 에서 Iteration 1 plan 이 다음 구조였다.

```json
{ "type": "plan", "steps": [
  { "op": "EXEC", "args": { "tool": "web_fetch" } },
  { "op": "EXEC", "args": { "tool": "web_fetch" } },
  { "op": "ASK_LLM", "args": { "prompt": "$1과 $2 결과를 바탕으로 ..." } }
] }
```

`RESPOND` 스텝이 없다. `validatePlan` 은 이를 거부하지 않고 통과시키며 (E5 는 "RESPOND 가 마지막이 아닌 경우" 만 검사), `planner.js:135-146` 의 `executePlan` 은 `hasRespond === false` 경로로 `planCycle(turn + previousResults, n+1)` 을 재귀 호출한다 (수렴 루프 철학).

그 결과:
- Op 11 의 inner ASK_LLM (26.9s) 출력이 `summarizeResults` 로 직렬화되어 다음 iteration planner 프롬프트의 "Step results:" 블록에만 재주입됨.
- planner 는 step results 를 본 뒤 direct_response 를 시도, 1971 chars 에서 절단 (FP-52 병리) → retry 2 회 → 616 chars 변명 응답으로 복구.
- 총 66.2s, 최종 응답은 recalled memories 기반 일반 상식 수준.

**왜 gap 인가**

planner.md 불변식과 경계 조건 어디에도 "plan 은 RESPOND 로 끝나야 한다" 또는 "RESPOND 누락 시 처리 규약" 이 명시되어 있지 않다. 현재 구현은 "RESPOND 없으면 재계획" 을 의도된 수렴 루프로 다루지만, 이것은 암묵적 규약이며 다음 케이스를 구분하지 못한다:

1. **추가 조사가 더 필요해서 의도적으로 RESPOND 생략** (수렴 루프가 정당한 경우)
2. **planner LLM 이 "마지막 ASK_LLM = 응답 합성" 으로 혼동해 RESPOND 를 잊은 경우** (결과 폐기 + 재계획 = 낭비)

두 케이스가 구조적으로 구분 불가능하므로 LLM 실수가 수렴 루프로 숨는다.

또한 E5 ("RESPOND 마지막 위치") 는 RESPOND 존재 시의 위치만 검사한다. "마지막 ASK_LLM + RESPOND 생략" 패턴이 의도된 수렴 루프라고 해도, 적어도 스펙에는 명시되어야 한다.

**영향**

- 긴 대기 후 결과 폐기 → 재요청 cascade. 실측 66.2s 중 유저 의미 있는 출력은 최종 616 chars 뿐.
- FP-52 truncation cascade 와 결합하면 낭비가 배가된다: RESPOND 누락 → 다음 iteration 에서 direct_response 로 긴 문장 시도 → 절단 → retry.
- 수렴 루프의 정당한 케이스 (추가 조사 필요) 와 LLM 실수를 구분할 수 없어 디버깅이 어렵다.

**수정 방향 후보**

1. **불변식 추가**: "plan 의 steps 가 비어 있지 않으면 마지막 스텝은 RESPOND 여야 한다" 를 I9 (가칭) 로 추가. `validatePlan` 이 거부 → `retryOrFail` 경로로. 수렴 루프가 필요하면 별도 메커니즘 (명시적 `continue: true` 필드 등) 으로 opt-in.
   - 장점: 확실하고 관찰 가능. 단점: 현재 수렴 루프 설계 변경.
2. **Implicit RESPOND wrap**: `parsePlan` 이 마지막 스텝이 ASK_LLM 이면 `RESPOND { ref: <lastIdx> }` 를 자동 추가. 수렴이 필요한 케이스 (마지막이 EXEC 인 경우) 는 현행 유지.
   - 장점: 기존 플랜 대부분 커버. 단점: planner LLM 실수를 덮어버려 구조적 결함이 숨겨짐.
3. **Planner 프롬프트 강화 + few-shot**: system prompt 에 "plan 은 RESPOND 로 끝나야 한다. RESPOND.ref 로 앞 스텝 결과를 참조한다. 추가 조사가 필요하면 planner 가 응답에 그 취지를 담고 수동으로 다음 턴을 기다려라" 를 명시. 실행 의미론은 바꾸지 않고 LLM 지도만.
   - 장점: 비용 낮음. 단점: 준수 여부 비결정적.

우선순위: 1 > 3 > 2. 1 은 스펙을 명확하게 하고, 3 은 단기 완화책, 2 는 마법적이라 권장하지 않음.

**스펙 반영**

해소 시 가칭 I9 신규 불변식 "plan.steps 가 비어있지 않으면 마지막 요소의 op 는 RESPOND" 를 I 섹션에 추가. 반대로 수렴 루프를 유지하기로 결정하면 "plan 에 RESPOND 가 없으면 수렴 루프로 재진입한다" 를 명시적 E 항목 (E6) 으로 기술해 암묵적 규약을 스펙화.

## 테스트 커버리지

- I1, I2, I3 → `packages/core/test/core/plan.test.js`
- I4 → `packages/core/test/core/agent.test.js`, `packages/core/test/core/free-integration.test.js`
- I5 → `packages/core/test/core/agent.test.js` ("Executor.recover() 단위 테스트" 블록, 8 assertion — STREAMING/LAST_TURN/TURN_STATE 경로 set 및 persist 검증)
- I6 → `packages/core/test/core/apply-final-state.test.js`, `packages/core/test/core/turn-concurrency.test.js`
- I7 → `packages/core/test/core/agent.test.js`
- I8 → `packages/core/test/core/plan.test.js`, `packages/core/test/core/agent.test.js`
- I9 → `packages/core/test/core/agent.test.js` (T6 블록, 3 assertion)
- I10 → `packages/core/test/core/agent.test.js` (T6 블록, 2 assertion)
- KG-12 → `packages/core/test/core/agent.test.js` (T6b 블록, 4 assertion)
- E1 → `packages/core/test/core/turn-concurrency.test.js`, `packages/core/test/core/apply-final-state.test.js`
- E2, E5 → `packages/core/test/core/plan.test.js`
- E3 → `packages/core/test/core/agent.test.js` (미커버 가능성 있음) ⚠️
- E4 → (미커버) ⚠️

## 관련 코드

- `packages/core/src/core/op.js` — Free Op ADT 정의
- `packages/core/src/core/op-handler.js` — Plan Op 테이블, Op 클래스 계층
- `packages/core/src/core/validate.js` — `safeJsonParse`, `validatePlan`, `validateStep`
- `packages/core/src/core/planner.js` — `Planner`, `TurnLifecycle`, `DebugRecorder`
- `packages/core/src/core/executor.js` — `Executor` (의존성 계약, 생명주기 조율, recover)
- `packages/core/src/core/state-commit.js` — `applyFinalState`, `clearDebugState`, `MANAGED_PATHS`

## 변경 이력

- 2026-04-10: 초기 작성 — Plan/Free 계층 분리, Executor 계약, epoch 경합 방어 기술
- 2026-04-10: I5 테스트 커버리지 갱신 — agent.test.js에 Executor.recover() 단위 테스트 블록(8 assertion) 추가됨을 반영.
- 2026-04-12: KG-10 추가 — retryOrFail의 iterationHistory 중복 index 갭 등록
- 2026-04-12: KG-10 해소 — DebugRecorder.record()에 retryAttempt 파라미터 추가, iterations.js 렌더러 key/태그 갱신
- 2026-04-16: KG-12 추가 — plan.steps[i].args.tool_args 가 finite 선택 공간 바깥이라 planner LLM 환각 침투. debug report (2026-04-15) 에서 grounded 되지 않은 URL 2건 관측.
- 2026-04-16: KG-13 추가 + KG-12 사례 확장 — 두 번째 debug report 분석. KG-13: plan 의 마지막 스텝이 ASK_LLM 인데 RESPOND 누락 시 결과가 폐기되고 수렴 루프로 재진입 (의도 vs 실수 구분 불가). KG-12: google SERP URL 환각 + `$1`/`$2` placeholder 환각 사례 추가 — hallucination 침투 경로가 URL 뿐 아니라 모든 자유 텍스트 필드에 해당함을 명시.
- 2026-04-16: KG-13 해소 + I9/E6 추가 — validatePlan ASK_LLM 종결 플랜 거부, PLAN_RULES $N 미구현 규칙 교체
- 2026-04-16: KG-12 완화 조치 — PLAN_RULES Rule 10/11 (URL 환각 금지 + web_fetch 검색 엔진 아님) + web_fetch 도구 설명 강화. FP-59 resolved. 구조적 gap 은 open 유지.
- 2026-04-16: KG-12 해소 — SERP URL 구조적 차단 (policies.js 정규식 + validate.js isSerpUrl). 프롬프트 완화 + 구조 차단 이중 방어.
- 2026-04-16: I10/E7 추가 — direct_response 빈 메시지 차단 + retry 탈출 direct_response 경계 조건 기술
