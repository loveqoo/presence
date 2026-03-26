# CLAUDE.md

## 프로젝트 개요

**presence** — 개인 업무 대리 에이전트 플랫폼. Free Monad 기반 FP 아키텍처.

## 구현 플랜

- `PLAN.md` — TODO + 미착수 Phase + 운영 결정 (현행)
- `docs/architecture.md` — 아키텍처 설계 문서 (Phase 1-6 확정)
- `docs/completed.md` — 완료된 Phase + TODO 이력

## 핵심 의존성

- **fun-fp-js**: `src/lib/fun-fp.js`에 복사본 배치. 원본은 `../fun-fp-js/dist/fun-fp.js`.
  - ESM default export: `import fp from '../lib/fun-fp.js'`
  - 주요 모듈: Free, State, Task, Writer, Reader, Either, Maybe, identity

## 코딩 원칙

- **FP 우선**: 순수 함수, 불변 데이터, 모나딕 합성 선호
- **클래스**: 합리적일 때만 사용 (예: 외부 라이브러리 인터페이스)
- **ESM**: `type: "module"`, import/export 사용
- **테스트 우선**: mock 인터프리터를 먼저 만들어 LLM 없이 테스트 가능하게

## 파일 구조

```
src/
├── core/
│   ├── op.js            ← Agent Op ADT + DSL
│   ├── plan.js          ← Plan parser (JSON → Free)
│   ├── prompt.js        ← 프롬프트 조립 + budget fitting
│   ├── agent.js         ← Incremental Planning Engine + 상태 ADT
│   ├── repl.js          ← REPL + slash commands
│   └── policies.js      ← 정책 상수 (HISTORY, MEMORY, PROMPT)
├── interpreter/
│   ├── prod.js          ← 프로덕션 인터프리터
│   ├── test.js          ← Mock 인터프리터
│   ├── traced.js        ← 트레이싱 래퍼
│   └── dryrun.js        ← Dry-run 인터프리터
├── infra/               ← llm, tools, state, memory, config, persistence 등
├── ui/                  ← Ink 컴포넌트 (App, StatusBar, ChatArea, InputBar 등)
├── i18n/                ← ko.json, en.json
└── main.js              ← 조립 (Config → State → Hook → Agent → UI)
```

## 테스트

```bash
# 전체 테스트 (1578 assertions, 39 test files)
npm test
# 또는
node test/run.js

# 개별 파일
node test/core/agent.test.js
node test/core/plan.test.js
node test/infra/memory.test.js
```

모든 테스트는 외부 의존성(LLM, 네트워크) 없이 실행됩니다.

## 주의사항

- AgentOp ADT의 `map`은 data가 아닌 continuation(next)에 적용해야 함 (docs/architecture.md의 Op 설계 참조)
- 인터프리터는 효과 실행 후 `op.next(result)`로 다음 Free step 반환
- `Free.runWithTask(interpreter)(program)`으로 프로그램 실행
- 정책 상수(max history, compaction threshold 등)는 `src/core/policies.js`에 통합 — 파일별 로컬 상수 금지
- MemoryGraph 내부 상태(`store.data.nodes/edges`)는 외부에서 직접 변경 금지 — `removeNodes(predicate)` 등 메서드 사용
