# Platform — presence 의 북극성

**Status**: 2026-04-21 초안. 실행 계획 아님. 큰 변경 제안 시 돌아와 확인하는 방향성 문서.
**Owner**: Presence core.
**관련 문서**: [`design-philosophy.md`](../design-philosophy.md) (기반 철학), [`fsm.md`](fsm.md) (FSM 계층의 북극성), [`../completed.md`](../completed.md) (이력).

---

## 0. 이 문서가 필요한 이유

지난 몇 달간 presence 는 주로 **구조 리팩토링** 을 해왔다 (FSM 아키텍처, 메시지 재설계, 세션별 workingDir 등 Phase A~H). 기반이 탄탄해졌지만, 기능 관점에서 **미완** 인 것들이 여럿 남아있다 — 스케줄러, TODO, A2A, MCP 멀티유저 경계, WUI 재도입, Skills/Commands/Hooks.

이 기능들은 독립 항목처럼 보이지만, 막상 설계하려고 보면 **같은 공통 숙제** 로 수렴한다:

- 유저 / 서버 / 에이전트의 책임 경계
- 같은 기능을 로컬과 원격에서 어떻게 일관되게 부를 것인가
- 확장 (skill/command/hook) 이 안전하게 얹히는 레이어

이 문서는 그 공통 숙제에 대한 **북극성** 을 정의한다. 개별 Phase 는 여기서 파생된다.

---

## 1. Vision

**presence 는 사용자가 서버에 설치하고, 페르소나를 부여한 에이전트가 다양한 업무를 대리하는 개인 플랫폼이다.**

가장 기본 사용 방식:
1. 사용자가 자기 서버 (집, 회사, 클라우드) 에 presence 를 설치한다
2. 에이전트에 페르소나를 준다 — 업무 성격, 말투, 규칙, 사용할 도구/MCP
3. 그 에이전트에게 다양한 업무를 맡긴다 — 일정 정리, 보고서 작성, 코드 리뷰, 스케줄 알림, 외부 정보 수집 등
4. 에이전트는 맡은 일을 **사용자 대신 수행** 하고 결과를 돌려준다

확장:
- **여러 페르소나 · 여러 에이전트** — 하나의 서버에 업무 성격별로 여러 에이전트
- **확장 가능** — skills / commands / hooks 로 개인 워크플로우 쌓기
- **다른 에이전트와 협업** — 업무가 한 서버/한 에이전트로 안 끝나면 A2A 로 다른 에이전트와 일을 나눈다 (내 다른 서버, 동료의 서버 등)

A2A · Agent Card · discovery 는 이 "한 에이전트로 안 끝날 때" 의 해법이지 출발점이 아니다. presence 의 중심은 **"내 페르소나 에이전트가 내 업무를 대리한다"**.

---

## 2. 지금까지 다진 기반 (왜 이게 Vision 의 조각들이었는지)

| 이미 있는 것 | 왜 Vision 에 필요한가 |
|---|---|
| **Op ADT + 인터프리터 분리** (Phase 1~) | LLM 을 finite 선택 공간에 가두고 hook/extension 이 Op 경계에서 붙음 |
| **FSM 대수 + sessionRuntime** (Phase G) | 멀티 클라이언트가 같은 상태를 동기화하는 기반 |
| **stateVersion + snapshot + requestRefresh** (Phase G) | 여러 클라이언트가 깨지지 않고 붙는 계약 |
| **메시지 아키텍처 SSoT** (FP-61) | 이중 출처 제거. 서버가 유일 진실 — WUI/TUI/A2A 가 같은 것을 본다 |
| **세션별 workingDir** (Phase 20) | 한 유저가 여러 프로젝트를 별개로 다룰 기반. `allowedDirs` 가 capability 의 씨앗 |
| **슬래시 커맨드 디스패치 테이블** (FP-42, 단수화 전환) | user-defined 커맨드가 얹힐 슬롯 |
| **web_fetch Readability** (FP-62) | tool 결과 품질이 실제 LLM 사용 가능한 수준에 도달 |

이 기반들이 우연히 쌓인 게 아니라 **"내 페르소나 에이전트가 내 업무를 대리한다"** 는 방향이 있었기에 필연적으로 이 모양이 되었다. 그 위에 "여러 에이전트 · 여러 서버로 확장" 이 얹힐 때 같은 기반이 다시 쓰인다.

---

