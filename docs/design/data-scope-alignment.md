# Data Scope Alignment — 에이전트 단위 격리 설계

**Status**: 2026-04-24 v1 초안. `feature/agent-scoped-data` 브랜치의 구현 기준선. 확정 후 이 문서 기반으로 플랜 작성.

**Owner**: Presence core.

**관련 문서**:
- [`agent-identity-model.md`](agent-identity-model.md) — Agent ID / 세션 매핑의 토대
- [`a2a-internal.md`](a2a-internal.md) — 이 리팩토링을 선행으로 요구한 A2A Phase 1 설계
- [`platform.md`](platform.md) — 북극성
- `docs/specs/data-persistence.md`, `docs/specs/session.md`, `docs/specs/memory.md` — 스펙 갱신 대상

---

## 0. 이 문서의 이유

A2A Phase 1 설계 (`a2a-internal.md`) 를 작성하다가 발견한 구조적 비대칭. presence 는 "유저의 agent 들이 활동하는 공간" 을 자처하지만, 데이터 자원의 격리 단위가 섞여 있다:

- 세션은 `agentId` 필수 — 이미 agent 에 귀속
- 대화 히스토리는 세션 안에 — 자동으로 agent 단위
- Memory 는 `userId` 파라미터로만 격리 — 같은 유저의 모든 agent 가 공유
- TODO (UserDataStore) 는 유저 DB — 모든 agent 가 공유
- Jobs (JobStore) 는 유저 DB + owner 컬럼 (하지만 필터링 안 씀, [KG-19](../tickets/REGISTRY.md))

이 비대칭 때문에 "에이전트끼리 TODO 를 주고받는다" 같은 문장이 코드에서는 의미가 없다 — 모두가 같은 풀을 보고 있기 때문. A2A 를 의미 있게 구현하려면 자원의 격리 단위부터 의도에 맞게 정렬해야 한다.

---

## 1. 원칙

**"유저가 관리하는 것"** vs **"agent 가 축적하는 것"** 으로 경계를 긋는다.

| 관점 | 성격 | 격리 단위 |
|---|---|---|
| 유저가 주체 | 할 일을 결정하고 어느 agent 에게 시킬지 선택 | **유저** |
| Agent 가 주체 | 자기 대화/경험/기억을 축적 | **Agent** |

유저는 agent 를 자원으로 보유한다. TODO 와 Job 은 유저의 관리 대상이며 agent 는 실행자. Memory 와 Session 은 agent 가 자기 활동을 축적하는 곳이며 유저가 선택 가능한 자원.

---

## 2. 자원별 결정

| 자원 | 현재 격리 | **결정** | 이유 |
|---|---|---|---|
| UserDataStore (TODO) | 유저 DB 1개 | **유저 유지** | 유저의 할 일 풀. agent 는 실행자 |
| JobStore | 유저 DB + owner 컬럼 | **유저 유지** | 유저가 스케줄 관리. agent 지정은 태그 |
| SchedulerActor | 유저당 1개 | **유지** | 1 poller 가 유저의 agent 를 선택 |
| Memory (mem0) | 공유 DB + userId 파라미터 | **Agent 파라미터 격리** | Agent 개별 기억 |
| Session 영속화 | `sessions/{sid}/` | **경로에 agent 디렉토리** | 세션은 agent 에 귀속 |

**범위 밖** (별도 처리):
- JobStore 소유권 필터링 누락 — [KG-19](../tickets/REGISTRY.md) 별도 티켓
- A2A 통신 구현 — `a2a-internal.md` / `a2a-transport.md` 후속

---

## 3. 경로 체계

### 3.1 변경 전

```
~/.presence/
├── memory/                         # mem0 공유 DB (userId 키)
│   ├── vector_store.db
│   └── mem0_history.db
└── users/{u}/
    ├── sessions/{sid}/state.json   # 세션 (agentId 는 state 내부 필드)
    └── memory/
        ├── user-data.db             # TODO
        └── jobs.db                  # Jobs
```

### 3.2 변경 후

```
~/.presence/
├── memory/                         # mem0 공유 DB (agentId 키)  ← 파라미터만 변경
│   ├── vector_store.db
│   └── mem0_history.db
└── users/{u}/
    ├── agents/{a}/                  # ← 신규 디렉토리
    │   └── sessions/{sid}/state.json
    └── memory/                     # 변경 없음
        ├── user-data.db             # TODO (유저 유지)
        └── jobs.db                  # Jobs (유저 유지)
```

변경 최소화 원칙: Memory 는 **경로 분리 없이 파라미터만 agentId 로**. mem0 의 embed 모델 설정, vector DB 파일은 서버 레벨 공유로 유지 (비용/복잡도 절감).

---

## 4. 구현 변경 지점

### 4.1 Memory API — `userId` → `agentId`

**`packages/infra/src/infra/memory.js`**:
- `search(userId, ...)` → `search(agentId, ...)` — 5 개 메서드 모두 시그니처 파라미터명만 변경. 내부적으로 mem0 `opts.userId` 로 전달하는 것 자체는 유지 (mem0 API 고정)

