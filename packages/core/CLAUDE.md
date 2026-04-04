# @presence/core

Free Monad 기반 에이전트 DSL과 인터프리터.

## 구조

```
src/
├── core/
│   ├── op.js         ← Agent Op ADT + DSL (Free.liftF로 구성)
│   ├── plan.js       ← Plan parser (JSON -> Free)
│   ├── prompt.js     ← 프롬프트 조립 + budget fitting
│   ├── agent.js      ← Incremental Planning Engine + 상태 ADT
│   ├── repl.js       ← REPL + slash commands
│   └── policies.js   ← 정책 상수 (HISTORY, MEMORY, PROMPT)
├── interpreter/
│   ├── compose.js    ← Interpreter.compose(ST, ...interpreters)
│   ├── test.js       ← Mock 인터프리터
│   ├── traced.js     ← Writer 기반 트레이싱 래퍼
│   ├── dryrun.js     ← Dry-run 인터프리터
│   ├── llm.js        ← LLM Op 핸들러
│   ├── tool.js       ← Tool Op 핸들러
│   ├── control.js    ← Control Op 핸들러
│   ├── state.js      ← State Op 핸들러
│   ├── approval.js   ← Approval Op 핸들러
│   └── parallel.js   ← Parallel Op 핸들러
└── lib/              ← fun-fp.js 벤더 복사본
```

## 주의사항

- Op ADT의 `map`은 data가 아닌 continuation(next)에 적용
- 인터프리터: 효과 실행 후 `op.next(result)`로 다음 Free step 반환
- `Free.runWithTask(interpreter)(program)`으로 실행
- 정책 상수는 `policies.js`에 통합 — 파일별 로컬 상수 금지
