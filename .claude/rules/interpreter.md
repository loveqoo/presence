---
paths:
  - "packages/*/src/interpreter/**/*.js"
---

# 인터프리터 규칙

## 시그니처

모든 인터프리터 핸들러: `(op) => StateT(Task)([nextFree, newState])`

- Op의 효과를 실행하고 `op.next(result)`로 다음 Free step 반환
- StateT.get, StateT.modify로 상태 접근. 직접 변이 금지
- StateT.lift(Task)로 비동기 효과 래핑

## Op ADT

- `map`은 continuation(next)에만 적용. data 필드 변경 금지
- Free.liftF(Op)로 DSL 구성. 인터프리터에서 효과 실행

## 합성

- Interpreter.compose(ST, ...interpreters)로 여러 인터프리터 합성
- 각 인터프리터는 handles Set으로 담당 Op 선언
- traced 래퍼는 Writer 기반 getTrace/resetTrace 사용

## 금지

- 인터프리터 내부에서 ReactiveState 직접 참조 금지 (prod.js 제외)
- 인터프리터 간 암묵적 의존성 금지 — 명시적 deps만 사용
