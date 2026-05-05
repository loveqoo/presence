# Agent Session 정책

## 목적

에이전트 간(A2A) 만남의 의미론을 정의한다. `docs/ontology.md §A2A "두 자아의 만남"` 의 세 결정
(공유 컨텍스트 크기 / 정보 흐름 정책 / 만남의 누적) 을 코드 수준 계약으로 변환한다.
이 스펙이 보장하는 핵심 명제: **agent ↔ agent 만남은 함수 호출이 아니라 관계 이력의 누적이다.**

presence 의 기존 사용자 ↔ presence 세션 모델(`docs/specs/session.md`) 을 A2A 로 확장한다.
**세션 = 두 에이전트 쌍의 영속 관계 컨테이너(1:1 고정)**. 만남이 누적되는 장소이며, 새 세션이 누적되지 않는다.

---

## 의미론

### 만남 단위 (재정의 — 2026-05-05)

- **만남 = request/response 한 쌍**. 메시지가 한 번 왕복 = 한 번 만남.
- **세션 = 두 에이전트 쌍의 영속 관계 컨테이너 (1:1 고정)**. 세션 ID = 두 에이전트 쌍의 관계 식별자.
- 같은 두 자아 사이엔 만남이 누적되지 새 세션이 누적되지 않는다 (ontology §A2A "관계의 누적" 결).
- 세션은 EphemeralSession(휘발성) 이 아닌 **영속 세션**. SESSION_TYPE.agent 의 의미가 영속 관계 컨테이너임 (`session.md` SESSION_TYPE.agent 참조).

### 공유 컨텍스트 결 (결정 2026-05-05)

A2A 세션의 공유 컨텍스트는 사용자 ↔ 에이전트 세션 모델(`session.md`) 의 컨텍스트 관리 결을 재사용한다.
상대 에이전트를 자기 유저로 취급 — 동일한 히스토리 trim / max_tokens / 요약 메커니즘이 적용된다.
ontology §A2A "공유 컨텍스트 크기" 의 두 극단(통합 자아 / 메시지 교환) 사이 균형은
기존 사용자 세션 결의 안정 영역으로 흡수된다.

**I-AS-CONTEXT-REUSE**: A2A 세션의 컨텍스트 관리는 사용자 ↔ 에이전트 세션 모델과 동일 결을 사용한다.
A2A 전용 별도 컨텍스트 정책은 도입하지 않는다.

### 관계의 누적

세션(영속 관계 컨테이너)에 만남이 기록될 때 양쪽 에이전트의 메모리에도 영속화된다(양방향 기록).
다음 만남은 이 메모리를 컨텍스트로 읽어 "백 번째 만남을 다르게 해석" 한다.
이것이 도구 호출과 자아 간 만남의 결정적 차이다(`ontology.md §A2A` 인용).

**흡수 데이터 단위**: request/response 페어, 만남 시점(timestamp), 결과(outcome), 세션 ID.
흡수 형식의 schema 상세는 Known Gap(후속 phase — KG-35 참조).

### 개입 모델 (사용자 자율성 보장)

모든 A2A 만남은 ontology 위반 없이 사용자 자율성을 유지해야 한다.
"매 만남 사용자 개입 = 자율성 무효, 모든 만남 자유 = ontology 위반"이라는 딜레마를 해소하기 위해
만남을 **routine / risky / blocked** 세 영역으로 분류한다(위임 영역 분류 섹션 참조).

---

## 세션 라이프사이클 (영속 세션)

```
세션 생성 (첫 만남 시 lazy)
    ↓
관계 영속 — 만남이 누적됨
    ↓
명시적 폐기 / 비우기 / 요약 (사용자 선택)

[스트리밍 wire 만] inactivity timeout → 만남만 종료, 세션 유지
```

세션(영속 관계 컨테이너) 과 만남(request/response 페어) 은 라이프사이클이 다르다.

## A2A 운영 흐름 (카드 교환 → 큐 적재 → heartbeat 디스패치 → 응답)

외부 에이전트 B 가 presence 내부 에이전트 A 와 연결할 때의 운영 흐름.

### 단계 1 — 카드 교환 (한 번)

B 가 자기 카드 (agent ID + 페르소나 메타 + 능력 목록) 를 보내고 A 의 카드를 받는다.
presence 가 Cedar 정책 평가 (`start_a2a_session`, action 정의는 §위임 영역 분류 참조) 를 통과하면 세션을 lazy create. 이미 세션이 있으면 기존 세션 재사용 — 세션 ID 재사용이 곧 "같은 관계의 연속".

