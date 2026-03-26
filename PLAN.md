# Presence — 구현 플랜 v2

개인 업무 대리 에이전트 플랫폼. Free Monad 기반 FP 아키텍처.

> 설계 문서: [docs/architecture.md](docs/architecture.md)
> 완료 이력: [docs/completed.md](docs/completed.md)

## 미착수 Phase

### Phase 8: 계층적 에이전트

| Step | 내용 | 선행 조사 |
|------|------|----------|
| **43** | 계층적 에이전트 (Supervisor 패턴) | Google ADK 아키텍처 조사 |

## TODO

- ~~**메모리 임베딩 관심사 분리**~~ → [완료 기록](docs/completed.md#메모리-임베딩-관심사-분리)

- ~~**메모리 검색 인덱스**~~ → [완료 기록](docs/completed.md#메모리-검색-인덱스)

- ~~**메모리 무효화**~~ → [완료 기록](docs/completed.md#메모리-무효화)

- ~~**프로퍼티 기반 테스트**~~ → [완료 기록](docs/completed.md#프로퍼티-기반-테스트)

- ~~**embedPending 병렬화**~~ → [완료 기록](docs/completed.md#embeddingpending-병렬화)

- ~~**테스트 유틸 라이브러리화**~~ → [완료 기록](docs/completed.md#테스트-유틸-라이브러리화)

- ~~**경계 스키마 검증 (Zod 활용)**~~ → [완료 기록](docs/completed.md#경계-스키마-검증-zod-활용)

- ~~**프롬프트를 데이터로**~~ → [완료 기록](docs/completed.md#프롬프트를-데이터로)

- ~~**MCP 툴 지연 로딩 (lazy tool selection)**~~ → [완료 기록](docs/completed.md#mcp-툴-지연-로딩)

- ~~**`/clear` 후 budget 미갱신 버그**~~ → [완료 기록](docs/completed.md#clear-후-budget-미갱신-버그)

- ~~**report 중간 이터레이션 누락**~~ → [완료 기록](docs/completed.md#report-중간-이터레이션-누락)

- ~~**validateExecArgs 툴 존재 검증**~~ → [완료 기록](docs/completed.md#validateexecargs-툴-존재-검증)

- ~~**persistence restore() 구조 검증**~~ → [완료 기록](docs/completed.md#persistence-restore-구조-검증)

- ~~**`_debug.*` 상태 상한 설정**~~ → [완료 기록](docs/completed.md#debug-상태-상한-설정)

- ~~**Actor 에러 로깅 폴백**~~ → [완료 기록](docs/completed.md#actor-에러-로깅-폴백)

- ~~**mergeSearchResults 단일 패스**~~ → [완료 기록](docs/completed.md#mergesearchresults-단일-패스)

- ~~**MemoryActor 동시성 안전**~~ → [완료 기록](docs/completed.md#memoryactor-동시성-안전)

- ~~**SQLite 기반 메모리 저장소 (mem0 SDK)**~~ → [완료 기록](docs/completed.md#mem0-sdk-통합)


## 운영 결정

| 결정 | 내용 | 이유 |
|------|------|------|
| history source 필터링 | `conversationHistory`는 `source === 'user'` 성공 턴만 저장 | heartbeat/event 턴이 대화 맥락을 오염시키지 않도록 |
| prompt assembly budget | budget 기반 단계적 fitting (system → history → memories) | 고정 크기 컨텍스트 안에서 최신 대화를 우선 보존 |
| embedder null 처리 | embedder 없으면 memory recall 빈 배열 반환 | 키워드 단독 검색은 noise가 많아 오히려 해로움 |
| history rolling window | 상한 20턴 + budget fitting으로 추가 축소 | LLM 컨텍스트 효율성, 오래된 대화는 가치 감소 |

### FP 라이브러리 활용 판단

| 항목 | 판단 | 이유 |
|------|------|------|
| `Either.catch()` (config.js) | **적용** | agent.js `safeJsonParse`와 일관된 패턴 |
| prompt.js `pipe()` | 보류 | 안정화 단계에서 불필요한 변경 |
| state.js `Maybe` 체인 | 유지 | hot path, 성능 우선 |
| `Writer` monad (tracing) | 보류 | fun-fp-js WriterT 필요 |
| `Reader` monad (DI) | 유지 | 현재 클로저 기반이 더 직관적 |

## 핵심 제약

- **조사 먼저**: "선행 조사" 칼럼이 비어있지 않으면, 구현 전에 해당 스펙/논문을 확인
- **Op 이름은 직관적으로**: `askLLM`, `executeTool`, `updateState` — 설명 불필요
- **Free Monad는 인프라**: 프로그램 형태는 바뀔 수 있지만 Free + Interpreter는 유지
- **State 변경은 Op으로**: 명령형 mutation 금지. 프로그램에서 선언, 인터프리터에서 반영
- **부수 효과는 Hook으로**: 로깅, 영속화, 알림 등은 프로그램이 아닌 Hook에서 처리

## 검증 방법

```bash
node test/run.js                    # 전체 테스트 (mock 기반, LLM 불필요)
node test/manual/live-llm.test.js   # 실제 LLM 테스트 (로컬 MLX 서버 필요)
node src/main.js                    # 앱 실행
```
