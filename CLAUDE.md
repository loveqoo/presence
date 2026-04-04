# CLAUDE.md

**presence** — 개인 업무 대리 에이전트 플랫폼. Free Monad 기반 FP 아키텍처.

## 아키텍처

- 서버 1개 = 유저 N명. 오케스트레이터 없음.
- 클라이언트는 TUI만 (Ink).
- 유저별 데이터 완전 격리 (`~/.presence/data/{username}/`).
- 여러 머신 배포 시 서버 간 A2A 통신.

## 워크스페이스

| 패키지 | 역할 |
|--------|------|
| `@presence/core` | Op ADT, Free Monad DSL, 인터프리터, REPL |
| `@presence/infra` | LLM, config, auth, memory, persistence, 프로덕션 인터프리터 |
| `@presence/server` | Express + WebSocket 서버 |
| `@presence/tui` | Ink 기반 TUI 클라이언트 |

## 핵심 의존성

- **fun-fp-js**: `packages/core/src/lib/fun-fp.js` (벤더 복사본)
  - `import fp from '@presence/core/lib/fun-fp.js'` (core 외부)
  - `import fp from '../lib/fun-fp.js'` (core 내부)
  - 주요: Free, State, Task, Writer, Reader, Either, Maybe

## 코딩 원칙

- **FP 우선**: 순수 함수, 불변 데이터, 모나딕 합성, 함수 합성
- 구조적으로 중복되는 기능은 클래스를 활용. 다형성을 모색
- **ESM**: `type: "module"`
- **테스트 우선**: mock 인터프리터로 LLM 없이 테스트 가능하게
- 정책 상수는 `packages/core/src/core/policies.js`에 통합. 중복된 상수는 허락하지 않습니다.

## 서비스 정책
- 유저의 추가는 설정 파일을 추가하는 것으로 진행합니다. 런타임에 유저를 동적으로 추가하지 않습니다.
- 계정의 인증 없이 서비스를 사용할 수 없습니다.
- 유저는 LLM 모델을 선택할 수 있습니다.
- 유저는 시스템에서 제공하는 MCP와 직접 설정으로 추가한 MCP를 사용 할 수 있으며, enable/disable 할 수 있습니다.

## 품질 관리

- `.claude/hooks/` — PreToolUse hook으로 코드 편집과 커밋 시점에 규칙을 자동 검증
- `.claude/rules/` — 경로별 코딩 규칙 (FP, 인터프리터, 테스트, 리팩토링)

새로운 규칙이나 검증이 필요하면 hook과 rules에 추가한다.

## 실행

```bash
npm run user -- init --username <이름>   # 사용자 등록
npm start                                 # 서버 시작
npm run start:cli                         # TUI 클라이언트
npm test                                  # 전체 테스트
```

## 참고

- `docs/architecture.md` — 아키텍처 설계 문서
- `docs/completed.md` — 완료 이력