- **카드 교환은 한 번**: 세션이 살아있는 한 재교환 불필요. 라우팅 정보 (B 의 endpoint) 는 세션 메타로 보존된다.
- **I-AS-AUTH cross-reference**: Cedar 평가가 이 단계에서 일어난다. 거부 시 세션 생성 및 카드 교환 모두 차단.

### 단계 2 — 메시지 적재 (B → 큐)

B 의 메시지는 presence 의 큐 (`A2aQueueStore`) 에 먼저 적재된다. **외부 에이전트는 내부 에이전트를 직접 호출하지 못한다.**
→ I-AS-WIRE-PROTECTION 불변식이 이 경로를 명시적으로 차단한다.

### 단계 3 — heartbeat 디스패치 (큐 → A)

presence heartbeat 가 큐를 폴링해 A 에게 메시지를 전달한다.
heartbeat + 큐 조합이 내부 에이전트의 보호막 역할을 한다:

- **rate-limit**: heartbeat 주기 이상으로 메시지가 밀려들어도 내부 에이전트는 heartbeat 단위로만 받는다.
- **인가 재검증**: 디스패치 시점에 세션/A2A 인가를 재확인할 수 있다.
- **backpressure 자연 도입**: 큐가 꽉 차면 새 enqueue 가 실패 — 외부 에이전트가 자연스럽게 흐름 제어를 경험한다.

### 단계 4 — A 응답 (A → B 직접)

A 가 B 에게 직접 전송한다. 카드 교환 시 얻은 라우팅 정보(B 의 endpoint) 를 사용하므로 큐를 경유하지 않는다. **응답은 큐 미경유** — 단방향 흐름: 수신만 큐 경유, 발신은 직접.

### 단계 5 — 반복 (같은 세션 재사용)

B 가 다음 메시지를 보내면 단계 2 (큐 적재) → 단계 3 (heartbeat 디스패치) → 단계 4 (A 응답) 를 같은 세션 ID 로 반복한다. 세션 ID 가 두 자아 쌍의 관계 식별자이므로 새 세션 생성 없음 (`§만남 단위 재정의` 참조).

---

## 응답 모드 (4 결)

A2A 세션 내에서 A 가 B 에게 응답하는 방식은 4 가지다. **모드 전환은 사용자 명시 행위에서만 발생한다.**

| 모드 | 응답자 | B 가 보는 발신자 | A 의 역할 | wire |
|------|-------|----------------|----------|------|
| **agent-default** | A 자율 | A | 자율 자아 | A↔B 메인 |
| **user-takeover** | 사용자 | 사용자 | 비활성 | 사용자↔B 메인 |
| **user-via-agent** | A 가 1회 응답 | A | 단발 도구 | A→B 메인 (사용자 명시 호출 후) |
| **user-with-whisper** | 사용자 | 사용자 | 비공개 자문 | 두 채널: 사용자↔A 비공개 + 사용자→B 메인 |

이 4 결은 `ontology.md §손과 발` 의 4 양태 (자율 / 비활성 / 도구 / 자문) 를 A2A 세션 응답 맥락에서 직접 표현한다.

**응답 출처 audit 레이블**:

| 모드 | audit 출처 레이블 |
|------|-----------------|
| agent-default | `agent-autonomous` |
| user-takeover | `user-autonomous` |
| user-via-agent | `user-via-agent` (발화자는 A 지만 책임 주체는 사용자) |
| user-with-whisper (사용자 발화) | `user-autonomous` |

→ I-AS-RESPONSE-MODE 불변식 참조.

---

## 만남 라이프사이클

```
사전 인가(Cedar) → 사전 승인(approve gate) → 만남 시작 (세션 없으면 lazy 생성)
        ↓
  진행 중: 실시간 관찰 + 사용자 개입 가능
        ↓
만남 종료 → 메모리 흡수 → 사후 검토(risky 영역) → 사후 피드백
```

### 시작 단계

1. **사전 인가**: Cedar 정책 평가 (`Op.CheckAccess`, action=`start_a2a_session`). 거부 시 만남(세션 생성 포함) 차단.
2. **사전 승인**: risky 영역으로 분류된 만남에 한해 사용자 approve gate 요청 (`approve.md` 계약 준용).
3. **세션 lazy 생성**: 두 에이전트 쌍 사이 영속 세션이 없으면 첫 만남 시 생성. 이미 있으면 재사용.
4. **만남 등록**: `SessionManager` 에 AGENT 타입으로 현재 만남의 실행 컨텍스트 등록. `findAgentSession` API 로 조회 가능(`session.md I16`).