## 3. 핵심 원칙

Phase 설계 시 가장 먼저 맞춰볼 다섯 항목.

1. **A2A as the universal protocol** — 인스턴스 내부든 외부든 에이전트 간 호출은 A2A 메시지. 로컬 최적화는 transport 레벨에서만 다르다
2. **2-layer extension** — 글로벌(서버·팀 공용) + 개인(유저별). 기존 `server.json` + `users/{u}/config.json` 머지 패턴을 skill/command/hook 에 그대로 확장
3. **Capability-based security** — 도구 접근·파일 경계·credential 을 capability 단일 모델로 통합. Agent Card 에 선언
4. **Op ADT 는 도메인 어휘의 경계** — 모든 확장은 Op 또는 인터프리터 레이어에서. Op 바깥 계층에서 상태 직접 조작 금지 (hallucination 의 침투 경로)
5. **Finite 선택 공간** — LLM 은 Op 의 범위 안에서만 움직인다 ([design-philosophy](../design-philosophy.md) 와 동일)

---

## 4. 방향성 축

### 4-1. A2A 를 프로토콜 계층으로 승격

**현재**
- `delegateActor` + FSM + 같은 프로세스 내 함수 호출
- `packages/infra/src/infra/a2a-client.js` 는 라이브러리 수준으로만 존재
- `test/e2e/multi-instance-live.test.js` 는 서버 간 기본 통신 가능을 보여줄 뿐

**목표**
- 모든 에이전트 간 호출이 A2A 메시지. 호출자는 상대가 로컬인지 원격인지 알 필요 없다
- 스케줄 job 이 에이전트에게 일을 맡길 때도 A2A. `delegate` tool 도 A2A. 다른 인스턴스 호출도 A2A
- 로컬 최적화: transport 를 in-memory queue 로 단락 (네트워크 X). 계약은 동일

**영향**
- delegateActor / FSM 이 A2A 메시지를 생산/소비하는 형태로 진화
- 에이전트 간 id/ownership 모델 필요 (capability 로 해결, §4-3)

### 4-2. Discovery — Agent Card

각 에이전트/세션/스킬/커맨드는 **Agent Card** 로 자기 존재를 드러낸다:

```
AgentCard:
  id: "anthony@home-server/daily-report"
  description: "일간 업무 요약을 작성한다"
  capabilities: [read:~/projects, write:~/reports, ask_llm]
  skills: ["research", "summarize"]
  endpoint: "wss://.../a2a/agent/..."
  trust: "owner"
```

- **로컬 registry**: 같은 인스턴스 안의 카드
- **Peer discovery**: 다른 인스턴스의 카드. 등록 서버 방식 / DNS-SD / mDNS 등 선택지
- Skills/Commands/Hooks 도 카드에 얹혀 노출된다 — "A2A 로 만나면 어떤 능력이 있는지 보인다"

### 4-3. Capability-based 권한

**현재** — 여러 축이 분리되어 있다:
- user/password + JWT (사람 인증)
- `allowedDirs` (파일 경계)
- MCP credential (외부 서비스)
- approve tool (위험 도구 승인)

**목표** — 단일 capability 모델로 통합:
- 각 capability 는 명시적 scope (`read:~/projects`, `write:~/reports`, `mcp:github/owner:anthony`)
- Agent Card 가 capability 집합 선언
- 호출자가 caller capability 를 제시 → 수신자가 허용 여부 판단
- A2A 메시지 envelope 에 capability proof (token/signature) 동반

**결과**
- MCP 멀티유저 경계: credential 은 capability 로 user 에 묶임. 공용/개인 구분이 capability 스코프로 자연스럽게 표현
- workingDir: 이미 allowedDirs 기반 → capability 로 재해석
- A2A 원격 호출: "내 에이전트가 친구 에이전트의 `read:calendar` capability 를 호출" 명확

### 4-4. Extension 3 축 — Skills · Commands · Hooks

**Skills** — persona + 도구 prefilter + 프롬프트 규칙 묶음
- 파일 기반 (Claude Code SKILL.md 호환 고려)
- 글로벌 + 개인 2-layer
- 세션에 동적 로드 (`/skill use X`)

**Commands** — 재사용 가능한 슬래시
- `~/.presence/commands/daily-report.md` → `/daily-report` 로 호출
- 파일 안에 **프롬프트 + argument schema + 기본 workingDir**
- 디스패치 테이블에 동적 주입

