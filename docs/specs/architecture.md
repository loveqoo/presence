# 아키텍처 원칙 정책

## 목적

presence의 전체 구조적 불변식을 정의한다. Free Monad 기반 FP 아키텍처, 인터프리터 계층 분리, 멀티유저 격리, 패키지 의존성 방향이 항상 유지되어야 한다.

## 불변식 (Invariants)

- I1. **선언과 실행 분리**: Free Monad 프로그램(Op 시퀀스)은 순수하다. 부작용은 인터프리터만 실행한다.
- I2. **인터프리터 계층 방향**: `@presence/core` 인터프리터는 infra에 의존하지 않는다. infra 인터프리터(`prod.js`)가 core 인터프리터를 합성한다.
- I3. **패키지 의존성 방향**: `tui` → `server` (HTTP/WS만) / `server` → `infra` → `core`. 역방향 의존 없음.
- I4. **fun-fp-js 단일 진원**: `packages/core/src/lib/fun-fp.js` 벤더 복사본이 유일한 FP 라이브러리. 외부 FP 라이브러리 별도 도입 금지.
- I5. **정책 상수 중앙화**: 도메인 의미를 가진 상수는 `packages/core/src/core/policies.js`에만 정의. 파일별 로컬 중복 금지.
- I6. **서버 1개 = 유저 N명**: 오케스트레이터 없음. 유저별 UserContext가 독립 인프라 스택을 보유한다.
- I7. **유저 데이터 완전 격리**: 서로 다른 유저의 데이터는 같은 메모리/DB/파일을 공유하지 않는다. Memory(mem0)만 서버 레벨 공유 인스턴스이며, 모든 메서드에 `agentId` (`{username}/{agentName}` qualified form)를 전달하여 격리. qualified key 구조상 유저 간 격리는 자동 달성되며, 같은 유저 내 서로 다른 agent도 독립 격리된다.
- I8. **모나드 역할 경계**: Reader(의존성 주입), Writer(관찰 축적), State(설정 파이프라인), StateT(Task)(턴 실행 상태 + 비동기), Either(동기 에러), Task(비동기) — 각 모나드는 하나의 관심사만 담당.
- I9. **클라이언트는 TUI만**: 현재 클라이언트는 Ink 기반 TUI(`@presence/tui`)뿐이다. 서버는 HTTP/WebSocket API를 노출하고 TUI는 그것을 소비한다.

## 경계 조건 (Edge Cases)

- E1. `@presence/core` 내부에서 infra 모듈 import 시도 → 즉시 의존성 위반. 허용 안 됨.
- E2. fun-fp-js의 `Either`, `Task`, `Reader` 등을 직접 구현하거나 다른 라이브러리로 대체 시도 → I4 위반.
- E3. 인터프리터 핸들러 내부에서 `reactiveState`를 직접 참조 → 금지 범위: `packages/core/src/interpreter/` 하위 파일 전체 및 `packages/infra/src/interpreter/delegate.js`. 이 경로의 인터프리터 핸들러는 StateT.get/modify로만 상태 접근해야 한다. 허용 예외: `packages/infra/src/interpreter/prod.js`의 `createUiHelpers` 함수 (streaming UI, toolResult, delegate 실시간 업데이트 목적). 참고: `packages/core/src/core/state-commit.js`의 `applyFinalState`는 인터프리터 핸들러가 아닌 턴 완료 후 커밋 유틸이므로 이 제약의 적용 대상이 아니다.
- E4. policies.js 외부 파일에 두 곳 이상에서 같은 의미의 문자열/숫자 리터럴이 등장 → I5 위반.
- E5. 유저 A의 세션이 유저 B의 `userDataStore` 또는 `jobStore`에 접근 → I7 위반.
- E5a. 유저 A의 agent가 유저 B의 agentId로 `Memory.search()`를 호출 → I7 위반. qualified key 구조상 `{userB}/{agentName}` 키로 조회되므로 유저 A의 기억과 교차하지 않지만, 호출 경로 자체가 허용되어선 안 됨.
- E6. 서버 shutdown 중에 새 턴 요청 도달 → TurnController가 거부하거나 큐에서 완료 후 종료.
- E7. 같은 태그를 두 인터프리터에 등록 → `Interpreter.compose`가 즉시 throw (fail-fast 설계).

## 테스트 커버리지

- I1 → `packages/core/test/interpreter/prod.test.js` (순수 프로그램 vs 인터프리터 분리)
- I2 → `packages/core/test/interpreter/` (core 인터프리터에 infra import 없음)
- I5 → `.claude/hooks/validate-fp.sh` PreToolUse hook
- I7 → `packages/infra/test/session.test.js`, `packages/server/test/server.test.js`
- I8 → `.claude/rules/fp-monad.md` 규칙 강제, `packages/infra/test/auth-middleware.test.js`
- E7 → `packages/core/test/interpreter/prod.test.js` (중복 태그 throw 검증)
- E3 → (미커버) ⚠️ 인터프리터 내부 ReactiveState 직접 접근 방지 자동화 테스트 없음

## 관련 코드

- `packages/core/src/lib/fun-fp.js` — FP 라이브러리 단일 진원
- `packages/core/src/core/policies.js` — 정책 상수 중앙 저장소
- `packages/core/src/interpreter/compose.js` — 인터프리터 합성 + 중복 태그 fail-fast
- `packages/infra/src/interpreter/prod.js` — 7개 인터프리터 합성, ReactiveState 참조 허용점
- `packages/infra/src/infra/user-context.js` — 유저별 인프라 스택
- `packages/server/src/server/index.js` — 서버 1개 = 유저 N명 부트스트랩

## 변경 이력

- 2026-04-10: 초기 작성 — 실제 코드 기반
- 2026-04-10: E3 금지 범위 파일/디렉토리 기준으로 특정 — core/interpreter/ 전체 + infra/interpreter/delegate.js, prod.js 예외 유지, state-commit.js 비적용 명시
- 2026-04-24: data-scope-alignment 완료 반영 — I7 Memory 격리 단위를 userId → agentId로 갱신. qualified key `{username}/{agentName}` 구조로 유저 간 격리와 agent 간 격리를 동시 달성함을 명시. E5a 신규 추가 (타 유저 agentId로 Memory 직접 호출 위반 조건).
