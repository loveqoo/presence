감사 일자: 2026-04-10
스코프: 슬래시 커맨드/훅
감사자: ux-guardian

---

# TUI 슬래시 커맨드·훅 영역 UX 감사

대상 파일: `packages/tui/src/ui/slash-commands.js`, `slash-commands/{memory,sessions,statusline}.js`, `hooks/{useSlashCommands,useAgentMessages,useAgentState}.js`
참고 스펙: `docs/specs/session.md`, `docs/specs/memory.md`, `docs/specs/tui-server-contract.md`

---

## 마찰 포인트 목록

### [FP-1] 심각도: high | InputBar.js | `/` 입력 시 커맨드 힌트 없음

**현상** — InputBar는 순수 텍스트 입력기로, `/`를 타이핑해도 아무 힌트도 나타나지 않는다. 유저는 `/help`의 존재를 먼저 알아야만 다른 커맨드를 발견할 수 있다. `commandMap`에 13개 커맨드가 등록되어 있는데 모두 숨겨져 있는 상태다.

**제안** — `/`를 입력하는 순간 입력창 위에 커맨드 목록 힌트를 표시한다. 최소한 고정 힌트 한 줄(`/help 로 전체 커맨드 목록 보기`)만 추가해도 진입 장벽이 크게 낮아진다.

---

### [FP-2] 심각도: high | slash-commands/sessions.js:24-28 | `/sessions switch` 성공 피드백 없음

**현상** — "세션 전환 중..." 메시지는 표시되지만 `onSwitchSession` Promise의 `.then()` 핸들러가 없어 전환 완료 메시지가 없다. 실패 시만 영어 오류가 뜬다. WS 재연결을 포함하는 비동기 작업인데 완료 신호가 없다.

**제안** — `.then(() => addMessage({ role: 'system', content: t('sessions_cmd.switched', { id }) }))` 추가.

---

### [FP-3] 심각도: medium | i18n/ko.json:87 + slash-commands/memory.js:43-55 | `/memory help`가 구현되지 않은 기능 안내

**현상** — 도움말에 `/memory list <tier>` (episodic, semantic 필터)가 설명되어 있으나, 실제 `cmdList` 구현은 tier 인자를 무시하고 항상 전체 목록을 반환한다. `/memory list episodic` 입력 시 전체 목록이 나온다.

**제안** — tier 필터 구현 또는 도움말에서 해당 설명 제거.

---

### [FP-4] 심각도: medium | slash-commands/memory.js:54 | `/memory clear` 기간 표현 영어 하드코딩

**현상** — `` `older than ${clearArgs.find(...)}` `` 가 영어로 하드코딩. 나머지 메시지는 `t()`로 한국어인데 기간 지정 경로만 영어로 섞인다.

**제안** — i18n 키로 이관.

---

### [FP-5] 심각도: medium | slash-commands/statusline.js:18, 24 | `/statusline` 변경 후 현재 구성 미표시

**현상** — `+turn`, `-branch` 같은 단순 확인 메시지만 표시. 변경 후 전체 상태바 구성을 함께 보여주지 않아 결과 확인을 위해 `/statusline`을 다시 입력해야 한다.

**제안** — 변경 후 현재 활성 항목 목록을 함께 출력.

---

### [FP-6] 심각도: medium | slash-commands/sessions.js:14, 21, 28, 37 | 세션 커맨드 오류 시 언어 전환

**현상** — `.catch()` 핸들러 4곳 모두 `` `Error: ${e.message}` `` 영어 하드코딩. 정상 경로는 한국어, 오류 경로는 영어로 일관성이 없다. i18n에 이미 `error.agent_error` 키가 있다.

**제안** — 기존 i18n 키로 통일.

---

### [FP-7] 심각도: medium | hooks/useSlashCommands.js:30-43 | 알 수 없는 슬래시 커맨드가 에이전트로 전달됨

**현상** — `/mem`, `/model` 등 오타 커맨드가 경고 없이 에이전트 채팅 턴을 시작한다. 스펙(`session.md:E12`)도 Known Gap으로 명시.

**제안** — `/`로 시작하되 커맨드 테이블에 없는 입력은 "알 수 없는 커맨드: /xxx — /help 참조" 메시지로 차단.

---

### [FP-8] 심각도: low | i18n/ko.json:47 | `/help`에 `/mcp` 커맨드 누락

**현상** — `commandMap`에 `/mcp`가 등록되어 있으나 `/help` 출력에 없다.

**제안** — `/help`의 i18n 문자열에 `/mcp` 한 줄 추가.

---

### [FP-9] 심각도: low | slash-commands/sessions.js:7-14 | `/sessions list`에 세션 이름 미표시

**현상** — `onCreateSession(name)`으로 이름을 받아 생성하지만 목록은 id만 표시. 여러 세션 구별이 id 기억에만 의존한다.

**제안** — 목록 출력에 name/title 필드 포함.

---

### [FP-10] 심각도: low | hooks/useAgentState.js:118-121 | `debug`, `opTrace` 등 내부 용어 잠재적 노출

**현상** — 현재는 화면 레이블이 아닌 코드 수준이라 즉각 위험 없음. 향후 에러 메시지에 노출되지 않도록 주의 필요.

---

## 긍정적 관찰

- `/help` 내용이 구체적이고 한국어로 잘 정리됨
- `transient: true` 패턴으로 조회 결과가 ESC 시 자동 정리됨
- `/memory clear 7d` 형태의 age 인자가 유저 친화적
- `budgetWarning` 발생 시 즉시 시스템 메시지 표시
- ESC 취소 + 취소 결과 메시지 표시
- 입력 히스토리(화살표 키) 구현
