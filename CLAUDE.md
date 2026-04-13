# CLAUDE.md

**presence** — 개인 업무 대리 에이전트 플랫폼. Free Monad 기반 FP 아키텍처.

**설계 철학**: [`docs/design-philosophy.md`](docs/design-philosophy.md) — 이 프로젝트의 북극성. 왜 Op ADT 를 도메인 어휘로 정의하는지, 왜 LLM 을 finite 선택 공간에 가두는지, 왜 결정론 대신 수렴 루프를 목표로 하는지. **Op ADT 바깥 계층 (subagent 결과, 자유 텍스트 출력 등) 에서 구조화된 보고를 받으면 hallucination 가능성을 먼저 의심할 것** — 그 계층에는 아직 finite 선택 공간이 없다. 설계 결정이 막힐 때 돌아와 읽는다.

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

### 자동 검증 (훅)

- `.claude/hooks/` — PreToolUse hook으로 코드 편집과 커밋 시점에 규칙을 자동 검증
- `.claude/rules/` — 경로별 코딩 규칙 (FP, 인터프리터, 테스트, 리팩토링, 티켓)

새로운 규칙이나 검증이 필요하면 hook과 rules에 추가한다.

### 듀얼 리뷰 워크플로우

**커밋 전** — Claude의 git commit 시 두 단계 리뷰가 훅으로 강제된다:
1. `check-code-review.sh` 훅 — staged diff 해시로 code-reviewer 실행 여부를 검증. 미실행 시 커밋 차단.
2. `pre-commit-codex-review.sh` 훅 — Codex 일반 품질/보안 검토 (경고). git commit 시 자동 실행.

code-reviewer 통과 후 반드시 리뷰 해시를 기록한다:
```bash
git diff --cached | shasum -a 256 | cut -d' ' -f1 > .claude/.review-hash
```

**플랜 수립 후** — (임시 중단 2026-04-14) Codex 플랜 리뷰 강제 게이트는 Openclaw heartbeat 가 Codex quota 를 공유 소진하는 문제로 일시 해제되었다. `check-plan-review.sh` 훅의 ExitPlanMode wiring 제거, hook script 와 `plan-reviewer` 서브에이전트는 보존 (복구 용이). Codex quota 제약이 해소되면 `.claude/settings.json` 에 ExitPlanMode 훅을 다시 등록해 복구한다. 그동안 플랜 리뷰는 선택적이며, 필요 시 `plan-reviewer` 서브에이전트를 수동 호출할 수 있다.

**막힐 때** — `codex-rescue` 서브에이전트 (Agent 툴, subagent_type=`codex-rescue`) 로 디버깅/원인분석을 Codex 에 위임한다. `/codex:rescue` slash command 는 사용자 직접 입력용이다.

## 작업 체계 — 에이전트 + 티켓

presence 의 변경은 **에이전트 리뷰** 와 **티켓 레지스트리** 두 축으로 관리한다.

**에이전트 (`.claude/agents/`)**
- `code-reviewer` — `.claude/rules/` 기준 코드 규칙 검증 (커밋 전 필수)
- `plan-reviewer` — 플랜 파일 Codex 리뷰 (ExitPlanMode 전 게이트는 2026-04-14 임시 해제, 수동 호출만 가능. `task` 서브커맨드 wrapper)
- `spec-guardian` — 도메인 스펙(`docs/specs/`) 정합성 검증
- `ux-guardian` — UX 마찰점(`docs/ux/`) 감사
- `user-guide-writer` — 사용자 가이드(`docs/guide/ko/`) 갱신

**오케스트레이터 에이전트는 없다.** 메인 Claude 가 직접 Agent 툴로 guardian 을 호출한다. 기능 변경 후 메인이 `spec-guardian` / `ux-guardian` / `user-guide-writer` 를 병렬로 호출해 스펙/UX/가이드를 동기화한다 (공식 패턴: 단일 메시지에 Agent 툴 호출 여러 개). 각 guardian 은 자기 영역 문서만 수정하며 코드는 읽기만 한다. guardian 호출 시 반드시 `.claude/agents/<name>.md` 의 `## 호출 규약` 에 따라 **감사 범위** 를 프롬프트 첫 줄에 명시해야 한다 — 범위가 비면 maxTurns 소진 또는 scope drift 위험.

**티켓 레지스트리 (`docs/tickets/REGISTRY.md`)**
- 모든 작업 항목(FP = UX 마찰점, KG = 스펙 Known Gap)을 전역 유일 ID 로 통합 관리
- 단일 진실의 원천. 외부 인프라 의존 없이 git merge conflict 가 직렬화 포인트 역할
- 스펙 불변식(I 항목)은 라이프사이클이 없으므로 레지스트리에 포함하지 않음

```bash
scripts/tickets.sh next-id fp     # 다음 ID 확인 (반드시 사용, 자체 부여 금지)
scripts/tickets.sh list --status open --type fp
scripts/tickets.sh check          # pre-commit hook 이 자동 실행
```

상세 절차는 `.claude/rules/tickets.md` 참고.

## 실행

```bash
npm run user -- init --username <이름>   # 사용자 등록
npm start                                 # 서버 시작
npm run start:cli                         # TUI 클라이언트
npm test                                  # 전체 테스트
```

## 참고

- [`docs/design-philosophy.md`](docs/design-philosophy.md) — 설계 철학 / 북극성 (최상단 링크와 동일)
- `docs/architecture.md` — 아키텍처 설계 문서
- `docs/completed.md` — 완료 이력
