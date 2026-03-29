---
description: FP 모나드 규칙 — 모든 소스 코드에 적용
globs:
  - "packages/*/src/**/*.js"
---

# FP 모나드 필수 규칙

## 의존성 주입

- Reader.asks만 사용. 클로저 DI(`const createX = (deps) => { ... }`) 신규 작성 금지
- 레거시 브릿지(`const createX = (deps) => xR.run(deps)`)는 단일 라인 위임만 허용
- 외부 모듈/전역 변수 직접 참조 금지 — Reader env를 통해 전달

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
import fp from '@presence/core/lib/fun-fp.js'  // infra, server, orchestrator
import fp from '../lib/fun-fp.js'               // core 내부
const { Either, Task, Reader, Writer, State } = fp
```