### 진행 단계

- 비동기 메시지 큐(wire) 위에서 실행. 동기 의미론이 필요한 호출자는 큐 위 await 으로 표현.
- 사용자는 언제든 만남 abort 또는 메시지 끼워넣기(inject) 가능. 비동기 wire 가 이를 자연스럽게 허용.
- TUI 에 활성 세션(관계) 목록 노출.

### 종료 단계

**만남 종료**:
1. **만남 종료 이벤트**: lifecycle audit 기록.
2. **메모리 흡수**: 양쪽 에이전트 메모리에 만남 기록 영속화 (I-AS-MUTUAL-RECORD).
3. **사후 검토** (risky 영역): 사용자가 메모리 흡수 전 만남 내용 검토 가능. 구체 UX 는 후속 phase.
4. **사후 피드백**: 정책/페르소나 갱신 신호 생성 가능 (신뢰 누적 루프 — 후속 phase).

**세션(관계 컨테이너) 종료 — 자동 종료 없음**:

A2A 세션은 자동 종료되지 않는다. 두 자아의 관계는 영속이며,
사용자가 명시적으로 다음 셋 중 하나를 선택할 수 있다:

1. **세션 폐기** (close): 관계 자체를 끊는다. 메모리 흡수 이력은 audit 에 보존되나 활성 세션 목록에서 제거.
   권장하지 않음 — 관계 단절은 ontology 결에서 무거운 결정.
2. **내용 비우기** (clear): 세션은 유지하되 누적된 메시지 history 를 비운다. 메모리 흡수 이력은 보존.
   일상적 정리 권장 옵션.
3. **요약** (summarize): 누적 history 를 LLM 요약으로 압축. 컨텍스트 부담 완화. 비우기보다 점진적.

자동 종료가 적용되는 단 하나의 예외: **스트리밍 wire** (long-running connection — websocket 등).
이 경우 inactivity timeout (운영자 설정) 적용. 단, 세션(관계 컨테이너) 자체는 유지 — 만남만 종료.
비동기 큐 wire(`A2aQueueStore`) 는 자연 timeout 불필요.

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

risky 영역 세션 종료 시 메모리 흡수 전 사용자 검토 단계가 삽입된다 (approve gate 준용).

**사용자 부재 시 처리 (hybrid 정책)**: 세션 안 미검토 만남 큐 누적 모델.
- **기본 (c)**: 사용자가 TUI 미진입 상태면 흡수를 보류하고 **세션 내 미검토 만남 큐** 에 적재. 다음 TUI 진입 시 "지난 N 일간 미검토 risky 만남 M 건" 안내 + 일괄/개별 결정. 만남(request/response 페어) 단위로 누적되므로 세션이 살아있는 한 큐는 이어진다.
- **안전망 (b)**: 큐 적재 후 운영자 설정 기간 (예: 7 일) 경과 시 자동으로 만료 처리 — 만료 동작은 운영자 설정으로 `discard` (폐기, audit 만 기록) 또는 `absorb` (자동 흡수 + audit 에 "검토 없이 자동 흡수" 명시) 중 선택.
- **자동 처리 절대 금지 분기 없음**: 운영자가 자기 책임 하에 `absorb` 를 선택할 수 있다 — 자율성 양도 정도는 운영 결정.

**운영자 설정 키 (자리 마련)**:
- `agentSession.reviewGate.expiryDays`: number — 만료 기간 (기본값 후속 phase 확정).
- `agentSession.reviewGate.expiryAction`: `'discard' | 'absorb'` — 만료 시 동작.

위 설정 키 구체값/기본값/검증 규칙은 KG-33 후속 phase. config.md schema 반영도 후속.

---

## 개입 6결 매트릭스

| 결 | 시점 | 메커니즘 | Cedar action | approve gate |
|----|------|----------|-------------|-------------|
| 사전 인가 | 세션 시작 전 | Cedar 정책 평가 | `start_a2a_session` | 없음 (자동) |
| 사전 승인 | 세션 시작 전 | approve gate (risky 영역) | - | 있음 |
| 실시간 관찰 | 진행 중 | TUI 활성 세션 목록 | - | 없음 |
| 실시간 개입 | 진행 중 | abort / inject (큐 wire 자연 지원) | - | 없음 |
| 사후 검토 | 만남 종료 직후 | 미검토 큐 + 만료 안전망 (c+b hybrid, expiryAction 운영자 설정) | - | 있음 (risky) |
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

