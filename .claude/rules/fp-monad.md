---
paths:
  - "packages/*/src/**/*.js"
---

# FP 모나드 필수 규칙

## 모나드 역할 경계

각 모나드는 하나의 관심사만 담당한다. 역할을 혼용하지 않는다.

| 모나드 | 역할 | 사용처 | 금지 |
|--------|------|--------|------|
| **Reader** | 의존성 전파 | factory의 deps 합성·전달 | 상태 변경, 부수 출력 |
| **Writer** | 관찰 정보 축적 | trace, audit log append | 의존성 주입, 상태 변경 |
| **State** | 순수 설정/빌더 | config merge 파이프라인 | 비동기 효과, 리액티브 hooks |
| **StateT(Task)** | 턴 실행 상태 + 비동기 | Free 인터프리터 상태 스레딩 | 의존성 주입, 관찰 축적 |
| **Either** | 동기 에러 분기 | 검증, 파싱, 분기 | 비동기, 상태 |
| **Task** | 비동기 실행 | 지연 실행, 합성 async | 상태 스레딩 |

## 의존성 주입

- Reader.asks만 사용. 클로저 DI(`const createX = (deps) => { ... }`) 신규 작성 금지
- 레거시 브릿지(`const createX = (deps) => xR.run(deps)`)는 단일 라인 위임만 허용
- 외부 모듈/전역 변수 직접 참조 금지 — Reader env를 통해 전달
- **함수 파라미터 5개 초과 시 Reader 또는 옵션 객체 사용** (refactor.md Long Parameter List 통일, `eslint max-params: 5`):
  - 의존성 묶음이면 `Reader.asks(env => ...)` env 객체에 흡수
  - 단순 옵션 묶음이면 destructuring `({ a, b, c, d, e, f })` — ESLint 는 1 param 으로 카운트
  - positional 6+ 는 금지 (호출자 가독성 + Reader 패턴 일관성)

## 상태 변경

- 직접 변이(`obj.x = y`, `arr.push(x)`, `arr.length = 0`) 금지
- StateT(Task) 또는 State.modify로 새 상태 반환
- ReactiveState.set()은 인터프리터/hook 경계에서만 허용 (순수 로직 내부에서는 금지)

## 에러 처리

- Either.Right/Left로 분기. try-catch는 외부 라이브러리 호출 경계에서만
- Task.fork()는 Express handler, Actor handle 등 실행 경계에서만
- Either.fold()로 패턴 매칭. `if (result.error)` 같은 수동 분기 금지

## 부수 출력

- Writer.tell로 축적. 가변 배열 push 금지
- getTrace()/resetTrace() 같은 함수 인터페이스로 캡슐화
- 내부 mutable accumulator 사용 시 외부에 노출하지 않음

## import 패턴

```javascript
import fp from '@presence/core/lib/fun-fp.js'  // infra, server, tui
import fp from '../lib/fun-fp.js'               // core 내부
const { Either, Task, Reader, Writer, State } = fp
```
