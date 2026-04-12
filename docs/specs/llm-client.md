# LLM 클라이언트 정책

## 목적

`LLMClient`와 프롬프트 조립(`assembly.js`) 사이의 계약을 정의한다.
프롬프트 예산(`budget`)이 계산되고 API 요청에 실제로 전달되기까지의 경로를 보장하며,
SSE 스트리밍 응답에서 비정상 종료를 감지하는 조건을 명시한다.

## 불변식 (Invariants)

- I1. **`max_tokens` 전달 의무**: `LLMClient.#buildBody()`는 `max_tokens` 파라미터를
  OpenAI API 요청 body에 포함해야 한다.
  `assembly.js`의 `budget.reservedOutputChars`(또는 `reservedOutputTokens`)는
  이 값의 원천이며, `EphemeralSession.resolveBudget()`이 config에서 변환한 뒤
  `Planner.budget` → `assemblePrompt(budget)` 경로로 흐른다.
  budget 계산만 이루어지고 API에 전달되지 않으면 사문화된 설정이다.

- I2. **`finish_reason` 구분**: `SseParser`는 스트리밍 응답의 `finish_reason`을
  `"stop"`(정상 종료)과 `"length"`(max_tokens 도달) 로 구분해야 한다.
  `"length"`는 응답 truncation을 의미하므로 호출자에게 알려야 한다.

- I3. **budget 상수 단일 출처**: `PROMPT.DEFAULT_RESERVED_OUTPUT_TOKENS`(현재 1000)은
  `packages/core/src/core/policies.js`에만 존재한다.
  다른 파일에 같은 값을 하드코딩하지 않는다.

## 경계 조건 (Edge Cases)

- E1. **`max_tokens` 미전달 시 truncation**: OpenAI 기본값(4096)이 적용되어
  긴 응답이 잘릴 수 있다. SSE 스트리밍에서 `"length"`가 감지되지 않으면
  잘린 JSON이 `safeJsonParse`를 통과하지 못하고 "Unterminated string" 에러가 발생한다.

- E2. **`stream: true`와 non-streaming 폴백**: `SseParser.parse()`는
  `response.body?.getReader`가 없으면 일반 JSON 응답으로 폴백한다.
  폴백 경로에서도 `finish_reason` 체크가 필요하다.

- E3. **`budget`이 `null`인 채 `assemblePrompt` 호출**: `assembly.js`는
  `budget == null`이면 `{ maxContextChars: Infinity, reservedOutputChars: 0 }`으로 대체한다.
  이 경우 `max_tokens`가 0이 되므로 API에 전달할 의미 있는 값이 없다.
  호출처(`Planner`)는 budget을 명시적으로 넘겨야 한다.

## Known Gap

### ~~KG-09: `max_tokens` 미전달 — budget 계산이 API 요청에 반영되지 않음~~ (RESOLVED 2026-04-12)

**해소 내용**:
- `assembly.js` 반환 객체에 `maxTokens` 포함 (코어: camelCase)
- `LLMClient.#buildBody()`에서 `maxTokens` → `max_tokens` 변환 후 body에 포함
- `SseParser`에서 `finish_reason: "length"` 감지, `truncated` 플래그 전파
- `llm-client.#parseChatResponse()`에서 `truncated` 반환
- `buildRetryPrompt()`에서 `maxTokens` 보존
- Op DSL 일괄 Reader 전환: `askLLMR` 등 10개 `*R` Reader 추가, 레거시 브릿지 유지
- `Planner.executeCycle`/`retryOrFail`에서 `maxTokens` 전달

## 테스트 커버리지

- I1 → 구현 완료. 전용 단위 테스트 없음 ⚠️
- I2 → `SseParser` 구현 완료 (`finish_reason: "length"` → `truncated: true`). 전용 테스트 없음 ⚠️
- I3 → `packages/core/src/core/policies.js` 상수 정의 확인 (코드 레벨)
- E1 → 구현 완료 (`truncated` 플래그로 감지 가능). truncation 발생 시나리오 테스트 없음 ⚠️
- E3 → `packages/core/test/core/assembly.test.js` — budget null 대체 동작 간접 커버

## 관련 코드

- `packages/infra/src/infra/llm/llm-client.js` — `LLMClient`, `#buildBody()`
- `packages/infra/src/infra/llm/sse-parser.js` — `SseParser`, `#parseChunk()`
- `packages/core/src/core/prompt/assembly.js` — `assemblePrompt()`, budget 처리
- `packages/infra/src/infra/sessions/ephemeral-session.js` — `resolveBudget()`, budget 조립
- `packages/core/src/core/policies.js` — `PROMPT.DEFAULT_RESERVED_OUTPUT_TOKENS`

## 변경 이력

- 2026-04-12: 초기 작성 — KG-09(max_tokens 미전달) 식별로 신규 작성
- 2026-04-12: KG-09 해소 — assembly.js maxTokens 반환, #buildBody max_tokens 전달, SseParser truncated 플래그, Reader 전환
