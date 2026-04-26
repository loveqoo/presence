# 첫 진입 시 에이전트 페르소나 미설정 안내 부재 (FP-71)

**영역**: TUI
**심각도**: medium
**상태**: resolved (2026-04-26)
**관련 코드**: `packages/tui/src/ui/App.js`, `packages/server/src/server/slash-commands.js`, `packages/server/src/server/slash-commands.js`

---

## 시나리오

신규 가입자 alice가 서버에 계정을 만들고 처음으로 TUI에 로그인한다. 화면에는 StatusBar, 빈 채팅 영역, 입력창만 보인다. alice는 입력창에 "내 일정 정리해줘"라고 입력한다. 에이전트는 "안녕하세요, Presence 입니다"라고 시작하는 일반적인 응답을 돌려준다.

alice는 "내 비서를 내 업무 방식에 맞게 정의하고 싶은데 어떻게 하지?"라는 의문을 갖는다. TUI의 `/help`, StatusBar, 채팅 화면 어디에도 페르소나 설정 방법이 안내되어 있지 않다. 결국 alice는 제품의 핵심 가치인 "개인 업무 대리 에이전트"를 첫 사용에서 경험하지 못한다.

---

## 현재 동작

- `~/.presence/users/{username}/config.json`의 `agents[].persona`가 기본값 `{ name: 'Presence', systemPrompt: null, rules: [], tools: [] }`으로 시작한다.
- `systemPrompt: null`이면 prompt assembly가 기본 `ROLE_DEFINITION`으로 fallback — 유저 입장에서는 사실상 비어 있는 상태다.
- 페르소나 변경 경로가 CLI(`npm run user -- agent add --persona <path>`)만 존재 — TUI에서는 설정 경로가 보이지 않는다.
- TUI 진입 시 시스템 메시지 / StatusBar / `/help` 어디에도 페르소나 미설정 상태 안내 없다.

---

## 마찰 포인트

1. **미설정 상태 비가시성**: `systemPrompt: null` 상태임을 유저가 알 수 없다. 에이전트가 기본 응답을 하는 것인지, 정의된 역할로 응답하는 것인지 구분 불가.
2. **진입 경로 불연결**: 페르소나 설정 경로가 CLI 전용이다. TUI 내에서 확인하거나 바꾸는 방법이 없다.
3. **첫인상 손실**: 신규 유저가 제품의 핵심 가치("내 비서를 나에게 맞게 정의")를 첫 세션에서 경험하지 못하고 이탈할 위험이 있다.

---

## 제안

### 1. 첫 진입 시 한 번만 안내 (최소 해소)

`getPrimaryPersona().systemPrompt === null` 감지 시 TUI 첫 마운트 시점에 system 메시지 한 줄 표시:

> "에이전트의 역할이 정의되지 않았습니다. /persona set <내용> 으로 설정할 수 있습니다."

- 조건: 첫 마운트 시 한 번만. 이후 재로그인에서는 이미 설정된 경우 표시 안 함.
- 구현 위치: `App.js` mount effect 또는 서버 WS `init` 응답에 `personaSet: boolean` 필드 추가 후 TUI에서 분기.

### 2. `/persona` 슬래시 커맨드 추가

서버 `slash-commands.js`의 `SLASH_COMMANDS` 테이블에 핸들러 추가. 서브커맨드:

| 서브커맨드 | 동작 |
|------------|------|
| `/persona show` | 현재 설정된 페르소나 출력 (미설정이면 "설정된 페르소나가 없습니다" 표시) |
| `/persona set <text>` | 입력한 텍스트를 `systemPrompt`로 저장 |
| `/persona reset` | `systemPrompt`를 `null`로 초기화 (기본값 복원) |

- `set`과 `reset`은 변경 후 확인 메시지 표시: "페르소나가 설정되었습니다." / "페르소나가 초기화되었습니다."
- TUI 슬래시 커맨드 테이블(`packages/tui/src/ui/slash-commands.js`)에서 서버로 위임하는 패턴 사용.

### 3. `/help` 갱신

설정 섹션에 `/persona` 항목 추가:

```
/persona show        — 현재 에이전트 역할 확인
/persona set <내용>  — 에이전트 역할 정의
/persona reset       — 역할 초기화 (기본값 복원)
```

