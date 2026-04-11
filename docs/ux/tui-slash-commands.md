감사 일자: 2026-04-10
스코프: 슬래시 커맨드/훅
감사자: ux-guardian

---

# TUI 슬래시 커맨드·훅 영역 UX 감사

대상 파일: `packages/tui/src/ui/slash-commands.js`, `slash-commands/{memory,sessions,statusline}.js`, `hooks/{useSlashCommands,useAgentMessages,useAgentState}.js`
참고 스펙: `docs/specs/session.md`, `docs/specs/memory.md`, `docs/specs/tui-server-contract.md`

---

## 마찰 포인트 목록

### [FP-36] 심각도: high | InputBar.js | `/` 입력 시 커맨드 힌트 없음 — **resolved (2026-04-11)**

**해소 확인**
InputBar가 입력 value가 `/`로 시작할 때 프롬프트 위에 회색 힌트 한 줄을 렌더한다.

렌더 예시:
```
Tip: /help 로 전체 커맨드 목록 보기
> /
```

i18n 키 `slash_hint.tip`이 `ko.json`에 추가되었다. 테스트: `packages/tui/test/app.test.js` 62c(초기 미표시), 62d(`/` 입력 후 표시).

**원래 현상** — InputBar는 순수 텍스트 입력기로, `/`를 타이핑해도 아무 힌트도 나타나지 않는다. 유저는 `/help`의 존재를 먼저 알아야만 다른 커맨드를 발견할 수 있다. `commandMap`에 13개 커맨드가 등록되어 있는데 모두 숨겨져 있는 상태다.

**원래 제안** — `/`를 입력하는 순간 입력창 위에 커맨드 목록 힌트를 표시한다. 최소한 고정 힌트 한 줄(`/help 로 전체 커맨드 목록 보기`)만 추가해도 진입 장벽이 크게 낮아진다.

---

### [FP-37] 심각도: high | slash-commands/sessions.js:24-28 | `/sessions switch` 성공 피드백 없음 — **resolved (2026-04-11)**

**해소 확인**
`RemoteSession.switchSession`이 완료 후 새 mount의 `initialMessages`에 i18n 키 `sessions_cmd.switched` system 메시지를 한 번 주입한다. `#consumePendingInitialMessages()`가 주입/소비를 처리한다.

전환 후 ChatArea에 남는 메시지 예시:
```
[시스템] 세션 전환됨: work
```

시나리오 테스트: `packages/tui/test/scenarios/session-switch.scenario.js` 마지막 step에서 `세션 전환됨: work` 검증.

**원래 현상** — "세션 전환 중..." 메시지는 표시되지만 `onSwitchSession` Promise의 `.then()` 핸들러가 없어 전환 완료 메시지가 없다. 실패 시만 영어 오류가 뜬다. WS 재연결을 포함하는 비동기 작업인데 완료 신호가 없다.

**원래 제안** — `.then(() => addMessage({ role: 'system', content: t('sessions_cmd.switched', { id }) }))` 추가.

---

### [FP-38] 심각도: medium | i18n/ko.json:87 + slash-commands/memory.js:43-55 | `/memory help`가 구현되지 않은 기능 안내 — **resolved (2026-04-12)**

**해소 확인**
`/memory help` 텍스트에서 `/memory list <tier>` (episodic, semantic 필터) 설명이 제거되었다. `cmdList`는 tier 인자를 지원하지 않으므로 구현 대신 도움말을 사실에 맞게 수정하는 방향으로 해소. 현재 도움말은 tier 필터 언급 없이 전체 목록 조회만 안내한다.

테스트: `packages/tui/test/app.test.js` 66a (memory help 출력에 tier 관련 문구 없음 검증).

**원래 현상** — 도움말에 `/memory list <tier>` (episodic, semantic 필터)가 설명되어 있으나, 실제 `cmdList` 구현은 tier 인자를 무시하고 항상 전체 목록을 반환한다. `/memory list episodic` 입력 시 전체 목록이 나온다.

**원래 제안** — tier 필터 구현 또는 도움말에서 해당 설명 제거.

---

### [FP-39] 심각도: medium | slash-commands/memory.js:54 | `/memory clear` 기간 표현 영어 하드코딩 — **resolved (2026-04-12)**

**해소 확인**
피드백 문구가 i18n 키 `memory_cmd.cleared_with_age`로 이관되었다. `ko.json`에 해당 키가 추가되어 "5개 노드 삭제 (7d 이상 경과)" 형태로 출력된다. 영어 하드코딩이 완전히 제거되어 정상 경로와 오류 경로 모두 한국어로 일관된다.

테스트: `packages/tui/test/app.test.js` 66b (`/memory clear 7d` 결과 메시지에 "이상 경과" 포함 검증).

**원래 현상** — `` `older than ${clearArgs.find(...)}` `` 가 영어로 하드코딩. 나머지 메시지는 `t()`로 한국어인데 기간 지정 경로만 영어로 섞인다.

**원래 제안** — i18n 키로 이관.

---

### [FP-40] 심각도: medium | slash-commands/statusline.js:18, 24 | `/statusline` 변경 후 현재 구성 미표시 — **resolved (2026-04-12)**

**해소 확인**
`/statusline +항목` / `/statusline -항목` 실행 후 변경 확인 메시지와 함께 전체 현재 구성이 즉시 출력된다. 추가·제거 후 `/statusline`을 다시 입력하지 않아도 결과를 한 번에 확인할 수 있다. FP-12(한글 헤더 + 키 설명)와 같은 커밋에서 함께 해소되었다.

