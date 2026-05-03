# Cedar 정책 작성 가이드 (운영자 전용)

이 문서는 `50-*.cedar` 정책 파일을 직접 작성하거나 수정하려는 **운영자(admin)** 를 위한 안내입니다. 일반 사용자는 이 파일을 다룰 필요가 없습니다.

---

## 1. 개요 — 정책 파일이 왜 필요한가요?

presence 는 "누가 무엇을 할 수 있는가"를 규칙 파일로 관리합니다. 이 규칙 파일을 **Cedar 정책**이라고 부릅니다.

시스템은 기본 정책을 미리 탑재하고 있어서, 대부분의 상황에서는 별도 설정 없이도 작동합니다. 예를 들어 "에이전트를 너무 많이 만들면 막기", "이미 보관(archived)된 에이전트는 새로 시작할 수 없게 막기" 같은 규칙이 이미 들어 있습니다.

그런데 가끔은 운영자가 직접 추가 규칙을 만들어야 할 때가 있습니다. 예를 들어:
- 특정 사용자가 더 이상 에이전트를 쓸 수 없게 막고 싶을 때
- 특정 에이전트를 다른 사람이 열지 못하게 잠그고 싶을 때
- 기본보다 더 엄격한 제한을 걸고 싶을 때

이럴 때 `50-*.cedar` 파일을 만들어 `~/.presence/cedar/policies/` 폴더에 넣으면 됩니다.

**운영자만 이 파일을 다룹니다.** 일반 사용자는 이 폴더에 접근하지 않습니다.

---

## 2. 언제 직접 정책 파일을 써야 하나요?

### 기본 정책으로 충분한 경우 (추가 파일 불필요)

- 에이전트 최대 개수 제한 (이미 설정 파일에서 `maxAgents` 값으로 조정 가능)
- 보관된 에이전트 새로 시작 금지
- admin 계정의 에이전트는 다른 사람이 삭제/변경 못 하게 보호

이런 경우는 기본 정책이 이미 처리하므로 파일을 따로 만들 필요가 없습니다.

### 추가 파일이 필요한 경우

| 상황 | 필요한 이유 |
|------|-------------|
| 특정 사용자를 모든 에이전트에서 차단 | 기본 정책에 "특정 사람 차단" 규칙 없음 |
| 특정 에이전트를 소유자 외 접근 금지 | 기본 정책은 소유자 여부를 체크하지 않음 |
| 보관된 에이전트 접속 조차 완전 금지 | 기본 정책은 "대화 이어가기"는 허용 |
| 전체 사용자의 에이전트 개수를 더 엄격하게 제한 | 기본 정책의 한도는 설정 파일 기준 |

---

## 3. 시작하기 전에

### 파일 위치

추가 정책 파일은 반드시 다음 위치에 저장합니다:

```
~/.presence/cedar/policies/
```

### 파일 이름 규칙

파일 이름은 반드시 `50-` 으로 시작해야 합니다. 예:

```
50-block-user.cedar
50-restrict-agent.cedar
50-tighter-quota.cedar
```

숫자 `50-`은 "운영자 추가 규칙 구역"을 뜻합니다. 다른 번호(예: `00-`, `10-`)는 시스템 기본 정책이 쓰므로 건드리지 않습니다.

### admin 로그인 상태 확인

