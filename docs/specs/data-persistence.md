# 데이터 영속화 및 파일 경로 정책

## 목적

presence의 유저별 데이터 저장 경로, 세션 상태 영속화 규칙, transient 필드 처리, 레거시 마이그레이션을 정의한다.

## 파일 경로 구조

```
~/.presence/
├── server.json                         ← 서버 전역 설정
├── users.json                          ← 인증 유저 목록 (bcrypt 해시 + refresh 세션)
├── memory/
│   ├── vector_store.db                 ← mem0 vector DB (SQLite)
│   └── mem0_history.db                 ← mem0 히스토리 DB (SQLite)
└── users/
    └── {username}/
        ├── config.json                 ← 유저별 설정 override
        ├── user-data.db                ← UserDataStore (SQLite, category/status 구조)
        ├── jobs.db                     ← JobStore (SQLite, cron 스케줄)
        └── sessions/
            └── {sessionId}/
                └── state.json          ← 세션 상태 (Conf JSON, PersistenceActor 관리)
```

## 불변식 (Invariants)

- I1. **유저 데이터 경로**: `Config.userDataPath(username)` 경유. 실제 경로는 `Config.presenceDir()/users/{username}/` — 기본값 `~/.presence/users/{username}/`. 구현: `Config.presenceDir()`이 `PRESENCE_DIR` 환경변수를 직접 읽어 모든 파생 경로(`Config.userDataPath()`, `defaultUserDataPath()`, `defaultMemoryPath()`)에 전파된다.

- I2. **서버 전역 경로**: `Config.resolveDir()` 경유. 기본값 `~/.presence/` (`Config.presenceDir()` 반환값). `PRESENCE_DIR` 환경변수 또는 `basePath` 옵션으로 override 가능.
- I3. **세션 persistence 경로**: `Config.resolveDir()/users/{username}/sessions/{sessionId}/state.json` — 기본값 `~/.presence/users/{username}/sessions/{sessionId}/state.json`. `Conf` 라이브러리 사용 (`{ cwd, configName: 'state' }`).
- I4. **transient 필드 미저장**: `_` 접두사 키(`_streaming`, `_debug`, `_toolResults`, `_approve`, `_budgetWarning`, `_compactionEpoch`)는 디스크에 저장하지 않는다. `stripTransient()`가 snapshot에서 제거.
- I12. **workingDir/pendingBackfill 영속화**: `workingDir`과 `pendingBackfill`은 `_` 접두사가 없는 세션 실행 컨텍스트 필드이며 state.json에 저장된다. `UserSession.flushPersistence()`는 `stripTransient(snapshot)`에 이 두 필드를 추가해 저장한다. 복원 시 `workingDir`이 있으면 생성자 결정값을 덮어쓴다. `workingDir` 없이 복원된 경우(레거시 state.json) `pendingBackfill=true`로 처리한다.
- I5. **PersistenceActor 경유 저장**: 세션 상태의 디스크 저장은 PersistenceActor를 통해서만. debounce `PERSISTENCE.DEBOUNCE_MS`(현재 500ms, `packages/core/src/core/policies.js` 정의) 적용. Actor 내부에서 `this.#store.set(PERSISTENCE.STORE_KEY, stripTransient(snapshot))` 실행 (`persistence-actor.js:49`, `PERSISTENCE`는 `@presence/core/core/policies.js` 상수 객체).
- I6. **restore → fresh start on error**: `persistence.restore()` 중 오류 발생 시 로거 warn 후 fresh state로 시작. 저장된 상태가 손상된 경우 자동 복구 불가능하지만 서버는 계속 동작.
- I7. **legacy id 마이그레이션**: `conversationHistory` 항목 중 `id`가 없는 레거시 항목에 자동으로 id 부여. `migrateHistoryIds()` 사용.
- I8. **EphemeralSession은 no-op persistence**: `scheduled`, `agent` 세션의 `flushPersistence()`, `clearPersistence()`는 no-op. 디스크 I/O 없음.
- I9. **UserDataStore**: 유저별 SQLite 파일 (`user-data.db`). category/status 기반 단일 테이블. WAL 모드, foreign keys ON.
- I10. **JobStore**: 유저별 SQLite 파일 (`jobs.db`). cron 기반 잡 스케줄 관리. 잡 실행 이력은 잡당 최대 50건 / 90일 TTL로 보존 (`JOB.HISTORY_MAX_PER_JOB = 50`, `JOB.HISTORY_TTL_DAYS = 90` — 단일 진원: `packages/core/src/core/policies.js`의 `JOB` 상수 객체. `job-store.js`는 이를 import하여 사용).
- I11. **users.json은 서버 레벨**: 인증 유저 목록은 유저별 폴더가 아닌 서버 전역 `~/.presence/users.json`.

## 경계 조건 (Edge Cases)