## 활성 세션 한도 + 동시 만남 한도

세션이 1:1 고정 영속이므로 "활성 세션 수" 의 의미는 **관계 맺은 상대 에이전트 수** 다.

### 활성 세션(관계) 한도

- 이유: `ontology.md §A2A "공유 컨텍스트 크기 제한"` + 부하 보호.
- 상한 값: Cedar quota 정책으로 표현 (`A2A.SESSION_QUOTA` 상수 — `policies.js`, 현재 미정의).
- 상한 초과 시: `STATUS.PENDING` 또는 즉시 거부 (정책 설정에 따름).
- **상한 값 및 quota 정책 구체 정의는 후속 phase** — KG-36 등록됨.

### 동시 만남(request/response 페어) 한도

- 동시에 진행 중인 만남 수(request 페어 동시성) 에 별도 quota 가 필요한지는 후속 phase 에서 결정.
- **KG-36 본문에 두 결 모두 포함** (활성 세션 한도 + 동시 만남 한도).

---

## 정보 흐름 정책 (IFC)

세션 단위로 정보 흐름을 제어한다. RBAC 보다 강한 결:

- 예시 등급: `P→A 가능 / A→P 불가 / 양방향이지만 7일 만료`
- 이유: presence 개인 영역과 외부 에이전트 회사 영역의 부분 겹침. 완전 통합 금지(`ontology.md §A2A` 참조).

**IFC 구체 정책 언어 미정의** — 본 1차 spec 에서는 의미론 자리만 마련. 후속 phase 에서 정책 DSL 과 함께 정의 — KG-32 등록됨.

### 귓속말 채널 (whisper) — IFC 첫 구체 사례

**귓속말은 A2A IFC 의 첫 구체 사례다.** `user-with-whisper` 응답 모드의 비공개 자문 채널이 이에 해당한다.

- **채널 정의**: 사용자 ↔ A 비공개 자문 채널. B 에게 미노출.
- **IFC 등급**: `P→A 가능 / A→B 불가 / 휘발 (저장 안 함)`
- **진정한 휘발성**: audit 미기록 + A 메모리 미누적. 시스템 어느 곳에도 자문 흔적이 남지 않는다.
  - 사람이 친구에게 귀띔받고 본인 의사로 답하는 결과와 동일한 의미론.
- **책임 추적 약화**: presence 외부 audit (관리자 감사) 관점에서 귓속말 내용은 추적 불가. 귓속말 기반 판단의 책임은 전적으로 사용자 본인에게 귀속된다.
- **ontology 결**: `ontology.md §손과 발` 4 양태 중 "자문" 양태의 극단적 표현 — 자문이 어떤 흔적도 남기지 않을 때 사용자 자율성이 가장 강하게 보장된다.

KG-32 (IFC 정책 언어) 설계 시 본 사례를 표현 가능해야 한다:
> 첫 구체 사례: 귓속말 채널 (whisper) — `P→A 가능 / A→B 불가 / 휘발`. 정책 언어 설계 시 본 사례를 표현 가능해야 함.

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

  **§A2A 운영 흐름 연결**: 카드 교환(단계 1) 시 이 평가가 실행된다. 평가 통과 후 세션 lazy create 또는 기존 세션 재사용이 결정된다.

- **I-AS-MUTUAL-RECORD**. **만남 단위** 양방향 흡수 불변식. 만남(request/response 페어) 종료 시 발신 에이전트와 수신 에이전트 양쪽 메모리에 해당 만남이 기록된다. 한쪽 기록 실패 시 처리 정책은 **partial + audit (옵션 c)**: 성공한 쪽 기록은 유지하고, audit 에 `outcome=partial` 과 실패한 쪽 식별자 / 실패 사유를 남긴다. 비대칭 자체는 ontology 위반이지만 발생을 감추지 않고 드러내는 것을 우선한다.

  **만남 단위 의미**: 한 만남에서 partial 흡수가 발생해도 세션(영속 관계 컨테이너) 은 살아있다. 다음 만남에서 이전 partial 사실을 컨텍스트로 받아 보강 기회가 열린다 (보강 schema 는 KG-35 후속).

  **결정 근거**: 종료 지연(옵션 a)은 한쪽 영구 다운 시 세션이 못 끝나는 비현실적 비용. 롤백(옵션 b)은 "이미 일어난 만남을 지우는" 더 큰 ontology 위반 — 분산 트랜잭션 비용도 큼. (c) 는 비대칭을 audit 으로 surface 하여 운영자/사용자 사후 인지를 보장.

  **보강 의무**:
  - audit 비대칭 발생 시 운영자에게 가시화 (TUI 알람 또는 audit log warning — 구체 UX 는 KG-34 / KG-33 후속).
  - 다음 세션 컨텍스트 로딩 시 "지난 만남이 비대칭이었다" 를 양쪽에 노출 → 자기 교정 기회 (구체 schema 는 KG-35 후속).

