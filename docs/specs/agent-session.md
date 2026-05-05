# Agent Session 정책

## 목적

에이전트 간(A2A) 만남의 의미론을 정의한다. `docs/ontology.md §A2A "두 자아의 만남"` 의 세 결정
(공유 컨텍스트 크기 / 정보 흐름 정책 / 만남의 누적) 을 코드 수준 계약으로 변환한다.
이 스펙이 보장하는 핵심 명제: **agent ↔ agent 만남은 함수 호출이 아니라 관계 이력의 누적이다.**

presence 의 기존 사용자 ↔ presence 세션 모델(`docs/specs/session.md`) 을 A2A 로 확장한다.
세션 ID 가 만남의 식별자이며, 세션 생명주기가 만남의 생명주기다.

---

## 의미론

### 만남 단위

agent ↔ agent 한 번의 만남 = 한 **A2A 세션**. 세션 ID = 만남의 식별자.
`EphemeralSession(type='agent')` 이 만남의 런타임 컨텍스트를 담당한다 (`session.md` SESSION_TYPE.agent 참조).

### 관계의 누적

세션 종료 시 양쪽 에이전트의 메모리에 만남이 영속화된다(양방향 기록).
다음 세션은 이 메모리를 컨텍스트로 읽어 "백 번째 만남을 다르게 해석" 한다.
이것이 도구 호출과 자아 간 만남의 결정적 차이다(`ontology.md §A2A` 인용).

**흡수 데이터 단위**: request/response 페어, 만남 시점(timestamp), 결과(outcome), 세션 ID.
흡수 형식의 schema 상세는 Known Gap(후속 phase — KG-35 참조).

### 개입 모델 (사용자 자율성 보장)

모든 A2A 만남은 ontology 위반 없이 사용자 자율성을 유지해야 한다.
"매 만남 사용자 개입 = 자율성 무효, 모든 만남 자유 = ontology 위반"이라는 딜레마를 해소하기 위해
만남을 **routine / risky / blocked** 세 영역으로 분류한다(위임 영역 분류 섹션 참조).

---

## 세션 라이프사이클

```
사전 인가(Cedar) → 사전 승인(approve gate) → 세션 시작
        ↓
  진행 중: 실시간 관찰 + 사용자 개입 가능
        ↓
세션 종료 → 메모리 흡수 → 사후 검토(risky 영역) → 사후 피드백
```

### 시작 단계

1. **사전 인가**: Cedar 정책 평가 (`Op.CheckAccess`, action=`start_a2a_session`). 거부 시 세션 생성 차단.
2. **사전 승인**: risky 영역으로 분류된 만남에 한해 사용자 approve gate 요청 (`approve.md` 계약 준용).
3. **세션 등록**: `SessionManager` 에 AGENT 타입 세션 등록. `findAgentSession` API 로 조회 가능(`session.md I16`).

### 진행 단계

- 비동기 메시지 큐(wire) 위에서 실행. 동기 의미론이 필요한 호출자는 큐 위 await 으로 표현.
- 사용자는 언제든 세션 abort 또는 메시지 끼워넣기(inject) 가능. 비동기 wire 가 이를 자연스럽게 허용.
- TUI 에 활성 세션 목록 노출.

### 종료 단계

1. **세션 종료 이벤트**: lifecycle audit 기록.
2. **메모리 흡수**: 양쪽 에이전트 메모리에 만남 기록 영속화 (I-AS-MUTUAL-RECORD).
3. **사후 검토** (risky 영역): 사용자가 메모리 흡수 전 만남 내용 검토 가능. 구체 UX 는 후속 phase.
4. **사후 피드백**: 정책/페르소나 갱신 신호 생성 가능 (신뢰 누적 루프 — 후속 phase).

---

## Wire 결 (비동기 메시지 큐)

**확정**: 모든 A2A 통신은 비동기 메시지 큐 위에서 동작한다.

- `Task<T> ⊃ Identity<T>` 일방향 변환 — 동기 의미론이 필요한 호출자는 비동기 위 await 으로 표현.
- 이유: 멀티 사용자 × 멀티 인스턴스 환경 가정, 동기 wire 부하 집중 위험 회피, backpressure 자연 도입.
- 현재 구현: `A2aQueueStore` (`a2a_messages` 테이블, `data-persistence.md I13`) 가 큐 backend.
- 멀티 인스턴스 간 큐 backend 확장은 A2A Phase 2 범위.