**Hooks** — Op 인터프리터 Pre/Post 훅
- Op ADT 에 얹는 게 자연스러움 (이미 `tracedInterpreterR` 이 op 단위로 감싸고 있음)
- Pre: `ExecuteTool` 추가 검증, `AskLLM` 토큰 제한 등
- Post: `UpdateState` 외부 sync, `Respond` 로깅 등
- 글로벌 hook = 서버 관리자 설치 (높은 권한), 개인 hook = user 범위

**공통 저장소 레이아웃**
```
~/.presence/
├── skills/             ← 글로벌
├── commands/
├── hooks/
└── users/{u}/
    ├── skills/         ← 개인
    ├── commands/
    └── hooks/
```

병합 규칙 (각자 다름):
- Skills, Commands: 같은 이름 → 개인 override
- Hooks: 둘 다 실행 (순서는 trust 수준으로: 글로벌 → 개인 권장)

### 4-5. 다중 클라이언트 — TUI / WUI / A2A 한 계약

- 현재 TUI 는 stateVersion + WS init + workingDir 계약 위에 잘 얹혀있다
- WUI 재도입 시 같은 계약 준수. 새 코드를 짜되 **서버 contract 는 안 건드린다**
- A2A 원격 호출도 같은 snapshot 계약 (필요 capability 범위 안에서)

---

## 5. 공통 숙제 — 유저 / 서버 / 에이전트 경계

Vision 과 축 모두가 기대는 한 질문:

> **"누가 무엇을 소유하고, 어떤 권한으로, 어떤 경로로 호출하는가"**

이 질문이 풀려야 아래 결정들이 따라온다:

- MCP 는 공용인가 개인인가? (capability 스코프로)
- 스케줄 job 은 누구 권한으로 실행되는가? (job 생성자 capability)
- 글로벌 hook 이 개인 파일에 접근 가능한가? (hook 에 부여된 capability)
- A2A 로 들어온 요청의 identity 는 user 인가 agent 인가? (Agent Card + capability proof)
- 다른 인스턴스에게 위임할 때 내 capability 의 일부를 delegate 할 수 있는가?

**실행 전략 선택지**
- **Top-down**: capability 모델 먼저 설계 → 개별 기능을 이 모델 위에 얹기
- **Bottom-up**: 한 기능 (예: 스케줄러) 을 살리며 거기서 드러나는 권한 문제로 모델을 발견

어느 쪽이든 경계는 **코드 한 곳 (예: `packages/core/src/core/capability.js`) 에 응집** 되어야 한다. 흩뿌리면 다시 같은 리팩토링 루프.

---

## 6. 남은 구현 항목 (참고 목록)

각 항목은 별도 Phase 또는 FP 로 구체화.

| 항목 | 북극성과의 관계 |
|---|---|
| 스케줄러 재검증 | workingDir + A2A 배선 검증 |
| TODO 피드백 루프 | 스케줄러와 함께 살아남 |
| A2A 실사용 경로 | 프로토콜 계층 승격의 첫 걸음 |
| MCP 멀티유저 경계 | capability 모델의 첫 수렴 지점 |
| WUI 재도입 | 다중 클라이언트 계약 검증 |
| Skills 도입 | 2-layer extension + Agent Card 진입점 |
| Commands 도입 | 디스패치 테이블 확장 |
| Hooks 도입 | Op 레이어 Pre/Post 훅 |

---

## 7. 북극성 확인 질문

큰 변경을 제안할 때 이 문서로 돌아와 답할 것:

1. 이 변경이 "페르소나 에이전트가 사용자 업무를 대리한다" 는 중심 Vision 에 기여하는가?
2. 여러 에이전트 · 여러 서버로 확장될 때 같은 계약 위에 얹히는가? (인스턴스 내/외부 A2A 일관)
3. user-level / server-level 경계가 명확한가? 어느 쪽 capability 로 실행되는가?
4. capability 모델 안에 들어맞는가, 별도 정책을 새로 만들고 있는가?
5. Op ADT 바깥 계층에서 상태나 의미를 조작하지 않는가?

---

## Changelog

- 2026-04-21: 초안. 도그푸딩 몇 주 이후 기능 논의 대화에서 추출한 방향성. 개별 Phase 실행 계획은 아니고, 큰 변경 제안 시 돌아와 체크하는 북극성.
