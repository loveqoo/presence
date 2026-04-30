# [FP-73] policy reload — access token 추출이 수동 curl 조합을 요구함

**영역**: infra (admin CLI)
**심각도**: high
**상태**: resolved (2026-04-30)
**관련 코드**: `admin-session.js`, `cli-admin.js`, `cli-policy.js`

## 해소 (2026-04-30)

제안 옵션 "별도 phase — token 자동 저장" 채택. MVP 범위로 반영됨.

**운영 가정 (release gate)**

single-admin / single-machine / single-host server / passwd 가능 환경에서만 운영한다고 가정.

**신규 명령**

| 명령 | 역할 |
|------|------|
| `npm run user -- admin login [--username <name>]` | 1회 인증 → 파일 저장 |
| `npm run user -- admin logout` | 서버 측 jti revoke + 파일 삭제 |
| `npm run user -- admin whoami` | 세션 상태 확인 (token 미노출) |

**저장 방식**

`~/.presence/admin-session.json` (mode 0o600, 부모 디렉토리 0o700, atomicWriteJson).

**token 해석 우선순위**

ENV → 파일 (만료 임박 시 자동 refresh) → 부재 시 안내 출력.

**후속 phase 로 분리된 항목**

- file lock 동시 race 방어
- contract drift 감지
- credential rotation 가이드
- mustChangePassword 자동 변경
- multi-instance topology 대응

**회귀 커버리지**

AS1~AS10 (단위) + CLI-X10~X17 (CLI) + AR9~AR14b (server) + INV 5종 (정적). 4684 → 4775 passed (+91).

**결정 경위**

plan-reviewer 11 라운드 (pre-MVP 6 + MVP 5) 거쳐 사용자 결정으로 확정. 운영 규율 영역(rotation, multi-instance 등)은 가이드 문서로 흡수.

---

## (이하 원래 issue 본문)

## 시나리오

신규 admin이 처음으로 50-block-user.cedar 를 작성하고 적용하려 한다. lint 는 통과했고 이제 reload 를 해야 한다.

운영자가 해야 하는 순서:

1. `npm run user -- policy lint --file 50-block-user.cedar` — 통과
2. `npm run user -- policy reload` — 실행 시 즉시 실패 메시지 출력:
   ```
   policy reload: admin access token 필요.
     1. admin 으로 로그인 — POST /api/auth/login
     2. 응답의 access token 을 PRESENCE_ADMIN_TOKEN env 에 설정
     3. 다시 실행 — npm run user -- policy reload
     주의: process listing 으로 token 노출 가능. 신뢰된 환경에서만 사용.
   ```
3. `curl -s -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"username":"admin","password":"..."}' | jq -r '.accessToken'` — 수동으로 token 추출
4. `export PRESENCE_ADMIN_TOKEN=eyJ...` — 환경변수 설정
5. `npm run user -- policy reload` — 재실행

## 현재 동작

`cmdPolicyReload` 는 `PRESENCE_ADMIN_TOKEN` env 가 없으면 즉시 오류 출력 후 종료한다. 운영자에게 "curl로 로그인 → jq로 파싱 → export" 라는 3단계 수동 조합을 안내한다.

## 마찰 포인트

| 포인트 | 설명 |
|--------|------|
| 진입 경로 길이 | lint → reload 라는 자연스러운 2단계 흐름이 token 취득 우회로 인해 5단계로 늘어난다 |
| 전문 지식 요구 | curl, Content-Type 헤더, jq -r '.accessToken' 파싱, export 문법을 모두 알아야 한다 |
| 보안 안내 타이밍 | "process listing 으로 token 노출 가능" 경고는 이미 ENV 설정을 결정한 시점에 나온다 — 결정 전에 제시되어야 할 정보다 |
| jq 의존성 비명시 | 안내 문자열에 jq 가 설치되어 있어야 한다는 전제를 명시하지 않는다 |

## 제안

### 즉시 적용 가능 — 안내 품질 개선

현재 step 1~3 안내가 curl + jq 명령어 조합을 직접 제공하지 않는다. 적어도 복사하여 실행 가능한 구체적 예시를 제공해야 한다:

```
policy reload: admin access token 필요.

  로그인하여 token 을 얻으세요:
  curl -s -X POST http://localhost:3000/api/auth/login \
       -H "Content-Type: application/json" \
       -d '{"username":"admin","password":"YOUR_PASSWORD"}' | jq -r '.accessToken'

  token 확인 후 환경변수를 설정하세요:
  export PRESENCE_ADMIN_TOKEN=<위 명령의 출력값>

  그 다음 다시 실행하세요:
  npm run user -- policy reload

  보안 주의: ENV 방식은 process listing에 token이 노출될 수 있습니다.
              CI/자동화 환경에서는 별도 secrets manager 사용을 권장합니다.
```

jq 미설치 대응 대안도 함께 제공:
```
  jq 미설치 시: | python3 -m json.tool 후 accessToken 값을 수동 복사
```

### 별도 phase — token 자동 저장

`npm run user -- policy reload` 가 내부적으로 `~/.presence/admin-token.json` (모드 0600)에 최근 access token 을 저장하고, reload 실행 시 ENV 없으면 파일에서 읽는 방식. 운영자는 한 번만 `npm run user -- login`(또는 유사 커맨드)으로 인증하면 이후 reload/version 확인이 ENV 없이 동작한다.

## 근거

현재 흐름에서 "lint 가 통과했으니 reload 해야지"라는 자연스러운 생각이 즉시 막힌다. token 취득 과정은 정책 변경이라는 주된 목적과 무관한 인증 인프라 지식을 요구한다. 이 마찰은 admin 이 reload 를 자주 사용하지 않게 만드는 원인이 되어 — 결국 정책을 배포하고 서버를 재시작하는 옛 방식으로 회귀할 가능성이 높다.
