# 정책 관리 (운영자 전용)

이 문서는 서버를 운영하는 **관리자(admin)** 를 위한 안내입니다. 일반 사용자는 이 기능을 사용하지 않아도 됩니다.

---

## 이 기능은 무엇인가요?

정책(policy)은 "누가 무엇을 할 수 있는가"를 결정하는 규칙 파일입니다. 예를 들어 특정 사용자의 에이전트 추가를 막거나, 특정 행동을 모두에게 금지할 때 정책 파일을 작성합니다.

**이 기능을 쓰면:**
- 서버를 껐다 켜지 않아도 정책 변경 사항을 즉시 적용할 수 있습니다.
- 정책 파일을 저장하기 전에 문법 오류를 미리 검사할 수 있습니다.
- 현재 어떤 정책이 활성화되어 있는지 한눈에 볼 수 있습니다.

---

## 준비 사항: admin 토큰 발급

정책 리로드(즉시 반영)는 admin 계정으로 로그인한 뒤 받은 **access token** 이 필요합니다.

### 1단계. admin 계정으로 로그인

터미널에서 아래 명령을 실행합니다. (서버가 `http://localhost:3000` 에서 실행 중이어야 합니다.)

```bash
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"비밀번호"}'
```

성공하면 아래와 같은 응답이 옵니다:

```
{
  "accessToken": "eyJhbGciOi...(긴 문자열)...",
  "refreshToken": "...",
  ...
}
```

### 2단계. 토큰을 환경 변수에 저장

응답에서 `accessToken` 값을 복사해 아래 명령어의 따옴표 안에 붙여넣습니다.

```bash
export PRESENCE_ADMIN_TOKEN="여기에_accessToken_붙여넣기"
```

> **주의:** 이 토큰은 터미널을 닫으면 사라집니다. 세션마다 다시 발급해야 합니다.
>
> **보안 주의:** 토큰을 환경 변수로 설정하면 같은 컴퓨터에서 실행 중인 다른 프로그램이 프로세스 목록을 조회할 때 토큰이 노출될 수 있습니다. 신뢰할 수 있는 환경에서만 사용하세요.

서버 주소가 다르다면 `PRESENCE_SERVER_URL` 도 설정합니다:

```bash
export PRESENCE_SERVER_URL="http://서버주소:포트"
```

---

## 정책 파일 작성 위치

운영자가 직접 추가하는 정책 파일은 아래 폴더에 저장합니다:

```
~/.presence/cedar/policies/
```

파일 이름은 반드시 `50-` 으로 시작해야 합니다. 예:

```
50-block-external-user.cedar
50-team-restriction.cedar
```

> **참고:** 시스템 기본 정책(00-, 10-, 11-, 20-, 30-, 31-)은 건드리지 않아도 됩니다. 운영자 전용 슬롯은 `50-` 번대입니다.

---

## 정책 파일 검증 (lint)

정책 파일을 서버에 적용하기 **전에** 반드시 문법과 형식을 검사하세요. 오류가 있는 파일을 리로드하면 전체 리로드가 실패하고 기존 정책이 그대로 유지됩니다.

```bash
npm run user -- policy lint --file ~/.presence/cedar/policies/50-block-user.cedar
```

**검사 통과 시 화면:**

```
OK: /home/admin/.presence/cedar/policies/50-block-user.cedar
```

**오류 발견 시 화면 (예시):**

```
Parse error: /home/admin/.presence/cedar/policies/50-block-user.cedar
  unexpected token at line 3
```

오류 메시지를 보고 파일을 수정한 뒤 다시 lint 를 실행합니다. OK 가 나올 때까지 반복합니다.

---

## 활성 정책 목록 확인 (list)

현재 어떤 정책 파일이 로드되어 있는지 확인합니다:

```bash
npm run user -- policy list
```

**화면 예시:**

```
filename              category    size
--------------------  ----------  ----
00-base               base        312 B
10-quota              quota       189 B
11-admin-limit        admin       145 B
20-archived           archived    203 B
30-protect-admin      protect     167 B
31-protect-persona    protect     178 B
50-block-user         operator    221 B
```

`category` 열은 파일 이름 앞자리에 따라 자동으로 분류됩니다:

| 앞자리 | 분류 | 의미 |
|--------|------|------|
| 00- | base | 기본 허용 규칙 |
| 10-, 11- | quota / admin | 사용 한도 규칙 |
| 20- | archived | 비활성 에이전트 접근 제한 |
| 30-, 31- | protect | 시스템 보호 규칙 |
| 50- | operator | 운영자가 추가한 규칙 |

---

## 정책 변경 즉시 반영 (reload)

정책 파일을 수정하거나 새로 추가한 뒤, 서버를 재시작하지 않고 바로 적용하려면 아래 명령을 실행합니다.

`PRESENCE_ADMIN_TOKEN` 환경 변수가 설정된 상태여야 합니다 (위의 준비 사항 참고).

```bash
npm run user -- policy reload
```

**성공 시 화면:**

```
OK: 정책 reload 성공. version=2
     reloadStartedAt=2026-04-29T10:30:00.000Z reloadedAt=2026-04-29T10:30:00.123Z
Tip: 자기 reload 가 새로 시작됐는지 확인하려면 명시적 두 번째 호출 후 reloadStartedAt 변화 관찰.
Tip: 변경 적용 전 lint 권장 — npm run user -- policy lint --file <path>
```