---

## 메모리 흡수 (양방향 기록)

### 불변식

세션 종료 시 발신 에이전트와 수신 에이전트 양쪽의 메모리에 만남이 기록되어야 한다.
어느 한쪽이라도 기록 실패 시 관계 이력이 비대칭이 된다 — 이는 ontology 위반이다.

### 흡수 데이터 구조 (1차 spec 자리)

| 필드 | 설명 |
|------|------|
| `sessionId` | 만남 식별자 |
| `timestamp` | 만남 시점 (ISO 8601) |
| `peerAgentId` | 상대방 AgentId |
| `outcome` | 성공/실패/중단 |
| `requestSummary` | request 내용 요약 (또는 전체) |
| `responseSummary` | response 내용 요약 (또는 전체) |

**흡수 schema 상세 미정** — KG-35 등록됨.

### 사후 검토 게이트

risky 영역 세션: 메모리 흡수 전 사용자 검토 가능 (approve gate 준용).
위험 영역 정의 기준은 후속 phase 에서 확정 — KG-33 등록됨.

---

## 개입 6결 매트릭스

| 결 | 시점 | 메커니즘 | Cedar action | approve gate |
|----|------|----------|-------------|-------------|
| 사전 인가 | 세션 시작 전 | Cedar 정책 평가 | `start_a2a_session` | 없음 (자동) |
| 사전 승인 | 세션 시작 전 | approve gate (risky 영역) | - | 있음 |
| 실시간 관찰 | 진행 중 | TUI 활성 세션 목록 | - | 없음 |
| 실시간 개입 | 진행 중 | abort / inject (큐 wire 자연 지원) | - | 없음 |
| 사후 검토 | 종료 직후 | 메모리 흡수 전 검토 (risky 영역) | - | 있음 (risky) |
| 사후 피드백 | 검토 완료 후 | 정책/페르소나 갱신 신호 | - | 없음 |

---

## 위임 영역 분류

### 분류 기준

| 영역 | 정의 | 사전 승인 | 사후 검토 |
|------|------|-----------|-----------|
| **routine** | Cedar 자동 승인 + 낮은 위험 | 없음 | 없음 |
| **risky** | Cedar 허용이나 사용자 검토 필요 | 필요 | 필요 |
| **blocked** | Cedar 거부 | N/A (차단) | N/A |

### Cedar 정책 슬롯 매핑

분류 기준은 Cedar 정책으로 표현된다:

- routine: `00-base.cedar` permit + 운영자 추가 deny 없음
- risky: 운영자 custom policy (`50-*.cedar`) 가 `PENDING` 으로 분류 또는 quota 초과
- blocked: 운영자 custom policy `50-*.cedar` 가 forbid — terminal DENIED

**A2A 전용 Cedar action**: 본 spec 에서 `start_a2a_session` 으로 확정. Cedar 스키마(`schema.cedarschema`) 와 `00-base.cedar` permit 추가는 인프라 phase 에서 구현. 정책 슬롯 예시: `10-a2a-quota.cedar` (활성 세션 한도), `50-*-agent-session.cedar` (운영자 custom A2A 정책).

---

## 활성 세션 한도

한 에이전트가 동시에 가질 수 있는 활성 A2A 세션 수에 상한이 있다.

- 이유: `ontology.md §A2A "공유 컨텍스트 크기 제한"` + 부하 보호.
- 상한 값: Cedar quota 정책으로 표현 (`A2A.SESSION_QUOTA` 상수 — `policies.js`, 현재 미정의).
- 상한 초과 시: `STATUS.PENDING` 또는 즉시 거부 (정책 설정에 따름).
- **상한 값 및 quota 정책 구체 정의는 후속 phase** — KG-36 등록됨.

---

## 정보 흐름 정책 (IFC)

세션 단위로 정보 흐름을 제어한다. RBAC 보다 강한 결:

- 예시 등급: `P→A 가능 / A→P 불가 / 양방향이지만 7일 만료`
- 이유: presence 개인 영역과 외부 에이전트 회사 영역의 부분 겹침. 완전 통합 금지(`ontology.md §A2A` 참조).

