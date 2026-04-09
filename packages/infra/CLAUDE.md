# @presence/infra

인프라 구현: LLM, config, auth, memory, persistence, 프로덕션 인터프리터.

## 구조

```
src/
├── infra/        ← llm, tools, state, memory, config, auth, persistence 등
├── interpreter/
│   ├── prod.js       ← 프로덕션 인터프리터
│   └── delegate.js   ← 위임 인터프리터
└── i18n/         ← ko.json, en.json
```

## 주의사항

- MemoryGraph 내부 상태(`store.data.nodes/edges`)는 외부에서 직접 변경 금지 — `removeNodes(predicate)` 등 메서드 사용
- 프로덕션 인터프리터(prod.js)만 ReactiveState 직접 참조 허용
