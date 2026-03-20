# CLAUDE.md

## 프로젝트 개요

**presence** — 개인 업무 대리 에이전트 플랫폼. Free Monad 기반 FP 아키텍처.

## 구현 플랜

`PLAN.md` 참조. Step 1부터 순서대로 진행.

## 핵심 의존성

- **fun-fp-js**: `src/lib/fun-fp.js`에 복사본 배치. 원본은 `../fun-fp-js/dist/fun-fp.js`.
  - ESM default export: `import fp from '../lib/fun-fp.js'`
  - 주요 모듈: Free, State, Task, Writer, Reader, identity

## 코딩 원칙

- **FP 우선**: 순수 함수, 불변 데이터, 모나딕 합성 선호
- **클래스**: 합리적일 때만 사용 (예: 외부 라이브러리 인터페이스)
- **ESM**: `type: "module"`, import/export 사용
- **테스트 우선**: mock 인터프리터를 먼저 만들어 LLM 없이 테스트 가능하게

## 테스트

```bash
# fun-fp-js 테스트 러너 스타일 (경량)
node test/core/op.test.js
node test/core/program.test.js
node test/core/state.test.js
```

## 주의사항

- AgentOp ADT의 `map`은 data가 아닌 continuation(next)에 적용해야 함 (PLAN.md의 AgentOp 섹션 참조)
- 인터프리터는 효과 실행 후 `op.next(result)`로 다음 Free step 반환
- `Free.runWithTask(interpreter)(program)`으로 프로그램 실행