파일을 저장한 후 정책을 적용하려면 admin 로그인이 필요합니다. 로그인 방법은 [정책 관리 가이드 — 준비 사항](./admin-policy-management.md#준비-사항-admin-로그인) 을 참고하세요.

---

## 4. Cedar 문법 입문

Cedar 정책 파일은 읽기 쉬운 영어 문장처럼 생겼습니다. 핵심 개념은 세 가지입니다.

### 4-1. permit vs forbid

```cedar
permit ( ... );   // 이 조건이면 허용
forbid ( ... );   // 이 조건이면 차단
```

**중요:** `forbid` 가 `permit` 보다 항상 우선합니다. 둘 다 해당되면 무조건 차단됩니다.

presence 시스템은 "기본 허용" 규칙을 이미 탑재하고 있으므로, 운영자가 추가하는 규칙은 대부분 `forbid` 입니다. `permit` 을 새로 추가해도 기본 규칙이 이미 허용하고 있어서 의미가 없습니다.

### 4-2. principal / action / resource — 규칙의 세 요소

모든 Cedar 정책은 이 세 가지를 지정합니다:

```cedar
forbid (
  principal is LocalUser,    // 누가
  action == Action::"...",   // 무엇을 하려 할 때
  resource is Agent          // 어떤 대상에 대해
);
```

| 요소 | 의미 | 예시 |
|------|------|------|
| `principal` | 행동하는 사람 (사용자) | `LocalUser::"alice"`, `is LocalUser` |
| `action` | 하려는 행동 | `Action::"access_agent"` |
| `resource` | 행동의 대상 | `Agent::"bob/secret"`, `is Agent` |

### 4-3. when / unless — 조건 추가

`when` 은 "이 조건일 때" 규칙을 적용합니다. `unless` 는 "이 조건이 아닐 때" 적용합니다.

```cedar
forbid ( ... ) when   { context.archived };          // 보관 상태일 때 차단
forbid ( ... ) unless { principal == LocalUser::"bob" };  // bob 이 아닐 때 차단
```

### 4-4. context 접근

행동이 일어날 때 시스템이 전달하는 추가 정보(context)를 조건에 쓸 수 있습니다.

```cedar
when { context.isAdmin }           // context 의 isAdmin 이 true 일 때
when { context.currentCount >= 5 } // 에이전트 개수가 5 이상일 때
```

context 에 어떤 필드가 있는지는 아래 섹션 5 에서 설명합니다.

### 4-5. 특정 사람/에이전트 지정

특정 대상을 정확히 지정할 때는 큰따옴표 안에 이름을 씁니다:

```cedar
principal == LocalUser::"alice"      // alice 라는 이름의 사용자
resource  == Agent::"bob/secret"     // bob 의 secret 이라는 에이전트
```

`LocalUser::"alice"` 에서 `alice` 는 시스템에 등록된 정확한 사용자 이름입니다. 대소문자도 정확히 맞아야 합니다.

---

## 5. presence 스키마 매핑

Cedar 정책을 쓸 때 presence 시스템에서 쓸 수 있는 항목은 다음과 같습니다.

### Entity (대상 종류)

| 이름 | 의미 |
|------|------|
| `LocalUser` | presence 에 등록된 사용자. `id` (사용자 이름), `role` ("admin" 또는 일반) 속성을 가짐 |
| `User` | 에이전트 소유자 단위 (create_agent 의 대상) |
| `Agent` | 에이전트 하나하나. `id` 는 "소유자/에이전트이름" 형식 |

### Action (행동 종류)

| 행동 | 의미 |
|------|------|
| `Action::"create_agent"` | 새 에이전트 만들기 |
| `Action::"access_agent"` | 에이전트 열기 / 접속 |
| `Action::"archive_agent"` | 에이전트 보관 처리 |
| `Action::"set_persona"` | 에이전트 페르소나(성격/역할) 설정 |

### Context 필드 (행동별 추가 정보)

**create_agent 를 쓸 때:**

| 필드 | 타입 | 의미 |
|------|------|------|
| `context.currentCount` | 숫자 | 현재 사용자가 가진 에이전트 수 |
| `context.maxAgents` | 숫자 | 설정된 에이전트 최대 허용 수 |
| `context.isAdmin` | 참/거짓 | 요청자가 admin 인지 여부 |
| `context.hardLimit` | 숫자 | admin 포함 절대 상한선 |

**access_agent 를 쓸 때:**

| 필드 | 타입 | 의미 |
|------|------|------|
| `context.intent` | 문자열 | 접속 목적 (`"continue-session"` 등) |
| `context.archived` | 참/거짓 | 에이전트가 보관 상태인지 여부 |

**archive_agent, set_persona 를 쓸 때:**

| 필드 | 타입 | 의미 |
|------|------|------|
| `context.isAdmin` | 참/거짓 | 요청자가 admin 인지 여부 |
| `context.reservedOwner` | 참/거짓 | admin 전용으로 보호된 에이전트인지 여부 |

---

## 6. 실전 예시 4가지

각 예시는 파일 전체를 그대로 복사해서 쓸 수 있습니다. 저장 후 lint 검사와 즉시 반영 절차를 따라 주세요.

---

### 예시 1 — 특정 사용자 전체 차단

**상황:** `alice` 라는 사용자가 어떤 에이전트도 열지 못하게 막고 싶습니다.

**파일:** `~/.presence/cedar/policies/50-block-user.cedar`

```cedar
forbid (
  principal == LocalUser::"alice",
  action == Action::"access_agent",
  resource is Agent
);
```

**줄별 설명:**
- `principal == LocalUser::"alice"` — alice 라는 사용자가
- `action == Action::"access_agent"` — 에이전트를 열려고 할 때
- `resource is Agent` — 대상이 어떤 에이전트든 상관없이 차단

**저장 후 검사:**
```bash
npm run user -- policy lint --file ~/.presence/cedar/policies/50-block-user.cedar
```

**즉시 반영:**
```bash
npm run user -- policy reload
```

---

### 예시 2 — 특정 에이전트를 소유자 외 차단

**상황:** `bob` 의 `secret` 이라는 에이전트를 bob 본인만 열 수 있게 하고, 다른 사람은 차단하고 싶습니다.

**파일:** `~/.presence/cedar/policies/50-restrict-agent.cedar`

```cedar
forbid (
  principal is LocalUser,
  action == Action::"access_agent",
  resource == Agent::"bob/secret"
) unless { principal == LocalUser::"bob" };
```

**줄별 설명:**
- `principal is LocalUser` — 사용자라면 누구든
- `action == Action::"access_agent"` — 에이전트를 열려고 할 때
- `resource == Agent::"bob/secret"` — 대상이 bob 의 secret 에이전트이면 차단
- `unless { principal == LocalUser::"bob" }` — 단, 요청자가 bob 자신이면 이 규칙 적용 안 함

**저장 후 검사:**
```bash
npm run user -- policy lint --file ~/.presence/cedar/policies/50-restrict-agent.cedar
```

**즉시 반영:**
```bash
npm run user -- policy reload
```

---

### 예시 3 — 보관된 에이전트 접속 완전 차단

**상황:** 기본 정책은 보관된 에이전트라도 "대화 이어가기" 목적은 허용합니다. 이를 더 엄격하게 적용해서, 보관된 에이전트는 어떤 목적으로도 열지 못하게 막고 싶습니다.

**파일:** `~/.presence/cedar/policies/50-archived-strict.cedar`

```cedar
forbid (
  principal is LocalUser,
  action == Action::"access_agent",
  resource is Agent
) when { context.archived };
```

**줄별 설명:**
- `principal is LocalUser` — 사용자라면 누구든
- `action == Action::"access_agent"` — 에이전트를 열려고 할 때
- `resource is Agent` — 어떤 에이전트든
- `when { context.archived }` — 단, 그 에이전트가 보관 상태일 때만 차단

**저장 후 검사:**
```bash
npm run user -- policy lint --file ~/.presence/cedar/policies/50-archived-strict.cedar
```

**즉시 반영:**
```bash
npm run user -- policy reload
```

---

### 예시 4 — 에이전트 개수 더 엄격하게 제한

**상황:** 기본 설정의 `maxAgents` 값과 무관하게, 일반 사용자는 에이전트를 최대 5개까지만 만들 수 있게 제한하고 싶습니다. admin 은 제한 없이 만들 수 있어야 합니다.

**파일:** `~/.presence/cedar/policies/50-tighter-quota.cedar`

```cedar
forbid (
  principal is LocalUser,
  action == Action::"create_agent",
  resource is User
) when { !context.isAdmin && context.currentCount >= 5 };
```

**줄별 설명:**
- `principal is LocalUser` — 사용자라면 누구든
- `action == Action::"create_agent"` — 에이전트를 새로 만들려 할 때
- `resource is User` — 소유자 단위에 대한 행동이면
- `when { !context.isAdmin && context.currentCount >= 5 }` — admin 이 아니고, 이미 5개 이상 가지고 있으면 차단

**저장 후 검사:**
```bash
npm run user -- policy lint --file ~/.presence/cedar/policies/50-tighter-quota.cedar
```

**즉시 반영:**
```bash
npm run user -- policy reload
```

---

## 7. 흔한 함정

### permit 을 추가해도 달라지지 않습니다

```cedar
// 이 규칙은 아무 의미가 없습니다
permit (
  principal is LocalUser,
  action == Action::"access_agent",
  resource is Agent
);
```

시스템 기본 정책이 이미 모든 사용자의 에이전트 접속을 허용하고 있습니다. `permit` 을 더 추가해도 결과가 달라지지 않습니다. 운영자가 추가하는 파일은 거의 항상 `forbid` 입니다.

### 사용자 이름은 정확히 일치해야 합니다

```cedar
// 잘못된 예 — 대소문자가 틀릴 경우
principal == LocalUser::"Alice"   // 실제 이름이 alice 면 작동 안 함

// 올바른 예
principal == LocalUser::"alice"
```

시스템에 등록된 정확한 사용자 이름을 써야 합니다. 대소문자도 구분합니다.

### context 필드는 행동별로 다릅니다

`context.isAdmin` 은 `create_agent`, `archive_agent`, `set_persona` 에서만 쓸 수 있습니다. `access_agent` 에서 `context.isAdmin` 을 쓰면 lint 에서 오류가 납니다.

각 행동별 사용 가능한 context 필드는 위 섹션 5 를 확인하세요.

### `50-` 외 번호는 쓰지 않습니다

운영자 추가 정책 파일은 반드시 `50-` 으로 시작합니다. `00-`, `10-`, `20-` 구간은 시스템 기본 정책이 차지하고 있습니다. 그 구간에 파일을 넣으면 예상치 못한 동작이 생길 수 있습니다.

---

## 8. 검증 절차

정책 파일을 만든 뒤에는 반드시 다음 순서로 검증합니다.

### 1단계 — 문법 검사 (lint)

```bash
npm run user -- policy lint --file ~/.presence/cedar/policies/50-my-policy.cedar
```

오류가 없으면:
```
정책 파일 검사 완료. 문법 오류 없음.
```

오류가 있으면 어느 줄이 문제인지 표시됩니다. 수정 후 다시 실행합니다.

### 2단계 — 즉시 반영 (reload)

```bash
npm run user -- policy reload
```

성공하면:
```
정책 버전 N 적용 완료.
시작: 2026-05-01T10:00:00.000Z
완료: 2026-05-01T10:00:00.012Z
```

이미 접속 중인 사용자에게도 곧바로 새 규칙이 적용됩니다.

### 3단계 — 버전 확인

```bash
npm run user -- policy version
```

reload 후 버전 번호가 1 올라갔는지 확인합니다.

자세한 내용은 [정책 관리 가이드 — 정책 버전 확인](./admin-policy-management.md#정책-버전-확인) 을 참고하세요.

---

## 9. 문제 해결

### lint 에서 오류가 납니다

오류 메시지를 그대로 읽으면 어느 줄이 문제인지 알 수 있습니다. 흔한 원인:

| 증상 | 원인 | 해결 |
|------|------|------|
| `unknown attribute` | context 필드 이름이 틀렸거나 해당 action 에 없는 필드를 씀 | 섹션 5 의 행동별 context 필드 확인 |
| `expected ;` | 줄 끝의 세미콜론(`;`) 누락 | 닫는 괄호 뒤에 `;` 추가 |
| `unexpected token` | 문법 오류 (따옴표, 괄호 짝 불일치 등) | 열린 `(` 와 닫힌 `)` 가 맞는지 확인 |

### reload 가 실패했습니다

reload 가 실패해도 **이전 정책은 그대로 유지됩니다.** 서버가 잘못된 정책을 적용하는 일은 없습니다.

실패 메시지가 나오면:
1. `policy lint` 로 파일을 다시 검사합니다 (lint 는 통과했지만 reload 실패 시 서버 로그 확인 필요)
2. 파일 위치가 `~/.presence/cedar/policies/50-*.cedar` 인지 확인합니다
3. admin 로그인 상태인지 확인합니다 (`npm run user -- admin whoami`)

### 정책을 적용했는데 효과가 없어 보입니다

다음을 순서대로 확인합니다:

1. **reload 를 했는가?** 파일을 저장하는 것만으로는 적용되지 않습니다. `policy reload` 명령을 실행해야 합니다.
2. **forbid 를 썼는가?** `permit` 만 추가했다면 기본 정책과 동일하므로 차이가 없습니다.
3. **버전이 올라갔는가?** `policy version` 으로 번호 변화를 확인합니다.
4. **조건이 맞는가?** `when` / `unless` 조건을 다시 검토합니다. 예: `context.currentCount >= 5` 에서 실제 에이전트 수가 5 미만이면 차단되지 않습니다.

### 이전 정책으로 되돌리고 싶습니다

파일을 수정 전 내용으로 되돌린 뒤 `policy reload` 를 다시 실행하면 됩니다. 파일을 아예 삭제한 경우 `git` 이나 백업에서 복원한 뒤 reload 하세요.

---

## 관련 문서

- [정책 관리 가이드](./admin-policy-management.md) — lint / reload / version 명령 상세 안내
- [가이드 진입점](./README.md) — 전체 가이드 목차