---

## 근거

presence의 핵심 가치는 "개인 업무 대리 에이전트"다. 에이전트의 역할(페르소나)은 이 가치를 실현하는 첫 번째 설정이다. 유저가 첫 로그인 후 아무 안내 없이 기본 에이전트와 대화만 하고 떠난다면, 제품의 차별점을 한 번도 경험하지 못한 채 이탈하는 셈이다.

"첫 진입 시 안내 한 줄"은 구현 비용이 낮고 유저가 자발적으로 페르소나 설정을 시도하게 만드는 직접적 트리거다. `/persona` 커맨드는 TUI 안에서 설정을 완결할 수 있게 해 CLI 지식이 없는 유저도 도달할 수 있다.

---

## 해소 (2026-04-26)

### 적용된 3단계

**1단계: `/persona` 슬래시 커맨드**

서버 `packages/server/src/server/slash-commands.js`의 `SLASH_COMMANDS` 테이블에 `persona` 핸들러가 추가되었다.

- `/persona` 또는 `/persona show` → `Persona: {name}\n{systemPrompt}` 또는 `(unset — using default role definition)` 출력
- `/persona set <text>` → `userContext.updatePrimaryPersona({ systemPrompt: text })`로 갱신 + `config.json` 영속화. "Persona updated. Takes effect next turn." 확인 메시지
- `/persona reset` → `systemPrompt: null`로 환원. "Persona reset (default role definition)." 확인 메시지
- 인자 오류 또는 미지원 서브커맨드 → "Usage: /persona [show | set \<text\> | reset]" 안내

TUI `packages/tui/src/ui/slash-commands.js`의 `commandMap`에 `/persona` 항목이 추가되었다. `onInput`이 있으면 서버에 위임(remote 모드), 없으면 `persona_cmd.not_available` i18n 키로 차단(단독 모드).

UX 관점 검증: 유저가 `/persona set 코드 리뷰 전문가`라고 입력하면 서버가 처리하고 확인 메시지가 채팅창에 system 메시지로 돌아온다. `/persona show`로 설정 결과를 즉시 확인할 수 있다. 가역성 확보: `/persona reset`으로 기본값 복원 가능.

**2단계: 첫 진입 안내 (1회)**

서버 `GET /api/sessions/:id/config` 응답에 `personaConfigured: boolean` 필드가 추가되었다(`session-api.js:126`). `getPrimaryPersona().systemPrompt`가 비어있으면 `false`.

`packages/tui/src/remote-session.js` 생성자에서 `opts.config?.personaConfigured === false`이면 `#pendingInitialMessages`에 `t('persona_onboarding.hint')` 메시지를 `transient: true`로 push한다. TUI 첫 마운트 시 ChatArea에 한 번 표시되고, ESC로 닫을 수 있다.

UX 관점 검증: `systemPrompt`가 null인 신규 유저는 TUI 진입과 동시에 설정 안내를 받는다. 유저가 `/persona set`으로 설정을 완료한 뒤 재시작하면 `personaConfigured: true`가 되어 안내가 다시 뜨지 않는다. `transient: true`이므로 대화 히스토리에 남지 않는다.

**3단계: `/help` 갱신 + i18n**

ko/en `help.commands` i18n 문자열에 `/persona` 항목이 추가되었다. 신규 i18n 네임스페이스:

- `persona_cmd.not_available` — 단독 모드 차단 메시지
- `persona_onboarding.hint` — 첫 진입 안내 문구

UX 관점 검증: `/help`를 입력하면 `/persona` 항목이 노출된다. 처음 TUI를 접한 유저가 `/`를 입력해 힌트를 보거나 `/help`를 입력하는 것만으로 페르소나 설정 경로를 발견할 수 있다.

### 마찰 포인트별 해소 상태

| 마찰 포인트 | 해소 여부 | 경로 |
|------------|---------|------|
| 미설정 상태 비가시성 | 해소 | 2단계 첫 진입 안내 (transient) + `/persona show` |
| 진입 경로 불연결 (CLI 전용) | 해소 | `/persona set <text>`로 TUI 내 완결 |
| 첫인상 손실 | 해소 | 1회성 안내 메시지로 신규 유저를 설정으로 유도 |
