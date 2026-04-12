# 메모리 서브시스템 정책

## 목적

presence의 메모리 서브시스템이 멀티유저 환경에서 격리를 보장하고, 비동기 경계를 명확히 유지하며, 임베딩 자격증명이 없을 때 안전하게 비활성화됨을 보장한다.

## 현재 상태

mem0(`mem0ai/oss`) 기반으로 완전 전환 완료. 서버 레벨 단일 인스턴스, 모든 메서드에 `userId` 전달로 격리.

이전 구현(`MemoryGraph` + `createMemoryEmbedder`)은 완전히 제거됨.

## 불변식 (Invariants)

- I1. **서버 레벨 단일 인스턴스**: `Memory` 객체는 `PresenceServer.#boot()`에서 한 번 생성되어 모든 UserContext에 주입된다. 유저별로 별도 Memory 인스턴스를 생성하지 않는다.
- I2. **userId 격리**: `Memory.search()`, `Memory.add()`, `Memory.allNodes()`, `Memory.clearAll()`, `Memory.removeOlderThan()` — 모든 메서드는 반드시 `userId`를 파라미터로 받는다. userId 없이 호출하는 경로 없음.
- I2a. **search() 반환 형식과 변환**: `Memory.search(userId, input, limit)` / `MemoryActor.recall()`의 반환 형식은 `{ label: string }[]`이다. Executor는 이를 `memories.map(n => n.label)`로 변환하여 `state.context.memories`에 `string[]`로 저장한다 (`executor.js:44`). 실패 시 `[]`로 저장 (`executor.js:49`). 소비처(`planner.js`, `useAgentState.js`)는 `string[]`를 가정한다.
- I3. **임베딩 자격증명 없으면 null**: `Memory.create()`에서 `embedApiKey`는 `embed.apiKey || (embed.provider === 'openai' ? llm.apiKey : null)` 로 결정된다. provider가 `openai`이면 `llm.apiKey`로 자동 폴백. 폴백 후에도 `embedApiKey`가 null이고 `embed.baseUrl`도 null이면 `Memory.create()`는 `null`을 반환한다. `userContext.memory === null`인 경우 메모리 기능 비활성.
- I4. **MemoryActor가 비동기 경계**: 메모리 **상태 변경**(recall 결과 반영, save)은 MemoryActor를 통해서만 수행된다. Agent/Interpreter가 `Memory` 인스턴스를 직접 호출하지 않는다. **단, 읽기 전용 조회(`/memory list` 슬래시 커맨드 등)는 `Memory` 인스턴스(`memory.allNodes(userId)`)를 직접 호출할 수 있다.** I9 참조.
- I5. **recall 실패는 non-fatal**: `Memory.search()` 실패 시 MemoryActor는 빈 배열 `[]`을 반환하고 계속 진행한다. 메모리 오류가 턴 실패를 유발하지 않는다.
- I6. **save 실패는 non-fatal**: `Memory.add()` 실패 시 MemoryActor는 `SKIP` 결과를 반환하고 계속 진행한다.
- I7. **메모리 경로**: 기본값은 `Config.presenceDir()` 기반 `~/.presence/memory/`. `config.memory.path`가 설정되면 해당 경로로 override된다. vector_store: `{path}/vector_store.db`, 이력: `{path}/mem0_history.db`. `defaultMemoryPath()`는 `Config.presenceDir()`을 사용하므로 `PRESENCE_DIR` 환경변수를 반영한다.
- I7a. **메모리 인스턴스는 서버 부트에서만 생성**: `PresenceServer.#boot()`에서 `Memory.create(config)`를 호출한다. `UserContextManager.getOrCreate()`는 이 인스턴스를 주입받는다. UserContext나 Session이 직접 생성하지 않는다.
- I8. **ESM/CJS 동적 import**: `mem0ai/oss`는 `await import('mem0ai/oss')`로 동적 로드. ESM/CJS interop 문제 회피.
- I9. **슬래시 커맨드 접근**: `/memory list`에는 두 경로가 존재한다.
  - (a) **서버 측** (`session-api.js`): `session.userId` 기준으로 `memory.allNodes(userId)` 직접 호출 (MemoryActor 미경유). I4의 읽기 전용 예외에 해당. 다른 유저의 메모리에 접근할 수 없다.
  - (b) **Repl 측** (`core/repl.js` `cmdMemory()`): `this.memory.allNodes(this.userId)`로 userId를 전달한다. I2 불변식 준수. TUI `slash-commands/memory.js`도 `ctx.userId`를 받아 모든 memory 호출에 전달한다 (KG-05 해소).

