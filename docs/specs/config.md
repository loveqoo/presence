# 설정 시스템 정책

## 목적

presence의 설정 머지 우선순위, 런타임 확정 규칙, 유저 override 경계를 정의한다. 서버가 시작된 이후 설정은 디스크를 재읽지 않으며, 런타임에 확정된 설정을 기준으로 유저 설정을 머지한다.

## 설정 레이어 우선순위 (낮은 → 높은)

```
Config.DEFAULTS
  → ~/.presence/server.json
    → ~/.presence/users/{username}/config.json
```

나중 레이어가 이전 레이어를 override한다. 2단계 deep merge (`Config.SG` Semigroup).

## 불변식 (Invariants)

- I1. **DEFAULTS는 항상 베이스**: 설정 파일이 없거나 파싱 오류가 발생해도 `Config.DEFAULTS`가 최종 fallback. 서버는 최소한 기본값으로 실행된다.
- I2. **런타임 서버 config가 유저 merge 기반**: `UserContextManager.getOrCreate()`에서 유저 config 머지 시, 디스크 `server.json`을 재읽지 않고 이미 확정된 `serverConfig`를 base로 사용. `Config.mergeUserOver(serverConfig, username)` 사용.
- I3. **유저 config는 서버 config를 override**: 유저별 `config.json`의 값이 서버 전역 설정보다 우선. 단, 머지 후 `Config.Schema.safeParse`로 검증.
- I4. **스키마 검증 non-fatal**: `Config.Schema.safeParse` 실패 시 console.warn 후 미검증 config 그대로 반환. 서버 시작 중단 없음.
- I5. **apiKey 누락 경고**: `config.llm.apiKey`가 null이면 `Config.validate()`가 경고를 반환한다. 서버는 실행되나 LLM 호출은 실패한다.
- I6. **설정 파일은 JSON 형식**: `.presence/server.json`, `.presence/users/{username}/config.json` 모두 JSON. 파싱 오류 시 `console.warn` + `Maybe.Nothing()` 반환 (해당 레이어 무시).
- I7. **Reader 기반 설정 로드**: `loadServerR`, `loadUserR`, `loadUserMergedR`, `mergeUserOverR`는 Reader 모나드이며 `packages/infra/src/infra/config-loader.js`에 정의된다. `Config` 클래스에는 없다. 직접 호출은 동일 파일의 브릿지 함수(`loadServer()`, `loadUserMerged()`, `mergeUserOver()`)를 통해서만. `loadUser()` 브릿지는 존재하지 않는다 — `loadUserR.run(deps)` 직접 호출 필요.
- I8. **apiKey는 config/get 응답에서 제거**: `GET /sessions/:id/config` 응답에서 `llm.apiKey`를 제거하여 노출하지 않는다.
- I9. **presenceDir 기본 경로**: `PRESENCE_DIR` 환경변수가 설정되면 그 값을 그대로 사용. 미설정 시 `HOME`(또는 `USERPROFILE`, 없으면 `.`) 기반으로 `~/.presence/`를 반환. 이 값이 `Config.userDataPath()`, `defaultUserDataPath()`, `defaultMemoryPath()` 등 모든 파생 경로의 루트가 된다.
- I10. **resolveDir 우선순위**: `Config.resolveDir(basePath)` — 구현은 `basePath || process.env.PRESENCE_DIR || Config.presenceDir()`. basePath가 **truthy인 경우에만** 환경변수보다 우선 적용된다. basePath가 falsy(빈 문자열 `''`, `null`, `undefined` 포함)이면 `PRESENCE_DIR` 환경변수로 폴백한다. basePath를 생략하거나 빈 문자열로 전달하는 것은 동일 동작이다.
- I11. **embed.dimensions 이중 기본값 위험**: `embed.dimensions`의 DEFAULTS 값은 256이나, `Memory.#buildMem0Config()`에서는 `embed.dimensions || 1536`을 사용한다. config에 명시되지 않으면(null이면) 1536이 실제 적용된다. embed.dimensions는 Schema에서 nullable이다.

## 설정 항목 (Config.Schema + DEFAULTS 기준)