- **I-AS-USER-VISIBLE**. TUI 에서 사용자는 자신의 에이전트가 참여 중인 모든 활성 A2A 세션 목록을 볼 수 있어야 한다. 세션이 시작되면 TUI 에 즉시 반영되고, 종료되면 목록에서 제거된다.

- **I-AS-INTERVENTION**. 사용자는 진행 중인 A2A 세션을 언제든 abort 할 수 있다. abort 신호는 비동기 큐 wire 를 통해 즉시 전달 가능해야 하며, 에이전트는 이를 무시할 수 없다. inject(메시지 끼워넣기) 도 동일 wire 로 지원된다.

- **I-AS-AUDIT**. 세션 lifecycle 의 모든 이벤트(시작/종료/abort/inject/메모리 흡수 성공·실패)는 audit 기록에 남는다. audit 기록 없이 lifecycle 이벤트가 완료되는 경로는 존재하지 않는다. audit 형식은 JSONL (`data-persistence.md` Cedar audit 패턴 준용).

- **I-AS-WIRE-ASYNC**. 모든 A2A 통신은 비동기 큐 위에서 이루어진다. 동기 의미론이 필요한 경우 비동기 위 await 으로 표현한다. 동기 직접 호출(함수 호출) 로 다른 에이전트의 에이전트 로직을 직접 실행하는 경로는 존재하지 않는다.

- **I-AS-WIRE-PROTECTION**. 외부 에이전트의 메시지는 presence 큐(`A2aQueueStore`) 에 적재되어 heartbeat 가 내부 에이전트로 전달한다. 외부 에이전트가 내부 에이전트의 인터프리터/메시지 핸들러를 직접 호출하는 경로는 존재하지 않는다. 큐 + heartbeat 가 rate-limit / 인가 재검증 / backpressure 의 인프라 보호막이다.

  이 불변식은 I-AS-WIRE-ASYNC 의 보호 목적을 명시적으로 확장한다. I-AS-WIRE-ASYNC 가 "동기 직접 호출 금지" 를 선언한다면, I-AS-WIRE-PROTECTION 은 "외부 → 내부 경로는 반드시 큐 경유" 라는 운영 보호 구조를 선언한다 (§A2A 운영 흐름 단계 2/3 참조).

- **I-AS-RESPONSE-MODE**. A2A 세션 응답 모드는 agent-default / user-takeover / user-via-agent / user-with-whisper 4 가지. 모드 전환은 사용자 명시 행위에서만 발생한다 — 에이전트가 자체적으로 takeover 를 풀거나 사용자 응답을 가로채지 않는다.

  ontology `§손과 발` 의 4 양태 (자율 / 비활성 / 도구 / 자문) 를 A2A 세션 응답 맥락에서 직접 표현한다.

  **응답 출처 audit 레이블 (I-AS-AUDIT 준수)**:
  - `agent-autonomous`: agent-default 모드.
  - `user-autonomous`: user-takeover 모드. user-with-whisper 의 사용자 발화도 동일 레이블.
  - `user-via-agent`: user-via-agent 모드. 발화자는 A 이지만 책임 주체가 사용자임을 명시.

  **귓속말 (whisper) audit 예외**: user-with-whisper 의 비공개 자문 채널 (사용자 ↔ A) 은 audit 미기록 + A 메모리 미누적 — 진정한 휘발성. 사용자 자율성 최강 결. 책임 추적은 §IFC 귓속말 채널 섹션 참조.

- **I-AS-SESSION-QUOTA**. 한 에이전트가 동시에 가질 수 있는 활성 A2A 세션 수는 Cedar quota 정책으로 상한이 정해진다. 상한 초과 요청은 `STATUS.PENDING` 또는 즉시 거부로 처리된다. 상한 없는 무제한 세션 생성은 금지된다.