**IFC 구체 정책 언어 미정의** — 본 1차 spec 에서는 의미론 자리만 마련. 후속 phase 에서 정책 DSL 과 함께 정의 — KG-32 등록됨.

---

## 신뢰 영역 (장기, 자리 마련)

`ontology.md §1.3 4 요소 (사후 학습 루프)` 에 해당하는 신뢰 누적 메커니즘:

- 신뢰 누적에 따라 routine 영역 확장 (처음에는 보수적, 신뢰 쌓이면 넓어짐).
- 사후 피드백이 정책 갱신을 제안하는 루프가 닫히면 ontology §1.3 완성.
- **본 1차 spec 에서는 분류(routine/risky/blocked) 까지만 확정. 자동 갱신 메커니즘은 후속 phase** — KG-31 등록됨.

---

## 불변식 (Invariants)

- **I-AS-AUTH**. 모든 A2A 세션 시작은 Cedar 정책 평가(`Op.CheckAccess`, action=`start_a2a_session`) 통과 후에만 허용된다. Cedar 평가 없이 세션이 생성되는 경로는 존재하지 않는다. 거부 결과(DENIED/blocked)이면 세션 생성이 즉시 차단된다.

  **결정 근거**: 일반 `access_agent` (사용자→에이전트) 와 분리해 운영자가 A2A 만 별도 정책으로 제어 가능. ontology §A2A "도구 호출이 아니라 두 자아의 만남" 결을 정책 라벨에서도 유지.

- **I-AS-MUTUAL-RECORD**. 세션이 정상 종료될 때 발신 에이전트와 수신 에이전트 양쪽 메모리에 만남이 기록된다. 어느 한쪽 기록 실패도 관계 이력 비대칭을 만든다 — 허용되지 않는다. 흡수 실패 시 세션 종료를 지연하거나 오류를 보고해야 한다.

- **I-AS-USER-VISIBLE**. TUI 에서 사용자는 자신의 에이전트가 참여 중인 모든 활성 A2A 세션 목록을 볼 수 있어야 한다. 세션이 시작되면 TUI 에 즉시 반영되고, 종료되면 목록에서 제거된다.

- **I-AS-INTERVENTION**. 사용자는 진행 중인 A2A 세션을 언제든 abort 할 수 있다. abort 신호는 비동기 큐 wire 를 통해 즉시 전달 가능해야 하며, 에이전트는 이를 무시할 수 없다. inject(메시지 끼워넣기) 도 동일 wire 로 지원된다.

- **I-AS-AUDIT**. 세션 lifecycle 의 모든 이벤트(시작/종료/abort/inject/메모리 흡수 성공·실패)는 audit 기록에 남는다. audit 기록 없이 lifecycle 이벤트가 완료되는 경로는 존재하지 않는다. audit 형식은 JSONL (`data-persistence.md` Cedar audit 패턴 준용).

- **I-AS-WIRE-ASYNC**. 모든 A2A 통신은 비동기 큐 위에서 이루어진다. 동기 의미론이 필요한 경우 비동기 위 await 으로 표현한다. 동기 직접 호출(함수 호출) 로 다른 에이전트의 에이전트 로직을 직접 실행하는 경로는 존재하지 않는다.

- **I-AS-SESSION-QUOTA**. 한 에이전트가 동시에 가질 수 있는 활성 A2A 세션 수는 Cedar quota 정책으로 상한이 정해진다. 상한 초과 요청은 `STATUS.PENDING` 또는 즉시 거부로 처리된다. 상한 없는 무제한 세션 생성은 금지된다.

- **I-AS-CLASSIFICATION**. 모든 A2A 세션은 시작 전에 routine / risky / blocked 중 하나로 분류된다. 분류 결과가 없는 세션은 blocked 로 처리된다(fail-closed).

---

## 경계 조건 (Edge Cases)

- **E1. Cedar 평가 실패 (evaluator 오류)** → fail-closed. 세션 생성 차단. `REASON.MISSING_EVALUATOR` 또는 `DENIED(evaluator-error)` 반환.