- E1. 세션 경로(`users/{username}/sessions/{sessionId}/`)가 없는 경우 → 일반 세션 생성(`POST /sessions`)에서는 `persistenceCwd`를 `sessions.create()`에 전달하고 디렉토리 생성은 `Conf` 라이브러리에 위임 (`session-api.js:193-194`). `mkdirSync(persistenceCwd, { recursive: true })`는 레거시 상태 파일(`users/{username}/state.json`) → 새 경로(`users/{username}/sessions/{sessionId}/state.json`) 마이그레이션 분기에서만 호출됨 (`session-api.js:83-84`).
- E2. 레거시 상태 파일 (`users/{username}/state.json`) 존재 시 → 새 경로로 `renameSync`. 이미 새 경로에 파일이 있으면 마이그레이션 건너뜀.
- E3. `state.json`이 손상(JSON 파싱 오류)된 경우 → `restore()` null 반환 → fresh state. 손상 파일은 그대로 남음 (자동 삭제 없음).
- E4. `_compactionEpoch`는 transient 필드지만 restore 후 증가시킴 → `restoreState()` 에서 restore 성공 시 `_compactionEpoch + 1`을 `state.set`으로 반영.
- E5. `users.json`이 없는 경우 → `hasUsers()` false 반환 → 서버 CLI 진입점에서 "No users configured" 출력 후 exit(1).
- E6. `user-data.db` 경로 상위 디렉토리 없는 경우 → `UserDataStore` 생성자에서 `mkdirSync` recursive.
- E7. shutdown 후 `flushPersistence()` → PersistenceActor가 이미 멈춘 상태에서 호출 → 에러 catch로 무시.
- E8. `PRESENCE_DIR` 환경변수 변경 후 서버 재시작 → 이전 경로의 데이터를 읽지 못함. 수동 마이그레이션 필요. ⚠️ 알려진 한계. PRESENCE_DIR이 기본 경로(`~/.presence`)와 다르고, 기본 경로에 `users.json`이 존재하면 서버 부트 시 경고 로그를 출력한다 (KG-06 해소).
- E9. `stripTransient` 결과에 남은 key들 중 깊은 중첩 구조에 `_` 접두사가 있는 경우 → 최상위 key만 필터링. 중첩 내부의 `_` 접두사 필드는 저장됨. ⚠️ 알려진 제한.

## 테스트 커버리지

- I4 → `packages/infra/test/persistence.test.js` (stripTransient)
- I5 → `packages/infra/test/persistence.test.js` (PersistenceActor debounce)
- I12 → `packages/infra/test/persistence.test.js` 5/6 (workingDir + pendingBackfill round-trip), `packages/infra/test/session.test.js` SD10 (복원 후 workingDir 최우선)
- I6 → `packages/infra/test/session.test.js` (restore 실패 fresh start)
- I7 → `packages/infra/test/persistence.test.js` (migrateHistoryIds)
- I8 → `packages/infra/test/session.test.js` (EphemeralSession no-op persistence)
- I9 → 독립 CRUD 테스트 부재 — `packages/infra/test/scheduler.test.js` / `packages/infra/test/events.test.js` 에 간접 검증만 존재 ⚠️
- E2 → (자동화 테스트 없음) ⚠️ 레거시 마이그레이션
- E4 → `packages/infra/test/session.test.js` (_compactionEpoch restore 후 증가)
- E9 → (미커버) ⚠️ 중첩 transient 필드 저장 케이스

## 관련 코드

- `packages/infra/src/infra/persistence.js` — Persistence, stripTransient, migrateHistoryIds
- `packages/infra/src/infra/actors/persistence-actor.js` — debounced save Actor
- `packages/infra/src/infra/user-data-store.js` — UserDataStore (SQLite)
- `packages/infra/src/infra/jobs/job-store.js` — JobStore (SQLite)
- `packages/infra/src/infra/config.js` — Config.presenceDir(), Config.userDataPath(), Config.resolveDir()
- `packages/infra/src/infra/user-context.js` — userDataPath 결정 (line 82, Config.userDataPath() 호출)
- `packages/infra/src/infra/auth/user-store.js` — users.json (인증 유저)
- `packages/server/src/server/session-api.js` — 세션 경로 생성, 레거시 마이그레이션
- `packages/infra/src/infra/sessions/user-session.js` — initPersistence, restoreState, flushPersistence

## 변경 이력

- 2026-04-10: 초기 작성
- 2026-04-10: I1~I3 경로 표기 정정 — `~/.presence/...` 하드코딩에서 Config.resolveDir() 기반으로 정정. PRESENCE_DIR override 명시
- 2026-04-10: I1에 Known Limitation 추가 — Config.userDataPath()가 PRESENCE_DIR을 반영하지 않는 현재 코드 한계 병기. 관련 코드에 user-context.js 및 Config.resolveDir() 추가.
- 2026-04-10: PRESENCE_DIR 한계 해소 — Config.presenceDir()이 환경변수를 직접 반영하도록 수정, I1의 Known Limitation 블록 제거.
- 2026-04-10: E1 정정 — mkdirSync 책임 범위 명시. 일반 세션 생성은 Conf 라이브러리가 디렉토리 생성 담당. mkdirSync는 레거시 마이그레이션 분기에서만 호출.
- 2026-04-10: I9 커버리지 정정 — state.test.js(createStateCell 전용)에서 scheduler/events 간접 검증으로 수정. I5 STORE_KEY → PERSISTENCE.STORE_KEY 정정.
- 2026-04-10: I5 debounce 표기 정정 — 하드코딩 "500ms"에서 상수 참조 "PERSISTENCE.DEBOUNCE_MS(현재 500ms, policies.js 정의)"로 정정.
- 2026-04-10: I10에 JobStore 이력 보존 정책 추가 — HISTORY_MAX_PER_JOB(50), HISTORY_TTL_DAYS(90). job-store.js 로컬 상수, policies.js 미등록 Known Gap 명시.
- 2026-04-10: I10 Known Gap 해소 — JOB 상수가 policies.js로 이동, job-store.js는 JOB.HISTORY_MAX_PER_JOB / JOB.HISTORY_TTL_DAYS import 사용.
- 2026-04-12: KG-06 부분 해소 — E8에 경고 로그 동작 추가. PRESENCE_DIR이 기본 경로와 다르고 기본 경로에 users.json이 존재하면 서버 부트 시 경고 로그 출력. 데이터 미이전 알림 한계는 유지.