- **I-AS-CLASSIFICATION**. 모든 A2A 세션은 시작 전에 routine / risky / blocked 중 하나로 분류된다. 분류 결과가 없는 세션은 blocked 로 처리된다(fail-closed).

---

## 경계 조건 (Edge Cases)

- **E1. Cedar 평가 실패 (evaluator 오류)** → fail-closed. 세션 생성 차단. `REASON.MISSING_EVALUATOR` 또는 `DENIED(evaluator-error)` 반환.

- **E2. 세션 시작 직후 호출자 에이전트 종료** → 수신 에이전트는 세션을 orphan 상태로 인식. `markFailed('sender-shutdown')` 처리. 메모리 흡수는 수신 에이전트 단독 기록 + I-AS-MUTUAL-RECORD partial + audit 정책 적용 (`outcome=partial`, 실패 측 = sender).

- **E3. 메모리 흡수 중 수신 에이전트 종료** → I-AS-MUTUAL-RECORD 의 partial + audit 정책 적용. 발신 에이전트 단독 기록 유지 + audit `outcome=partial` + 실패 측 식별자 기록. 재시작 회복(`session.md I16 재시작 회복 S4 패턴`) 시도하되, 회복 불가 시 partial 상태가 영속된다 (시간 경과 후 자동 재시도 정책은 KG-35 후속).

- **E4. risky 세션의 사전 승인 대기 중 timeout** → 사용자 무응답 시 정책에 따라 자동 거부 또는 대기 유지. 자동 거부 시 세션 생성 차단 + audit 기록. 구체 timeout 값은 후속 phase.

- **E5. abort 신호 전달 중 세션 완료** → abort 와 정상 완료가 경합할 경우, 먼저 도달한 결과로 확정. `markCompleted` / `markFailed` 의 boolean race 방어(`data-persistence.md I13 markCompleted/markExpired race 방어`) 패턴 준용.

- **E6. 동일 에이전트 쌍 간 동시 복수 세션** → 허용되나 I-AS-SESSION-QUOTA 상한 적용. 각 세션은 독립 세션 ID 를 가진다.

- **E7. IFC 위반 정보 흐름 시도** → IFC 정책 구체 정의 전까지는 audit 기록만 남기고 허용. IFC 정책 정의 후 차단으로 전환 — KG-32 참조.

- **E8. 활성 세션 한도 초과 요청** → `STATUS.PENDING` 또는 즉시 거부. Cedar quota 정책 결과에 따름. 정책 미정의 상태에서는 거부(fail-closed).

- **E9. 사후 검토 게이트 만료** → 운영자 설정 기간 경과 후 미검토 상태이면 `expiryAction` 에 따라 처리. `discard` 면 메모리 미흡수 + audit `outcome=expired-discarded`. `absorb` 면 흡수 진행 + audit `outcome=expired-absorbed` (`reviewed=false` 명시). 만료 처리 자체는 lifecycle 이벤트로 audit 에 기록 (I-AS-AUDIT 적용).

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
| I-AS-WIRE-PROTECTION | (미커버) ⚠️ 외부→내부 직접 호출 경로 부재 정적 회귀 필요 |
| I-AS-RESPONSE-MODE | (미커버) ⚠️ 모드 전환 사용자 명시 행위 강제 + whisper audit 미기록 검증 필요 |
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

### KG-33 (메모리 흡수 전 검토 게이트의 위험 영역 정의 + 만료 정책 구체값 미정)

- 내용:
  - "risky 영역" 트리거 조건 미정 (현재 추상적).
  - hybrid 정책의 만료 기간 (`expiryDays`) 기본값 미정.
  - 만료 동작 (`expiryAction`) 기본값 미정 (`discard` 권장 vs `absorb` 권장 결정 필요).
  - config.md schema 반영 미완.
- 범위: 별도 phase.
- 위치: 본 문서 "메모리 흡수" §사후 검토 게이트 + "경계 조건" E9.

### KG-34 (세션 lifecycle event audit JSONL 형식 미정)

- 내용: audit 기록의 JSONL schema 미정의. 어떤 필드를 필수로 가질지, lifecycle 이벤트 유형 enum 이 무엇인지 미결정.
- 범위: 별도 phase.
- 위치: 본 문서 불변식 I-AS-AUDIT.

### KG-35 (메모리 흡수 데이터 schema 미정)