| 항목 | 기본값 | 설명 |
|------|--------|------|
| `llm.baseUrl` | `https://api.openai.com/v1` | LLM API 엔드포인트 |
| `llm.model` | `gpt-4o` | LLM 모델 |
| `llm.apiKey` | null | LLM API 키 |
| `llm.responseFormat` | `json_schema` | 계획 응답 형식 |
| `llm.maxRetries` | 2 | LLM 재시도 횟수 |
| `llm.timeoutMs` | 120,000 | LLM 타임아웃 (ms) |
| `embed.provider` | `openai` | 임베딩 제공자 |
| `embed.baseUrl` | null | 임베딩 API 엔드포인트 override |
| `embed.apiKey` | null | 임베딩 API 키 (없으면 llm.apiKey 폴백) |
| `embed.model` | null | 임베딩 모델 (null이면 memory.js 내부 기본값 사용) |
| `embed.dimensions` | 256 | 설정 스키마 기본값. Memory 내부에서 1536 사용 가능 (불일치 주의) |
| `locale` | `ko` | i18n 언어 |
| `maxIterations` | 10 | 최대 에이전트 이터레이션 |
| `memory.path` | null | mem0 저장 경로 (null이면 `~/.presence/memory/`) |
| `mcp` | `[]` | MCP 서버 목록 |
| `scheduler.enabled` | true | 스케줄러 활성화 여부 |
| `scheduler.pollIntervalMs` | 60,000 | 스케줄러 폴링 간격 (ms) |
| `scheduler.todoReview.enabled` | true | TODO 리뷰 잡 활성화 |
| `scheduler.todoReview.cron` | `0 9 * * *` | TODO 리뷰 cron |
| `delegatePolling.intervalMs` | 10,000 | 위임 폴링 간격 (ms) |
| `agents` | `[]` | 에이전트 정의 목록. 각 entry: `{ name, description, capabilities, persona, createdAt, createdBy, archived, archivedAt? }`. 상세 schema는 `docs/specs/agent-identity.md` I1/I5 참조. |
| `primaryAgentId` | (없음, user config 전용) | 유저의 기본 agentId (`{username}/{agentName}`). M3 구현 완료 전까지 `{username}/default` hardcode (KG-16). |
| `a2a.enabled` | `false` | A2A 기능 활성화 플래그. false이면 `/a2a/*` 미등록. |
| `a2a.publicUrl` | `null` | `a2a.enabled=true` 시 필수. Self agent card URL 생성에 사용. |
| `a2a.recoverOnStart` | `true` | 서버 시작 시 A2A 큐 재시작 회복 활성화 여부. `false`이면 `recoverA2aQueue` skip — 첫 배포/운영 rollback 경로. `UserContextManager.getOrCreate()` 및 `server/index.js` 두 부트 경로 모두에서 읽힌다. |
| `prompt.maxContextTokens` | 8,000 | 컨텍스트 최대 토큰 |
| `prompt.reservedOutputTokens` | 1,000 | 출력 예약 토큰 |
| `prompt.maxContextChars` | null | 대안: 문자 수 기반 컨텍스트 예산 |
| `prompt.reservedOutputChars` | null | 대안: 문자 수 기반 출력 예약 |

## 경계 조건 (Edge Cases)