테스트: `packages/tui/test/app.test.js` 65a (`/statusline +turn` 후 전체 구성 출력 검증), 65b (`/statusline -turn` 후 전체 구성 출력 검증), 65c (출력에 현재 활성 항목 포함 검증).

**원래 현상** — `+turn`, `-branch` 같은 단순 확인 메시지만 표시. 변경 후 전체 상태바 구성을 함께 보여주지 않아 결과 확인을 위해 `/statusline`을 다시 입력해야 한다.

**원래 제안** — 변경 후 현재 활성 항목 목록을 함께 출력.

---

### [FP-41] 심각도: medium | slash-commands/sessions.js:14, 21, 28, 37 | 세션 커맨드 오류 시 언어 전환 — **resolved (2026-04-12)**

**해소 확인**
`sessions.js` `.catch()` 핸들러 4곳과 `useSlashCommands.js`의 `` `Error: ${e.message}` `` 영어 템플릿이 i18n 키 `slash_cmd.error`("오류: {{message}}")로 이관되었다. `tag: 'error'`도 함께 적용. 정상 경로·오류 경로 모두 한국어로 일관된다.

i18n 키: `slash_cmd.error`. 테스트: `packages/tui/test/app.test.js` 83.

**원래 현상** — `.catch()` 핸들러 4곳 모두 `` `Error: ${e.message}` `` 영어 하드코딩. 정상 경로는 한국어, 오류 경로는 영어로 일관성이 없다. i18n에 이미 `error.agent_error` 키가 있다.

**원래 제안** — 기존 i18n 키로 통일.

---

### [FP-42] 심각도: medium | hooks/useSlashCommands.js:30-43 | 알 수 없는 슬래시 커맨드가 에이전트로 전달됨 — **resolved (2026-04-12)**

**해소 확인**
`dispatchSlashCommand`가 `/`로 시작하되 커맨드 테이블에 없는 입력을 흡수하여 i18n 키 `slash_cmd.unknown`("알 수 없는 커맨드: /xxx — /help 로 전체 목록 확인") 메시지를 `tag: 'error'`로 표시한다. 에이전트 턴은 발생하지 않는다. 기존 `session.md:E12` Known Gap 해소.

i18n 키: `slash_cmd.unknown`. 테스트: `packages/tui/test/app.test.js` 80a/b/c + `slash-typo` 시나리오 5/5 통과.

**원래 현상** — `/mem`, `/model` 등 오타 커맨드가 경고 없이 에이전트 채팅 턴을 시작한다. 스펙(`session.md:E12`)도 Known Gap으로 명시.

**원래 제안** — `/`로 시작하되 커맨드 테이블에 없는 입력은 "알 수 없는 커맨드: /xxx — /help 참조" 메시지로 차단.

---

### [FP-43] 심각도: low | i18n/ko.json:47 | `/help`에 `/mcp` 커맨드 누락 — **resolved (2026-04-12)**

**해소 확인**
`help.commands` i18n 문자열에 `/mcp          MCP 서버 관리 (예: /mcp list, /mcp enable mcp0)` 한 줄이 추가되었다. `/help` 출력에 `/mcp`가 포함된다.

테스트: `packages/tui/test/app.test.js` 81.

**원래 현상** — `commandMap`에 `/mcp`가 등록되어 있으나 `/help` 출력에 없다.

**원래 제안** — `/help`의 i18n 문자열에 `/mcp` 한 줄 추가.

---

### [FP-44] 심각도: low | slash-commands/sessions.js:7-14 | `/sessions list`에 세션 이름 미표시 — **resolved (2026-04-12)**

**해소 확인**
`cmdList`에서 `s.name`이 `s.id`와 다르면 `id  "name"  [type]` 형태로 함께 표시하고, 같으면 중복을 억제한다. 헤더 문구도 `sessions:` → `세션 목록:`으로 한글화되었다. i18n 키: `sessions_cmd.list_header`.

테스트: `packages/tui/test/app.test.js` 82a/b.

**원래 현상** — `onCreateSession(name)`으로 이름을 받아 생성하지만 목록은 id만 표시. 여러 세션 구별이 id 기억에만 의존한다.

**원래 제안** — 목록 출력에 name/title 필드 포함.

---

### [FP-45] 심각도: low | hooks/useAgentState.js:118-121 | `debug`, `opTrace` 등 내부 용어 잠재적 노출 — **resolved (2026-04-12)**

**해소 확인**
grep 검증으로 `debug`, `opTrace`, `iterationHistory` 등 내부 상태 변수명이 사용자 메시지 템플릿에 직접 포함된 경우가 없음을 확인했다. `/report` 및 `Ctrl+T` 전사는 의도적 개발자 뷰. 예방 체크 완료.

**원래 현상** — 현재는 화면 레이블이 아닌 코드 수준이라 즉각 위험 없음. 향후 에러 메시지에 노출되지 않도록 주의 필요.

---

## 심각도별 집계 (2026-04-12 업데이트)

| 심각도 | open | resolved | 항목 |
|--------|------|----------|------|
| **high** | 0 | 2 | resolved: FP-36, FP-37 |
| **medium** | 0 | 5 | resolved: FP-38, FP-39, FP-40, FP-41, FP-42 |
| **low** | 0 | 3 | resolved: FP-43, FP-44, FP-45 |

---

## 긍정적 관찰

- `/help` 내용이 구체적이고 한국어로 잘 정리됨
- `transient: true` 패턴으로 조회 결과가 ESC 시 자동 정리됨
- `/memory clear 7d` 형태의 age 인자가 유저 친화적
- `budgetWarning` 발생 시 즉시 시스템 메시지 표시
- ESC 취소 + 취소 결과 메시지 표시
- 입력 히스토리(화살표 키) 구현