- **E2. 세션 시작 직후 호출자 에이전트 종료** → 수신 에이전트는 세션을 orphan 상태로 인식. `markFailed('sender-shutdown')` 처리. 메모리 흡수는 수신 에이전트 단독 기록 (비대칭 허용 — 단, audit 에 비대칭 사실 기록).

- **E3. 메모리 흡수 중 수신 에이전트 종료** → I-AS-MUTUAL-RECORD 위반 위험. 재시작 회복(`session.md I16 재시작 회복 S4 패턴`) 준용. 흡수 미완료 세션은 audit 에 `outcome=partial` 기록.

- **E4. risky 세션의 사전 승인 대기 중 timeout** → 사용자 무응답 시 정책에 따라 자동 거부 또는 대기 유지. 자동 거부 시 세션 생성 차단 + audit 기록. 구체 timeout 값은 후속 phase.

- **E5. abort 신호 전달 중 세션 완료** → abort 와 정상 완료가 경합할 경우, 먼저 도달한 결과로 확정. `markCompleted` / `markFailed` 의 boolean race 방어(`data-persistence.md I13 markCompleted/markExpired race 방어`) 패턴 준용.

- **E6. 동일 에이전트 쌍 간 동시 복수 세션** → 허용되나 I-AS-SESSION-QUOTA 상한 적용. 각 세션은 독립 세션 ID 를 가진다.

- **E7. IFC 위반 정보 흐름 시도** → IFC 정책 구체 정의 전까지는 audit 기록만 남기고 허용. IFC 정책 정의 후 차단으로 전환 — KG-32 참조.

- **E8. 활성 세션 한도 초과 요청** → `STATUS.PENDING` 또는 즉시 거부. Cedar quota 정책 결과에 따름. 정책 미정의 상태에서는 거부(fail-closed).

---

## 테스트 커버리지

현재 1차 spec 단계 — 인프라 구현 전이므로 대부분 미커버.

| 불변식/경계 | 상태 |
|------------|------|
| I-AS-AUTH | (미커버) ⚠️ Cedar 평가 통과 후 세션 생성 경로 검증 필요 |
| I-AS-MUTUAL-RECORD | (미커버) ⚠️ 양방향 메모리 흡수 단위 테스트 필요 |
| I-AS-USER-VISIBLE | (미커버) ⚠️ TUI 활성 세션 목록 표시 시나리오 필요 |
| I-AS-INTERVENTION | (미커버) ⚠️ abort/inject wire 전달 단위 테스트 필요 |
| I-AS-AUDIT | (미커버) ⚠️ lifecycle 이벤트 audit JSONL 기록 검증 필요 |
| I-AS-WIRE-ASYNC | (미커버) ⚠️ 동기 직접 호출 경로 부재 정적 회귀 필요 |
| I-AS-SESSION-QUOTA | (미커버) ⚠️ quota 상한 Cedar 평가 검증 필요 |
| I-AS-CLASSIFICATION | (미커버) ⚠️ fail-closed(분류 없음 → blocked) 경로 검증 필요 |
| E1 (evaluator 오류) | (미커버) ⚠️ |
| E3 (흡수 중 종료) | (미커버) ⚠️ |
| E5 (abort + 완료 경합) | `data-persistence.md I13` markCompleted race 방어 부분 커버 |

---

## Known Gaps (본 spec 에서 자리만 마련, 후속 phase 확정)

아래 항목은 본 1차 spec 작성 시점에 의미론 자리를 마련하되 구체 정의는 후속 phase 로 위임한 항목이다.

### KG-31 (신뢰 영역 자동 갱신 메커니즘 미구현)

- 내용: 사후 학습 루프 (`ontology.md §1.3`) 가 정책 갱신을 제안하는 루프 미구현. routine/risky/blocked 분류 기준이 신뢰 누적에 따라 자동 확장되는 메커니즘 부재.
- 범위: 별도 phase (A2A Phase 2 이후).
- 위치: 본 문서 "신뢰 영역" 섹션.

### KG-32 (IFC 구체 정책 언어 미정의)