- 내용: 만남 흡수 시 mem0 에 저장되는 데이터의 구체 schema 미정. requestSummary/responseSummary 의 형식, 요약 vs 전체 저장 정책 미결정.
- 범위: 별도 phase.
- 위치: 본 문서 "메모리 흡수" 섹션.

### KG-37-PEER (Phase 3 peer 식별 한계) (resolved) {#peer-identification}

- 내용: A2A Phase 3 의 a2a-router 는 peer card exchange 가 미구현이므로 `peerAgentId = JWT sub (caller)` 를 임시 채택한다. JWT sub 는 user-level 식별자이므로, 실제 호출하는 측의 에이전트(예: `bob/echo`)가 caller user 의 에이전트 중 어느 것인지 router 단계에서 구분할 수 없다.
- Phase 4 에서 `a2a-protocol.md` 의 peer card exchange 가 도입되면 peer 의 agentId 로 교체.
- 범위: A2A Phase 4 (peer card exchange 구현 시점).
- 위치: `packages/server/src/server/a2a-router.js` `mountInvokeRoute` — Phase 3 한계 주석 참조.

#### Phase 4 closing note (self-A2A scope 한정)

Phase 4 (commits 8d69036, 7d0332a 등) 가 JWT agentId claim 도입 + a2a-router 검증 5단 + Phase 3 closed-row 안전망으로 router 측 peer 식별 한계를 해소했다.

검증 5단 요약:
- V1: agentId claim 필수 (strict)
- V2: assertValidAgentId 형식 검증 (caller)
- V3: JWT sub / agentId user prefix 일치 (defense-in-depth sanity check)
- V4: caller agentId 가 agentRegistry 등록 확인
- V5: self-call 금지 (callerAgentId === callee → 400)
- Phase 3 user-level closed-row 우회 차단 (best-effort fallback safety net)
- V2-CALLEE: URL path callee agentId 도 assertValidAgentId 검증 (V5 raw === 정확성 근거)

그 결과 `peerAgentId` 가 user-level 식별자(`alice`)에서 실제 caller agent 식별자(`alice/echo`)로 교체되었다.

**단, 본 resolution 은 self-A2A scope 한정이다.** caller/callee 가 같은 머신, 같은 secret 의 agentRegistry 를 공유하는 환경에서만 V4 (registry 등록 검증) 가 성립한다. cross-machine A2A 도입 시 V4 가 깨지므로, 그 시점에 peer key registry 또는 caller self-card endpoint fetch 등 별도 설계가 필요하다. 해당 설계는 본 KG-37-PEER 의 범위 밖이며 신규 KG 로 다루지 않고 cross-machine A2A phase 의 선결 조건으로 인식한다.

### KG-36 (활성 세션 한도 + 동시 만남 한도 미정의)

- 내용:
  - **활성 세션(관계) 한도**: `A2A.SESSION_QUOTA` 상수 값 미정의. Cedar quota 정책 파일(`10-a2a-quota.cedar` 등) 미작성. 초과 시 PENDING vs 즉시 거부 정책 미결정.
    - 활성 세션 수 = 관계 맺은 상대 에이전트 수 (세션이 1:1 고정 영속이므로).
  - **동시 만남(request/response 페어) 한도**: 별도 quota 필요 여부 미결정. 한 세션 내에서 동시에 진행 가능한 만남 수 상한이 필요한지 후속 phase 에서 결정.
- 범위: 별도 phase.
- 위치: 본 문서 "활성 세션 한도 + 동시 만남 한도" 섹션.

---

## 관련 코드

- `packages/infra/src/infra/sessions/ephemeral-session.js` — A2A 만남 런타임 컨텍스트 (SESSION_TYPE.agent). 만남 단위 휘발성 컨텍스트 — 영속 관계 컨테이너는 A2aRelationshipStore 가 분담 (`data-persistence.md I8`)
- `packages/infra/src/infra/sessions/session-manager.js` — findAgentSession / findSenderSession (`session.md I16`)
- `packages/infra/src/infra/a2a/a2a-queue-store.js` — 비동기 큐 backend. 만남 단위 메시지 큐 (`data-persistence.md I13`)
- `packages/infra/src/infra/a2a/a2a-relationship-store.js` — 영속 관계 컨테이너 메타 store (KG-37 resolved). composite PK (local_agent_id, peer_agent_id) 1:1 고정. upsertOnFirstMeeting / recordMeeting / closeRelationship / refreshCards.
- `packages/infra/src/infra/a2a/a2a-response-dispatcher.js` — response 전달 + drain
- `packages/server/src/server/a2a-router.js` — A2A JSON-RPC 라우터. POST `/a2a/:userId/:agentName` 의 카드 교환 게이트: A2A Phase 3 — canStartA2aSession allow → upsertOnFirstMeeting → recordMeeting 순서로 관계 컨테이너 wiring. Phase 3 한계는 Phase 4 commits (8d69036, 7d0332a 등) 에서 해소 (self-A2A scope 한정) — `§KG-37-PEER` closing note 참조.
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