`version=2` 처럼 숫자가 올라가면 새 정책이 반영된 것입니다.

> **진행 중인 대화에도 즉시 적용됩니다.** 서버에서 현재 대화 중인 사용자들도 리로드 이후 다음 요청부터 새 정책을 적용받습니다.

**실패 시 화면:**

```
policy reload 실패: 정책 파일 파싱 오류 ...
  활성 정책: version=1 reloadedAt=2026-04-29T10:00:00.000Z
이전 정책이 유지됩니다 (fail-safe rollback — 메모리 내 evaluator 미교체).
디스크 정책 파일 상태는 변경되지 않음 — 운영자가 별도 정정 필요.
```

실패해도 **기존 정책이 그대로 유지됩니다.** 당황하지 말고 오류 내용을 확인한 뒤 정책 파일을 수정하고 lint 를 통과시킨 다음 다시 시도합니다.

---

## 운영 시나리오: 새 정책 추가하기

다음은 실제 운영에서 따르는 순서입니다:

**1. 정책 파일 작성**

```bash
nano ~/.presence/cedar/policies/50-block-testuser.cedar
```

**2. 문법 검사**

```bash
npm run user -- policy lint --file ~/.presence/cedar/policies/50-block-testuser.cedar
```

OK 가 나올 때까지 수정합니다.

**3. 현재 정책 목록 확인** (선택사항)

```bash
npm run user -- policy list
```

**4. 정책 즉시 반영**

```bash
npm run user -- policy reload
```

`version` 번호가 올라갔으면 성공입니다.

**5. 적용 확인** (선택사항 — REST API 직접 확인)

```bash
curl -s http://localhost:3000/api/admin/policy/version \
  -H "Authorization: Bearer $PRESENCE_ADMIN_TOKEN"
```

응답 예시:

```json
{ "version": 2, "reloadedAt": "2026-04-29T10:30:00.123Z" }
```

---

## 문제가 생기면

### "policy reload: admin access token 필요." 라고 나옵니다

`PRESENCE_ADMIN_TOKEN` 환경 변수가 설정되지 않은 상태입니다. 위의 [준비 사항](#준비-사항-admin-토큰-발급) 을 다시 따라합니다.

### "policy reload: 서버 도달 실패" 라고 나옵니다

서버가 꺼져 있거나 주소가 틀렸습니다.
- 서버 실행: `npm start`
- 주소가 다르면: `export PRESENCE_SERVER_URL="http://올바른주소:포트"`

### "권한 없음 (HTTP 401 또는 403)" 라고 나옵니다

- 토큰이 만료됐습니다 (access token 유효 시간은 짧습니다). 다시 로그인해서 새 토큰을 발급받으세요.
- admin 계정으로 로그인했는지 확인합니다.

### reload 에 성공했는데 정책이 적용 안 된 것 같습니다

- `version` 번호를 확인합니다. reload 전후로 번호가 올라갔다면 반영된 것입니다.
- 정책 파일이 올바른 위치 (`~/.presence/cedar/policies/50-*.cedar`) 에 있는지 확인합니다.
- `policy list` 로 해당 파일이 목록에 나타나는지 확인합니다.

### 어떤 결정이 내려졌는지 기록을 보고 싶습니다

모든 접근 허용/거부 기록은 아래 파일에 남습니다:

```
~/.presence/logs/authz-audit.log
```

각 줄은 JSON 형식이며, `policyVersion` 필드로 어떤 정책 버전에서 결정이 내려졌는지 확인할 수 있습니다.

---

## 관련 기능

- [에이전트 승인 관리](./getting-started.md) — admin 이 pending 상태 에이전트를 승인/거부하는 방법

---

## 현재 한계 및 향후 개선 계획

현재 이 가이드와 TUI 가 아직 제공하지 못하는 부분입니다. 불편하더라도 아래 우회 방법을 참고하세요.

### Cedar 정책 문법 예시 부재 (FP-78)

`50-*.cedar` 파일을 처음 작성할 때 어떤 문법을 써야 하는지, presence 스키마의 어떤 항목을 쓸 수 있는지 안내가 없습니다.

**현재 우회 방법:**
- `policy lint` 로 문법 오류를 먼저 잡습니다.
- Cedar 공식 문서(https://docs.cedarpolicy.com)를 참고해 기본 문법을 익힙니다.

**향후 계획:** 별도 Cedar 정책 작성 가이드(문법 입문, presence 스키마 매핑, `block-user` / `restrict-archive` / `quota-override` 등 실전 예시 4~5개 포함)를 추가할 예정입니다.

### TUI 에서 정책 버전 확인 불가 (FP-79)

현재 정책 버전을 확인하려면 CLI 명령 또는 REST API 를 직접 호출해야 합니다. TUI 화면에서 바로 볼 수 없습니다.

**현재 우회 방법:**
```bash
curl -s http://localhost:3000/api/admin/policy/version \
  -H "Authorization: Bearer $PRESENCE_ADMIN_TOKEN"
```

**향후 계획:** TUI StatusBar 또는 `/admin status` 슬래시 명령에 정책 버전을 표시하고, 정책이 리로드되면 화면이 자동으로 갱신되도록 개선할 예정입니다.