- E1. `server.json` 없음 → `Config.DEFAULTS`만 사용. 경고 없음.
- E2. `users/{username}/config.json` 없음 → 서버 config만 사용 (유저 override 없음).
- E3. 두 파일 모두 없음 → `Config.DEFAULTS` 사용.
- E4. JSON 파싱 오류 → 해당 레이어 무시 + console.warn. 나머지 레이어 머지 계속.
- E5. `Config.Schema` 검증 실패(예: 필수 숫자 항목에 문자열) → console.warn 후 미검증 객체 반환.
- E6. `embed.apiKey` 없음 + provider가 `openai`가 아님 + `embed.baseUrl`도 없음 → `embedApiKey`가 null로 결정되어 `buildEmbedder()` null 반환 + `Memory.create()` null 반환. 임베딩/메모리 비활성. provider가 `openai`이면 `llm.apiKey`로 폴백하여 비활성화되지 않는다. (`memory.md I3` 참조)
- E7. `PRESENCE_DIR` 환경변수 설정 시 → 모든 경로 계산에서 `~/.presence/` 대신 해당 경로 사용.
- E8. 유저 config에 `llm.model`만 설정 → 서버 config의 나머지 llm 항목과 머지 (2단계 deep merge).
- E9. `username`이 `null`인 상태에서 `Config.loadUserMerged()` 호출 → 즉시 에러 throw (`username is required`).
- E10. `embed.dimensions`가 null인 채로 Memory.create() 호출 → `Memory.#buildMem0Config`에서 `embed.dimensions || 1536` 평가 → 1536이 실제 dim으로 사용. 설정값 256과 다름.
- E11. `basePath`를 인자로 `Config.resolveDir(basePath)`를 호출하면 `PRESENCE_DIR` 환경변수보다 basePath가 우선 적용된다. 환경변수를 사용하고 싶을 때 basePath를 빈 문자열로 넘기지 말 것.

## 테스트 커버리지

- I1 → `packages/infra/test/config.test.js` (DEFAULTS fallback)
- I2 → `packages/server/test/server.test.js` (UserContextManager mergeUserOver)
- I3 → `packages/infra/test/config.test.js` (유저 레이어 override 검증)
- I4 → `packages/infra/test/config.test.js` (schema 검증 non-fatal)
- I8 → `packages/server/test/server.test.js` (apiKey 미노출)
- E6 → `packages/infra/test/config.test.js` (embed 자격증명 없음 → null)
- E8 → `packages/infra/test/config.test.js` (partial override 머지)
- E9 → `packages/infra/test/config.test.js` (username 없는 loadUserMerged 에러)

## 관련 코드

- `packages/infra/src/infra/config.js` — Config 클래스 (Schema, SG, DEFAULTS, Reader 메서드)
- `packages/server/src/server/index.js` — `Config.loadServer()` 부트스트랩
- `packages/server/src/server/user-context-manager.js` — `Config.mergeUserOver()` 유저별 머지
- `packages/infra/src/infra/user-context.js` — `Config.loadUserMerged()` (인증 비활성 시)
- `packages/server/src/server/session-api.js` — `GET /config` apiKey 제거

## 변경 이력

- 2026-04-10: 초기 작성
- 2026-04-22: agents 항목 확장 — entry schema 요약 + primaryAgentId/a2a.enabled/a2a.publicUrl 추가 (agent identity 도입 반영). KG-16 참조 추가.
- 2026-04-25: a2a.recoverOnStart 항목 추가 — A2A Phase 1 S4 구현 반영. 서버 시작 시 큐 재시작 회복 feature flag (기본 true).
- 2026-04-10: 실제 코드 기반 설정 항목 전체 갱신 — embed/locale/scheduler/delegatePolling/agents/memory/prompt 추가, I10(resolveDir 우선순위), I11(embed.dimensions 이중 기본값 위험), E10/E11 추가
- 2026-04-10: I10 falsy 폴백 명시 — basePath가 빈 문자열 포함 falsy이면 PRESENCE_DIR로 폴백하는 || 체인 동작 기술
- 2026-04-10: I9 구현 일치 확인 — Config.presenceDir()이 PRESENCE_DIR 환경변수를 직접 반영하도록 수정됨, I9 서술을 구현과 일치하도록 정교화.
- 2026-04-10: I7 브릿지 목록 보충 — Config.mergeUserOver() 추가. config.js:220 기준 실제 존재하는 브릿지 3종 전체 명시.
- 2026-04-10: I7 Config.loadUser() 추가 — config.js:218 브릿지 4종 전체 반영 (loadServer/loadUser/loadUserMerged/mergeUserOver). 이전 기술에서 loadUser 누락.
- 2026-04-10: E6 폴백 로직 정정 — embed.provider === 'openai'이면 llm.apiKey 폴백 경로 명시. 단순 "embed.apiKey 없으면 null" 기술에서 폴백 후 null 조건으로 수정. memory.md I3과 일관성 유지.
