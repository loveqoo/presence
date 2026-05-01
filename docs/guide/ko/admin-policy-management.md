# 정책 관리 (운영자 전용)

이 문서는 서버를 운영하는 **관리자(admin)** 를 위한 안내입니다. 일반 사용자는 이 기능을 사용하지 않아도 됩니다.

---

## 이 기능은 무엇인가요?

정책(policy)은 "누가 무엇을 할 수 있는가"를 결정하는 규칙 파일입니다. 예를 들어 특정 사용자의 에이전트 추가를 막거나, 특정 행동을 모두에게 금지할 때 정책 파일을 작성합니다.

**이 기능을 쓰면:**
- 서버를 껐다 켜지 않아도 정책 변경 사항을 즉시 적용할 수 있습니다.
- 정책 파일을 저장하기 전에 문법 오류를 미리 검사할 수 있습니다.
- 현재 어떤 정책이 활성화되어 있는지, 몇 번 버전이 적용됐는지 한눈에 볼 수 있습니다.

**이 가이드에서 다루는 명령:**

| 명령 | 하는 일 |
|------|---------|
| `policy lint --file <파일>` | 정책 파일 문법 검사 |
| `policy list` | 현재 로드된 정책 파일 목록 확인 |
| `policy reload` | 서버 재시작 없이 정책 즉시 적용 |
| `policy version` | 현재 활성 정책 버전 확인 |

---

## 준비 사항: admin 로그인

정책 리로드(즉시 반영)와 버전 확인은 admin 계정으로 로그인한 상태여야 합니다.

로그인 방법은 두 가지입니다. 일반 운영에는 **1순위(권장)** 방법을 사용하세요.

### 1순위 (권장): admin login 명령으로 1회 로그인

```bash
npm run user -- admin login
```

비밀번호를 입력하면 로그인 정보가 `~/.presence/admin-session.json` 파일에 자동으로 저장됩니다. 이후 `policy reload`, `policy version` 등의 명령을 실행할 때 이 파일을 자동으로 읽으므로, **별도 설정 없이 바로 사용**할 수 있습니다.

**화면 예시:**

```
Password:
Logged in as admin. Saved to /Users/<사용자명>/.presence/admin-session.json (mode 0600).
```

로그인 후 사용할 수 있는 admin 계정 관련 명령:

| 명령 | 하는 일 |
|------|---------|
| `admin login [--username <이름>]` | 1회 로그인 후 파일에 자동 저장 (기본 계정: admin) |
| `admin logout` | 서버 측 인증 무효화 + 저장된 파일 삭제 |
| `admin whoami` | 현재 로그인 상태와 인증 만료 시각 확인 |

> 로그인 정보는 만료 시각이 가까워지면 자동으로 갱신됩니다. 평소에는 신경 쓰지 않아도 됩니다.

#### 처음 로그인할 때 비밀번호 변경 요구가 나오면

새로 만든 admin 계정은 처음 로그인 시 아래 안내가 표시될 수 있습니다:

```
admin login: 비밀번호 변경이 필요합니다 (mustChangePassword=true).
  서버 호스트에서: npm run user -- passwd --username admin
  (passwd 는 로컬 user-store 만 변경하므로 서버가 실행 중인 컴퓨터에서 실행해야 함)
비밀번호 변경 후 다시 admin login 하세요.
```

이 경우 아래 순서로 진행합니다:

1. **서버가 실행 중인 컴퓨터** 에서 비밀번호를 변경합니다:
   ```bash
   npm run user -- passwd --username admin
   ```
2. 새 비밀번호를 입력합니다.
3. 다시 로그인합니다:
   ```bash
   npm run user -- admin login
   ```

#### 동시 실행 자제

admin login 으로 운영 중에는 다음을 지켜주세요:

- 단일 admin 운영자 / 단일 머신을 가정합니다.
- `policy reload` 같은 admin 명령을 두 개 이상의 터미널에서 **동시에 실행하지 마세요.** 내부 인증 갱신이 충돌하면 양쪽 모두 재로그인이 필요해집니다.
- 충돌이 의심되면 `npm run user -- admin login` 으로 다시 로그인하면 자연 복구됩니다.
- 적용 여부가 불확실하면 `npm run user -- policy version` 으로 즉시 확인할 수 있습니다.

---

### 2순위 (CI/자동화 전용): 환경 변수로 토큰 직접 설정

스크립트나 CI 파이프라인처럼 대화형 로그인을 사용할 수 없는 환경에서는 아래 방법을 사용합니다.

> **1순위 방법을 권장합니다.** 환경 변수 방식은 같은 컴퓨터의 다른 프로세스가 프로세스 목록을 조회할 때 토큰이 노출될 수 있습니다. 신뢰할 수 있는 자동화 환경에서만 사용하세요.

**1단계. admin 계정으로 로그인하여 토큰 발급**

```bash
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"비밀번호"}' \
  | jq -r '.accessToken'
```

성공하면 `eyJhbGciOi...` 형태의 토큰 문자열이 출력됩니다.

**2단계. 환경 변수에 저장**

```bash
export PRESENCE_ADMIN_TOKEN="위에서_출력된_토큰"
```

> **주의:** 이 토큰은 터미널을 닫으면 사라집니다. 실행할 때마다 다시 발급해야 합니다.

서버 주소가 기본값(`http://localhost:3000`)과 다르다면 함께 설정합니다:

```bash
export PRESENCE_SERVER_URL="http://서버주소:포트"
```

---

## 토큰 노출 시 대응

`~/.presence/admin-session.json` 에 저장된 인증 정보(refresh token)는 최대 7일간 유효한 자격 증명입니다. 아래 상황이 의심될 때는 즉시 대응하세요:

- 백업 매체나 분실한 장비에 파일이 잔존하는 경우
- 같은 컴퓨터에서 악의적인 프로세스가 실행됐을 가능성이 있는 경우

**대응 순서:**

1. 저장된 인증 무효화 (서버 측 + 로컬 파일 동시 삭제):
   ```bash
   npm run user -- admin logout
   ```
2. 서버 재시작 (서버 메모리에 남은 인증 정보 일괄 초기화):
   ```bash
   # 서버가 실행 중인 컴퓨터에서
   npm start
   ```
3. 백업 매체나 분실 장비에 남은 `~/.presence/admin-session.json` 파일을 직접 삭제합니다.
4. 다시 로그인합니다:
   ```bash
   npm run user -- admin login
   ```

**비밀번호 변경이 필요한 경우:**

```bash
# 서버가 실행 중인 컴퓨터에서
npm run user -- passwd --username admin
```

비밀번호 변경 후에는 기존 로그인 세션이 모두 무효가 되므로 `admin login` 으로 다시 로그인합니다.

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

`admin login` 으로 로그인한 상태여야 합니다 (위의 [준비 사항](#준비-사항-admin-로그인) 참고).

```bash
npm run user -- policy reload
```

**성공 시 화면:**

```
OK: 정책이 적용되었습니다.
  버전: 3
  reload 시작: 2026-04-29T10:00:00.000Z
  적용 완료:   2026-04-29T10:00:00.123Z

참고: 짧은 시간 내 여러 admin 이 동시에 reload 를 요청하면 한 번만 실행됩니다.
      "reload 시작" 시각이 이전 호출과 같으면 기존 reload 에 합류된 것입니다.
      새 reload 를 강제하려면 잠시 후 다시 실행하세요.
```

"버전" 번호가 올라갔으면 새 정책이 반영된 것입니다.

> **진행 중인 대화에도 즉시 적용됩니다.** 서버에서 현재 대화 중인 사용자들도 리로드 이후 다음 요청부터 새 정책을 적용받습니다.

**실패 시 화면:**

```
정책 reload 실패.
원인: <서버 에러>

현재 활성 정책은 그대로 유지됩니다 (버전 2, 적용: 2026-04-29T10:00:00.000Z).
디스크의 정책 파일은 변경되지 않았습니다.

복구 방법:
  1. 문제가 되는 .cedar 파일을 수정하거나 제거하세요
  2. lint 로 검증하세요 — npm run user -- policy lint --file <파일>
  3. 다시 reload 하세요   — npm run user -- policy reload
```

실패해도 **기존 정책이 그대로 유지됩니다.** 당황하지 말고 오류 내용을 확인한 뒤 정책 파일을 수정하고 lint 를 통과시킨 다음 다시 시도합니다.

---

## 활성 정책 버전 확인 (version)

reload 후 현재 어떤 버전의 정책이 서버에서 실행 중인지 언제든 확인할 수 있습니다.

`admin login` 으로 로그인한 상태여야 합니다.

```bash
npm run user -- policy version
```

**화면 예시:**

```
현재 활성 정책: 버전 3 (적용: 2026-04-29T10:00:00.000Z)
```

"버전" 번호가 reload 전후로 달라졌으면 새 정책이 정상 적용된 것입니다. 시각이 그대로라면 아직 이전 정책이 유지되고 있습니다.

> reload 를 실행한 직후에 이 명령으로 버전을 재확인하는 것이 권장 운영 패턴입니다.

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

"버전" 번호가 올라갔으면 성공입니다.

**5. 적용 확인** (선택사항)

reload 직후 별도 터미널에서 아래 명령으로 현재 활성 버전을 확인할 수 있습니다:

```bash
npm run user -- policy version
```

화면 예시:

```
현재 활성 정책: 버전 3 (적용: 2026-04-29T10:00:00.000Z)
```

`admin login` 으로 로그인한 상태여야 합니다.

---

## 문제가 생기면

### "policy: admin access token 필요." 라고 나옵니다

로그인이 되어 있지 않거나 인증 파일이 없는 상태입니다.

- 권장 방법: `npm run user -- admin login` 으로 로그인합니다.
- 환경 변수 방식 사용 중이라면 `PRESENCE_ADMIN_TOKEN` 이 설정되어 있는지 확인합니다.

### "policy: 서버 도달 실패 — ..." 라고 나옵니다

서버가 꺼져 있거나 주소가 틀렸습니다.

- 서버 실행: `npm start`
- 서버 주소가 기본값과 다르면: `export PRESENCE_SERVER_URL="http://올바른주소:포트"`

### "policy: 인증이 필요합니다 (HTTP 401)." 라고 나옵니다

로그인 정보가 만료됐습니다. 아래 순서로 처리합니다:

1. `npm run user -- admin login` 으로 다시 로그인합니다.
2. 다시 명령을 실행합니다.

환경 변수 방식을 사용 중이라면 새 토큰을 발급해 `PRESENCE_ADMIN_TOKEN` 을 갱신합니다.

### "policy: admin 권한이 필요합니다 (HTTP 403)." 라고 나옵니다

로그인한 계정에 admin 권한이 없습니다. 아래를 확인합니다:

- 설정 파일에서 해당 계정에 `role: admin` 이 부여되어 있는지 확인합니다.
- admin 권한이 있는 계정으로 다시 `admin login` 합니다.

### reload 에 성공했는데 정책이 적용 안 된 것 같습니다

- `npm run user -- policy version` 으로 버전 번호를 확인합니다. reload 전후로 번호가 올라갔다면 반영된 것입니다.
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