- 내용: 정보 흐름 제어(IFC) 의 구체 정책 표현 언어 미정의. `P→A 가능 / A→P 불가 / 양방향이지만 7일 만료` 같은 등급을 Cedar 또는 별도 DSL 로 어떻게 표현할지 미결정.
- 범위: 별도 phase.
- 위치: 본 문서 "정보 흐름 정책(IFC)" 섹션.

### KG-33 (메모리 흡수 전 검토 게이트의 위험 영역 정의 미정)

- 내용: 사후 검토 게이트(세션 종료 후 메모리 흡수 전 사용자 검토) 의 구체 트리거 조건 미정. "risky 영역" 기준이 현재 추상적.
- 범위: 별도 phase.
- 위치: 본 문서 "메모리 흡수" 섹션.

### KG-34 (세션 lifecycle event audit JSONL 형식 미정)

- 내용: audit 기록의 JSONL schema 미정의. 어떤 필드를 필수로 가질지, lifecycle 이벤트 유형 enum 이 무엇인지 미결정.
- 범위: 별도 phase.
- 위치: 본 문서 불변식 I-AS-AUDIT.

### KG-35 (메모리 흡수 데이터 schema 미정)

- 내용: 만남 흡수 시 mem0 에 저장되는 데이터의 구체 schema 미정. requestSummary/responseSummary 의 형식, 요약 vs 전체 저장 정책 미결정.
- 범위: 별도 phase.
- 위치: 본 문서 "메모리 흡수" 섹션.

### KG-36 (활성 세션 한도 + Cedar quota 정책 구체 값 미정의)

- 내용: `A2A.SESSION_QUOTA` 상수 값 미정의. Cedar quota 정책 파일(`10-a2a-quota.cedar` 등) 미작성. 초과 시 PENDING vs 즉시 거부 정책 미결정.
- 범위: 별도 phase.
- 위치: 본 문서 "활성 세션 한도" 섹션.

---

## 관련 코드

- `packages/infra/src/infra/sessions/ephemeral-session.js` — A2A 만남 런타임 컨텍스트 (SESSION_TYPE.agent)
- `packages/infra/src/infra/sessions/session-manager.js` — findAgentSession / findSenderSession (I16)
- `packages/infra/src/infra/a2a-queue-store.js` — 비동기 큐 backend (wire 결)
- `packages/infra/src/infra/a2a-response-dispatcher.js` — response 전달 + drain
- `packages/infra/src/interpreter/send-a2a-message.js` — SendA2aMessage Op 인터프리터
- `packages/infra/src/infra/authz/cedar/` — Cedar 정책 파일 디렉토리
- `packages/infra/src/infra/authz/agent-governance.js` — canAccessAgent, submitUserAgent
- `packages/core/src/core/policies.js` — A2A 상수 (A2A.RECOVER_BATCH_MAX 등)

---

## 관련 문서

- `docs/ontology.md §A2A` — 의미론 기준점 (두 자아의 만남 / 관계의 누적 / 손과 발)
- `docs/design-philosophy.md` — Op ADT 도메인 어휘 결
- `docs/design/cedar-infra.md §1.2` — 정책 디렉토리 + in-source 워크플로
- `docs/specs/session.md` — 기존 사용자 ↔ presence 세션 모델 (재사용 기반)
- `docs/specs/agent-identity.md` — AgentId / 5 진입점 / Cedar 정책 불변식
- `docs/specs/approve.md` — Approve gate 계약 (risky 영역 사전/사후 승인 준용)
- `docs/specs/data-persistence.md` — A2aQueueStore schema / I13 / 파일 경로 규칙

---

## 변경 이력

- 2026-05-03: 초기 작성 — A2A 멀티 인스턴스 phase 진입 전 1차 의미론 못 박기. ontology §A2A 세 결정(공유 컨텍스트/IFC/만남의 누적) 코드 계약 변환. 6 Known Gap 자리 마련 (KG-AS-TRUST / IFC / REVIEW-GATE / AUDIT-FORMAT / MEMORY-SCHEMA / QUOTA).
- 2026-05-03: KG-31~KG-36 정식 ID 부여 (REGISTRY 등록 완료).
- 2026-05-05: I-AS-AUTH Cedar action 확정 — start_a2a_session 신규 도입 (옵션 B). 일반 access_agent 와 분리해 운영자가 A2A 정책을 별도 표현 가능.