- 2026-05-05: KG-37-PEER resolved (self-A2A scope 한정) — Phase 4 (JWT agentId claim + V1~V5 검증 + Phase 3 closed-row 안전망). §peer-identification closing note 추가. a2a-router.js 항목 cross-link 갱신.
- 2026-05-03: 초기 작성 — A2A 멀티 인스턴스 phase 진입 전 1차 의미론 못 박기. ontology §A2A 세 결정(공유 컨텍스트/IFC/만남의 누적) 코드 계약 변환. 6 Known Gap 자리 마련 (KG-AS-TRUST / IFC / REVIEW-GATE / AUDIT-FORMAT / MEMORY-SCHEMA / QUOTA).
- 2026-05-05: KG-37-PEER 섹션 추가 (§peer-identification) — a2a-router.js 코드 코멘트의 cross-link drift 해소. Phase 3 peerAgentId = JWT caller 임시 채택 한계 명시.
- 2026-05-03: KG-31~KG-36 정식 ID 부여 (REGISTRY 등록 완료).
- 2026-05-05: I-AS-AUTH Cedar action 확정 — start_a2a_session 신규 도입 (옵션 B). 일반 access_agent 와 분리해 운영자가 A2A 정책을 별도 표현 가능.
- 2026-05-05: I-AS-MUTUAL-RECORD 양방향 흡수 실패 정책 확정 — partial + audit (옵션 c). 종료 지연(a)/롤백(b) 모두 기각. 비대칭 발생 가시화 의무 명시.
- 2026-05-05: 사후 검토 게이트 UX 확정 — (c) 기본 + (b) 만료 안전망 hybrid. 만료 동작 (discard/absorb) 과 기간 (expiryDays) 은 운영자 설정으로 위임. 구체값/기본값은 KG-33 후속.
- 2026-05-05: A2A 의미론 핵심 재정의 — 세션 = 두 에이전트 쌍의 영속 관계 컨테이너 (1:1 고정), 만남 = request/response 페어. 세션 라이프사이클 / 만남 라이프사이클 두 결로 분리. 종료 정책 (close/clear/summarize + 스트리밍 inactivity), 공유 컨텍스트 = 사용자 세션 결 재사용 (I-AS-CONTEXT-REUSE) 확정. KG-36 활성 세션 한도 + 동시 만남 한도 두 결로 확장. 개입 6결 매트릭스 사후 검토 행 표기 갱신 (c+b hybrid 명시). agent-identity / data-persistence / session 정합성 점검 동반.
- 2026-05-05: A2A 운영 흐름 (카드 교환 → 큐 적재 → heartbeat 디스패치 → 응답) narrative 추가. 응답 모드 4 결 (agent-default / user-takeover / user-via-agent / user-with-whisper) + I-AS-RESPONSE-MODE 신규. 귓속말 wire = IFC 첫 구체 사례 (휘발성 — audit/memory 미기록). I-AS-WIRE-PROTECTION 신규 (heartbeat+큐 보호막). 어제 결정 3 건 모델 B 위 정합 재표현: I-AS-AUTH §A2A 운영 흐름 단계 1 cross-reference, I-AS-MUTUAL-RECORD "만남 단위" 흡수 및 세션 연속성 명시, 사후 검토 게이트 "세션 내 미검토 만남 큐 누적" 모델로 재표현.
- 2026-05-05: KG-37 resolved 반영 — A2aRelationshipStore (Phase 2) + a2a-router 카드 교환 게이트 (Phase 3) 통합. 만남 단위 lifecycle (A2aQueueStore) 와 관계 단위 lifecycle (A2aRelationshipStore) 의 두 저장 계층 분리. §관련 코드에 a2a-relationship-store.js 신규 + a2a-router.js Phase 3 카드 교환 게이트 cross-reference + ephemeral-session.js 갭 표기 갱신.