**소비처 (7 곳)**:
| 파일 | 라인 | 현재 | 변경 |
|---|---|---|---|
| `packages/infra/src/infra/actors/memory-actor.js` | 22, 32 | `this.#userId` | `this.#agentId` |
| `packages/tui/src/ui/slash-commands/memory.js` | 26, 31, 52, 53 | `ctx.userId` | `ctx.agentId` |
| `packages/server/src/server/slash-commands.js` | 71 | `ctx.userId` | `ctx.agentId` |
| `packages/core/src/core/repl-commands.js` | 59 | `repl.userId` | `repl.agentId` |
| `packages/infra/src/infra/sessions/internal/session-actors.js` | 24 | `sessionEnv = { ..., userId }` | `sessionEnv = { ..., agentId: session.agentId }` |
| `packages/infra/src/infra/auth/remove-user.js` | 22 | `memory.clearAll(username)` | user 의 모든 agent 순회 후 `clearAll(agentId)` |

### 4.2 Session 경로 조립 — agent 디렉토리 삽입

**`packages/server/src/server/session-api.js`**:
- L24 `findOrCreateSession`: `persistenceCwd = join(userDir, 'sessions', sid)` → `join(userDir, 'agents', agentName, 'sessions', sid)`
- L174 `POST /sessions`: 동일 변경
- L26-29 legacy migration 제거 (기존 데이터 버림 결정)

**`packages/server/src/server/index.js`**:
- L149 default session 생성 지점 경로 갱신

**세션 타입별 영향**:
- `UserSession` (persistence 있음) — 경로 변경 직접 영향
- `EphemeralSession`, `ScheduledSession`, `AgentSession` — persistence no-op 이므로 경로 무관

### 4.3 테스트 경로 하드코딩

- `packages/server/test/server.test.js:242` — `users/testuser/sessions/{sid}/state.json` → `users/testuser/agents/default/sessions/{sid}/state.json`
- Memory 격리 테스트 — userId 격리에서 agentId 격리로 전환 (같은 유저 다른 agent 간 검색 격리 검증 추가)

### 4.4 기타

- `repl-commands.js`: REPL 인스턴스 생성 시 `agentId` 필드 전달 지점 확인
- TUI/Server slash-command context 구성: `agentId` 를 ctx 에 실어 보내는 경로 확인

---

## 5. 스펙 문서 영향 (spec-guardian 작업 대상)

| 스펙 | 갱신 내용 |
|---|---|
| `docs/specs/data-persistence.md` | I3 (세션 경로 불변식) — agent 디렉토리 삽입 반영 |
| `docs/specs/session.md` | I5 (기본 세션 자동 생성) — 경로 예시 갱신 |
| `docs/specs/memory.md` | I2 (격리 단위) — userId 격리 → agentId 격리 |
| `docs/specs/agent-identity.md` | 관련 코드 목록에 변경 파일 추가 |

---

## 6. 마이그레이션

**결정**: 기존 데이터 버림. legacy migration 로직 추가하지 않음.

영향:
- 기존 유저의 `users/{u}/sessions/{sid}/state.json` — 새 경로에서 찾지 못함 → 새 세션처럼 시작
- 기존 mem0 vector store — userId 로 저장된 엔트리는 agentId 로 조회 시 미스 → 빈 기억으로 시작
- `session-api.js` 의 구 2단계 migration (`state.json` → `sessions/{sid}/state.json`) 도 함께 제거

운영자가 필요한 경우 수동으로 옛 경로 데이터를 새 경로로 복사 가능하나 공식 마이그레이션은 제공하지 않음.

---

## 7. 분리된 후속 작업

- **KG-19**: JobStore 소유권 필터링 누락 (별도 티켓 등록 완료, 2026-04-24)
- **A2A Phase 1**: `docs/design/a2a-internal.md` — 이 리팩토링 완료 후 착수
- **A2A Phase 2**: `docs/design/a2a-transport.md` — A2A Phase 1 완료 후

---

## 8. 검증

### 8.1 단위 테스트

- Memory agent 격리: 같은 유저의 agent A 가 add → agent A search 는 결과, agent B search 는 0 건
- Session 경로: 새 경로 (`users/{u}/agents/{a}/sessions/{sid}/state.json`) 에 state.json 생성 확인
- remove-user: user 의 모든 agent 의 memory 가 청소되는지

### 8.2 E2E

- 같은 유저 2 개 agent 로 서로 다른 기억/세션을 가지는지
- TODO 는 여전히 유저 수준에서 공유 (의도된 동작)

### 8.3 회귀

- 스케줄러 잡 dispatch 가 올바른 agent 세션으로 가는지 (기존 동작 유지 확인)

---

## 9. 일정 (추정)

| 커밋 | 작업 | 시간 |
|---|---|---|
| 1 | Memory API `agentId` 전환 + 소비처 + 테스트 | 2h |
| 2 | Session 경로 agent 디렉토리 삽입 + legacy migration 제거 + 테스트 | 1h |
| 3 | remove-user 순회 + 스펙 갱신 (spec-guardian) | 1h |

합계 약 4h, 3 커밋. 플랜 단계에서 재조정.

---

## Changelog

- **v1 (2026-04-24)**: 초안. A2A 설계 중 발견된 데이터 스코프 비대칭 해소. Memory/Session 을 agent 단위로, TODO/Jobs 를 유저 단위로 유지하는 이분 결정 기록.