## 경계 조건 (Edge Cases)

- E1. `memory === null`인 UserContext에서 MemoryActor.recall 호출 → `[]` 반환. 에러 없음.
- E2. `memory === null`인 UserContext에서 MemoryActor.save 호출 → `SKIP` 반환. 에러 없음.
- E3. mem0 초기화(`Memory.create()`) 실패 → `console.warn` + `null` 반환. 서버 시작 실패 없음.
- E4. userId가 다른 두 유저가 같은 Memory 인스턴스에 recall 요청 → mem0 내부에서 userId 기반으로 격리. 교차 노출 없음.
- E5. `/memory list` 슬래시 커맨드에서 `memory === null` → `'Memory disabled.'` 시스템 메시지 반환.
- E6. `allNodes()` 호출 시 mem0 내부 오류 → 빈 배열 `[]` 반환 (try-catch 내부 처리).
- E7. 메모리 경로가 존재하지 않을 때 → mem0이 디렉토리 자동 생성.
- E8. `removeOlderThan`으로 삭제할 노드가 없는 경우 → 0 반환, no-op.

## 테스트 커버리지

- I1, I2 → `packages/infra/test/actors.test.js` M1~M8 (MemoryActor mem0 mock 기반)
- I3 → `packages/infra/test/actors.test.js` (null memory 시나리오)
- I4 → `packages/infra/test/actors.test.js` (MemoryActor 경유만 허용)
- I5, I6 → `packages/infra/test/actors.test.js` (recall/save 실패 non-fatal)
- I9 → `packages/server/test/server.test.js` (슬래시 커맨드 memory list)
- E1, E2 → `packages/infra/test/actors.test.js` (null memory no-op)
- E5 → `packages/server/test/server.test.js` (memory disabled 메시지)
- I7 → (자동화 테스트 없음) ⚠️ 경로 설정 검증 미커버

## 관련 코드

- `packages/infra/src/infra/memory.js` — Memory 클래스 (mem0 래퍼, 서버 레벨)
- `packages/infra/src/infra/actors/memory-actor.js` — MemoryActor (비동기 경계, recall/save)
- `packages/infra/src/infra/sessions/internal/session-actors.js` — SessionActors (MemoryActor 생성, userId 주입)
- `packages/server/src/server/index.js` — Memory.create, UserContext 주입
- `packages/server/src/server/user-context-manager.js` — 유저별 UserContext에 Memory 공유 주입
- `packages/server/src/server/session-api.js` — `/memory list` 슬래시 커맨드

## 변경 이력

- 2026-04-10: 초기 작성 — mem0 전환 완료 시점 기준
- 2026-04-10: I2a(search 반환 형식), I7a(Memory 생성 위치) 추가 — 실제 코드 검토 기반
- 2026-04-10: I7 메모리 경로 불일치 주의사항 명시 — defaultMemoryPath()가 PRESENCE_DIR 미반영, config.memory.path override로만 해결 가능
- 2026-04-10: PRESENCE_DIR 한계 해소 — Config.presenceDir()이 환경변수를 직접 반영하도록 수정, I7의 불일치 주의사항 제거.
- 2026-04-10: I2a 정정 — "그대로 반영" 표현 제거. Executor가 `.label` 추출로 string[]으로 변환함을 명시 (executor.js:44). 실패 시 [] 처리 포함.
- 2026-04-10: I4와 I9 충돌 해소 — I4에 읽기 전용 조회(슬래시 커맨드 등) 예외 명시. I9에 MemoryActor 미경유 직접 호출임을 명시. 상태 변경만 MemoryActor 강제.
- 2026-04-10: I3 폴백 로직 정정 — provider가 openai이면 llm.apiKey로 자동 폴백되는 실제 로직 반영. 단순 "embed.apiKey 없으면" 기술에서 폴백 경로 명시로 수정 (memory.js:24).
- 2026-04-10: I9 두 경로로 분리 — (a) 서버 session-api.js: userId 기준. (b) Repl core/repl.js: userId 없이 호출, I2 Known Gap. 운영 TUI 미사용 경로임 명시.
- 2026-04-12: KG-05 해소 — I9(b) Repl cmdMemory()가 this.memory.allNodes(this.userId)로 userId 전달, TUI slash-commands/memory.js도 ctx.userId 전달로 I2 불변식 준수.
