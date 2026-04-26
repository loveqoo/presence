# admin 계정 두 번째 세션 생성 거부 시 원문 에러 코드 노출

**영역**: TUI
**심각도**: medium
**상태**: resolved (2026-04-26)
**관련 코드**: `packages/tui/src/ui/slash-commands/sessions.js:20-26`, `packages/server/src/server/session-api.js:184-185`

(REGISTRY: FP-68)

## 시나리오

admin 계정으로 TUI에 로그인한 상태에서 이미 활성 세션이 하나 존재할 때 `/session new`를 입력한다. KG-15 구현(da596c4)으로 서버는 동시 admin 세션을 거부한다.

## 현재 동작

서버 응답:
```json
{ "error": "Access denied: admin-singleton", "code": "AGENT_ACCESS_DENIED" }
```

TUI `formatCreateError`(sessions.js:20-26)가 이 code를 처리하지 못해 `slash_cmd.error` 포맷으로 표시:
```
오류: Access denied: admin-singleton
```

원문 영어 이유 문자열 `admin-singleton`이 그대로 노출된다.

## 마찰 포인트

- `admin-singleton`은 내부 REASON 상수 값이다. 유저는 이 용어가 무엇을 의미하는지 알 수 없다.
- "Access denied" + 영어 이유 혼합으로 한국어 locale 유저에게 언어 혼용이 발생한다.
- 해소 방법(기존 세션을 닫으면 된다)이 안내되지 않는다.

## 제안

`formatCreateError`에 `AGENT_ACCESS_DENIED` code 분기를 추가하고, i18n 키 `sessions_cmd.error.admin_singleton`을 신설한다.

권장 메시지:
- ko: "관리자 계정은 동시에 하나의 세션만 사용할 수 있습니다. 기존 세션을 삭제한 뒤 다시 시도하세요."
- en: "Only one active session is allowed for admin. Delete the existing session and try again."

단, `AGENT_ACCESS_DENIED`가 다른 이유(ARCHIVED 등)와 공유되므로 서버에서 reason을 별도 필드로 내려주거나, TUI가 error 문자열에서 패턴 매칭하는 방식 중 하나를 선택해야 한다. 더 명확한 방법은 서버가 `reason: 'admin-singleton'` 필드를 403 응답에 추가하는 것이다. UX 관점의 제안이므로 구현 방법은 메인 에이전트가 결정한다.

## 근거

유저가 세션 생성 실패를 경험하면 즉시 "왜 실패했고, 무엇을 해야 하는가"를 알아야 한다. 현재 `admin-singleton` 문자열은 코드베이스 내부 레이블 그대로이며, 이 값이 화면에 노출되는 것은 UX 원칙(내부 용어를 화면에 노출하지 않는다)에 위배된다.

## 해소 방향

### 1. 분기 조건 명확화

`canAccessAgent`(`packages/infra/src/infra/authz/agent-access.js`) 의 `REASON` 상수는
`ADMIN_SINGLETON: 'admin-singleton'`으로 정의되어 있다.
서버(`session-api.js:185`)는 현재 이 reason 값을 `error` 문자열에 접합해 내려보낸다:

```
{ "error": "Access denied: admin-singleton", "code": "AGENT_ACCESS_DENIED" }
```

`AGENT_ACCESS_DENIED` code 는 `ARCHIVED`, `ADMIN_ONLY`, `NOT_OWNER` 등 여러 reason 과 공유된다.
따라서 TUI가 이 code 만으로 admin-singleton 상황임을 식별하려면
**서버가 `reason` 필드를 별도로 403 응답에 추가**하는 것이 가장 명확한 경로다.

권장 응답 형태:
```json
{ "error": "Access denied: admin-singleton", "code": "AGENT_ACCESS_DENIED", "reason": "admin-singleton" }
```

이렇게 하면 TUI `formatCreateError` 는 `resp.reason === 'admin-singleton'` 으로
단순하고 오탐 없이 분기할 수 있다.

대안(reason 필드 추가 없이 TUI에서 처리): `resp.error` 문자열에 `'admin-singleton'`
포함 여부를 패턴 매칭. 서버 메시지 포맷이 바뀌면 깨지므로 취약하다. 권장하지 않는다.

### 2. i18n 키 신설 시안

**키 이름**: `sessions_cmd.error.admin_singleton`

기존 `sessions_cmd.error.*` 네임스페이스(`ko.json:123-126`)에 나란히 추가:

```json
// ko.json
"sessions_cmd": {
  "error": {
    "working_dir_out_of_bounds": "...",
    "working_dir_not_resolvable": "...",
    "admin_singleton": "관리자 계정은 동시에 하나의 세션만 사용할 수 있습니다. 기존 세션을 종료한 뒤 다시 시도하세요."
  }
}

// en.json
"sessions_cmd": {
  "error": {
    "admin_singleton": "Admin accounts are limited to one active session. End the existing session and try again."
  }
}
```

메시지 설계 의도:
- "관리자 계정은" — 이 제약이 admin에만 적용됨을 명시 (다른 계정은 해당 없음을 암시).
- "동시에 하나의 세션만" — 제약 내용을 사실로 서술. "거부됨" 같은 부정어 없이 이유 제시.
- "기존 세션을 종료한 뒤 다시 시도하세요" — 회복 경로를 직접 안내.

### 3. `formatCreateError` 분기 시안 (의사코드)

```js
const formatCreateError = (resp) => {
  const msg = resp?.error || ''
  const code = resp?.code
  const reason = resp?.reason   // 서버가 reason 필드를 추가한 경우

  if (code === 'WORKING_DIR_OUT_OF_BOUNDS') return t('sessions_cmd.error.working_dir_out_of_bounds')
  if (code === 'WORKING_DIR_NOT_RESOLVABLE') return t('sessions_cmd.error.working_dir_not_resolvable')
  if (code === 'AGENT_ACCESS_DENIED' && reason === 'admin-singleton')
    return t('sessions_cmd.error.admin_singleton')
  return t('slash_cmd.error', { message: msg })
}
```

분기 순서는 기존 패턴과 동일하게 유지. `reason` 필드가 없을 경우 마지막 fallback
(`slash_cmd.error`) 으로 낙하한다 — 하위 호환 보장.

### 4. 필요한 변경 범위 요약

| 파일 | 변경 내용 |
|------|-----------|
| `packages/server/src/server/session-api.js:185` | 403 응답에 `reason: access.reason` 필드 추가 |
| `packages/infra/src/i18n/ko.json` | `sessions_cmd.error.admin_singleton` 키 추가 |
| `packages/infra/src/i18n/en.json` | `sessions_cmd.error.admin_singleton` 키 추가 |
| `packages/tui/src/ui/slash-commands/sessions.js:20-26` | `formatCreateError` 에 분기 추가 |

## 해소

**적용 경로 (2026-04-26)**

서버(`session-api.js:185`)가 `reason: access.reason` 필드를 403 응답에 추가했다. 이로써 TUI가 `code === 'AGENT_ACCESS_DENIED' && reason === 'admin-singleton'` 조건으로 오탐 없이 분기할 수 있게 됐다.

TUI `formatCreateError`(sessions.js:22–31)에 해당 분기가 구현되어 `t('sessions_cmd.error.admin_singleton')` 메시지를 반환한다.

i18n 키:
- ko: "이미 관리자 세션이 활성 상태입니다. 기존 세션을 종료한 뒤 다시 시도하세요."
- en: "An admin session is already active. End the existing session before trying again."

회귀 테스트: `packages/tui/test/session-commands.test.js` SC4c (한국어 메시지 검증).

**UX 마찰 해소 검증**

이 이슈의 핵심 마찰은 세 가지였다.

1. `admin-singleton` 내부 코드가 한국어 유저 화면에 영문 원문으로 노출됨 — reason 분기 추가로 해소. 화면에는 한국어 안내문만 표시된다.
2. "Access denied" + 영어 이유 혼합 언어 노출 — 동일하게 해소.
3. 해소 방법(기존 세션을 닫으면 된다) 미안내 — "기존 세션을 종료한 뒤 다시 시도하세요"가 메시지에 포함되어 유저가 즉시 행동 가능.

이 이슈의 제안과 구현 간 차이: 이슈에서 권장한 메시지("관리자 계정은 동시에 하나의 세션만 사용할 수 있습니다. 기존 세션을 삭제한 뒤…")와 실제 적용 메시지("이미 관리자 세션이 활성 상태입니다. 기존 세션을 종료한 뒤…")가 다소 다르다. 실제 적용 메시지가 더 간결하고 "이미 활성 상태"라는 현황 진술을 앞세워 직관적이므로 UX 관점에서 더 나은 선택이다.
