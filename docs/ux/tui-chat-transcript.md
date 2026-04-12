감사 일자: 2026-04-10
스코프: 채팅/입력/전사
감사자: ux-guardian

---

# TUI 채팅/입력/전사 영역 UX 감사

대상 파일: ChatArea, InputBar, MarkdownText, TranscriptOverlay, transcript/*, report.js
참고 스펙: `docs/specs/tui-server-contract.md`, `docs/specs/session.md`, `docs/specs/planner.md`

## 요약

7개 마찰 포인트 식별. 심각도 분포: high 0(해소 2), medium 1(해소 2), low 0(해소 2).

| 심각도 | open | resolved | 항목 |
|--------|------|----------|------|
| **high** | 0 | 2 | resolved: FP-29, FP-30 |
| **medium** | 1 | 2 | open: FP-31 / resolved: FP-32, FP-33 |
| **low** | 0 | 2 | resolved: FP-34, FP-35 |

---

## FP-29. 입력 비활성 상태를 유저가 인지하기 어렵다 — **resolved (2026-04-11)**

심각도: **high**
위치: `packages/tui/src/ui/components/InputBar.js:103-113`, `packages/tui/src/ui/App.js:109`

**해소 확인**
`InputBar`에 `hint` prop이 추가되었다. `App.js`가 상황별 힌트를 계산해 전달한다.

| 상태 | i18n 키 | 렌더 텍스트 |
|------|---------|-------------|
| `isWorking` | `input_hint.working` | 응답 대기 중 · ESC로 취소 |
| approve 대기 | `input_hint.approve` | 승인이 필요합니다 · y / n |
| disconnected | `input_hint.disconnected` | 연결 끊김 · Ctrl+C로 재시작 |

`disabled && hint` 조건이 참이면 InputBar가 프롬프트(`>`) 옆에 ` [<hint>]`를 회색 텍스트로 렌더한다. i18n 키는 `ko.json`의 `input_hint.*`에 추가되었다. 테스트: `packages/tui/test/app.test.js` 62a, 62b.

**원래 현재 동작** — 에이전트 작업 중(`isWorking`)이거나 승인 대기(`approve`) 상태일 때 `disabled: true`가 전달된다. 비활성 시 프롬프트 색상이 `cyan`에서 `gray`로 바뀌고 커서 블록이 사라진다.

**원래 마찰 포인트** — 색상 변화 하나만으로 "지금 입력할 수 없다"는 사실을 전달한다. 유저가 글자를 눌러도 아무 반응이 없고 이유 설명이 없다. 스트리밍이 진행 중인데 입력 영역이 침묵하면 "앱이 멈췄나?"라는 오해가 생긴다.

**원래 제안** — 비활성 상태에서 `>` 옆에 짧은 상태 힌트를 추가한다. 예: 작업 중이면 `> [응답 대기 중... ESC로 취소]`, 승인 대기 중이면 `> [승인이 필요합니다 — y/n]`. 기술 용어 없이 현재 상태와 가능한 행동을 한 줄로 명시한다.

---

## FP-30. 스트리밍 중 "receiving N chars..." 가 내부 구현 용어를 노출한다 — **resolved (2026-04-11)**

심각도: **high**
위치: `packages/tui/src/ui/App.js:74-82`

**해소 확인**
`App.js` `streamingView`에서 `receiving N chars...` 분기가 제거되었다. 스트리밍 상태는 두 갈래로 단순화되었다.

- content 없음 → `thinking...`
- content 있음 → 마크다운 렌더 + `▌` 커서

HTTP 스트리밍 내부 용어가 더 이상 노출되지 않는다. 테스트: `packages/tui/test/app.test.js` 63b.

**원래 현재 동작** — 스트리밍 상태가 세 갈래로 렌더된다: `thinking...` / `receiving N chars...` / 마크다운 렌더 + `▌`. 컨텐츠가 없고 `thinking`이 아닌 상태에서 `receiving N chars...`가 노출된다.

**원래 마찰 포인트** — `receiving`은 HTTP 스트리밍 내부 용어다. `thinking...`과 `receiving N chars...`의 차이가 유저 입장에서 불분명하다. 스트리밍이 진행 중인지 완료됐는지도 알기 어렵다.

**원래 제안** — 텍스트가 없을 때는 `thinking...`만 표시한다. 텍스트가 들어오기 시작하면 바로 마크다운 렌더 + `▌`로 전환한다. `receiving N chars...` 단계를 제거하거나, 표시한다면 `응답 수신 중 (N자)` 같이 기술 용어 없이 쓴다.

---

## FP-31. 채팅 영역에서 텍스트를 복사할 수 없다

심각도: **medium**
위치: `packages/tui/src/ui/components/ChatArea.js` 전체

**현재 동작** — ChatArea는 Ink 렌더 트리로 출력된다. 터미널 TUI 특성상 마우스 선택이 대부분의 환경에서 작동하지 않는다. 키보드 복사 전용 기능이 없다.

**마찰 포인트** — 코드 블록, URL, 커맨드 출력을 복사해 다른 곳에 붙여넣을 방법이 없다. `/report`는 파일 저장 방식이라 빠른 복붙에 맞지 않는다.

**제안** — 단기: `/report` 커맨드가 파일로 저장된다는 사실을 힌트로 명시한다. 중기: 마지막 어시스턴트 응답을 클립보드에 복사하는 슬래시 커맨드(`/copy`)를 추가한다.

---

## FP-32. MarkdownText가 목록과 이탤릭을 렌더하지 못한다 — **resolved (2026-04-12)**

심각도: **medium**
위치: `packages/tui/src/ui/components/MarkdownText.js`

**해소 확인**
`MarkdownText.js`가 확장되어 다음 마크다운 요소를 처리한다.

- 인라인: `*italic*`, `_italic_`(단어 경계 보호로 `a_b_c` 오탐 방지), `[text](url)`(괄호 depth 스캔으로 URL 추출)
- 블록: `-`/`*` 로 시작하는 줄 → `•` 불릿 변환, 숫자 목록 보존, 들여쓰기 반영

중첩 emphasis(예: `***bold italic***`)는 미지원 — flat 토큰만 처리하는 경량 TUI 렌더러 특성상 의도적 미지원. 테스트 8개 추가(`packages/tui/test/app.test.js`).

**원래 현재 동작** — `parseInline`은 `**bold**`와 `` `inline code` ``만 처리했다. `_italic_`, `*italic*`, `- item` 목록, `[text](url)` 링크는 일반 텍스트로 렌더되었다.

**원래 마찰 포인트** — LLM은 목록, 이탤릭, 링크를 자주 출력한다. `- `, `*`, `_`, `[`, `]` 기호가 그대로 노출되면 유저는 출력이 깨져 보인다고 느낀다.

**원래 제안** — 인라인 파싱에 `*italic*`과 `_italic_`을 추가한다. 블록 파싱에 `- `, `* `, `1. ` 로 시작하는 줄을 목록 항목으로 인식해 들여쓰기와 불릿(`•`)을 붙인다. 링크는 텍스트 부분만 표시해 `[]()` 기호를 숨긴다.

---

## FP-33. 전사(Transcript) 진입 방법이 화면에 노출되지 않는다 — **resolved (2026-04-12)**

심각도: **medium**
위치: `packages/tui/src/ui/App.js:50`, `packages/tui/src/ui/components/TranscriptOverlay.js:68-77`

**해소 확인**
FP-04 해소(2026-04-11) 시 `App.js`에 idle 전용 키 힌트 라인이 신설되었다. idle 상태에서 `Ctrl+T 전사`가 표시된다 (i18n 키: `key_hint.idle`). 추가 구현 없이 이미 해소된 상태를 확인.

**원래 현재 동작** — `Ctrl+T`로 TranscriptOverlay가 열린다. 열린 뒤 헤더에 `[←→ 탭 ↑↓ 스크롤 ^O 상세 ESC 닫기]` 힌트가 표시된다. 닫혀 있는 동안 화면 어디에도 진입 방법 안내가 없다.

**원래 마찰 포인트** — 유저가 이 기능의 존재 자체를 모를 수 있다. `/help`에는 있지만 필요한 순간에 `/help`를 떠올리지 않으면 발견이 어렵다.

**원래 제안** — StatusBar 우측이나 구분선 옆 공간에 `^T 트랜스크립트` 힌트를 dim 색상으로 표시한다. 화면이 좁으면 생략한다.

---

## FP-34. 메시지 50개 상한 초과 시 유저에게 알림이 없다 — **resolved (2026-04-12)**

심각도: **low**
위치: `packages/tui/src/ui/components/ChatArea.js:70-75`

**해소 확인**
`ChatArea`에 truncation 배너가 추가되었다. `MAX_VISIBLE = 50` 초과 시 채팅 영역 최상단에 `↑ N개 이전 메시지 — Ctrl+T에서 확인`을 dim 표시한다 (i18n 키: `chat.truncated`). `t` import 추가 및 `truncatedCount` 계산 후 첫 번째 자식으로 렌더.

**원래 현재 동작** — `MAX_VISIBLE = 50` 초과 시 오래된 메시지가 잘린다(`messages.slice(-MAX_VISIBLE)`). 잘렸다는 사실을 알리는 표시가 없다.

**원래 마찰 포인트** — 유저가 위쪽 내용을 찾으려 스크롤해도 더 이상 올라가지 않는 이유를 알 수 없다.

**원래 제안** — 잘림 발생 시 채팅 영역 최상단에 `(이전 N개 메시지 — Ctrl+T에서 확인)` 한 줄을 dim 표시한다.

---

## FP-35. 입력 히스토리 기능이 /help에 언급되지 않는다 — **resolved (2026-04-12)**

심각도: **low**
위치: `packages/tui/src/ui/components/InputBar.js:40-60`

**해소 확인**
`/help` 단축키 섹션에 `↑↓  입력 히스토리` 행이 추가되었다. `ko.json`과 `en.json`의 `help.commands` 문자열이 수정되었다.

**원래 현재 동작** — `↑/↓`로 이전 입력 최대 50개를 불러올 수 있다. `/help` 출력에 이 기능 언급이 없다.

**원래 마찰 포인트** — 유저가 기능 존재를 모르면 같은 내용을 반복 타이핑하게 된다.

**원래 제안** — `/help` 단축키 항목에 `↑↓  입력 히스토리` 한 줄을 추가한다.

---

## 체크리스트 결과

| 카테고리 | 결과 |
|---------|------|
| 최초 진입 | idle 힌트 라인에 `Ctrl+T 전사` 표시됨 (FP-33 resolved) |
| 도달 경로 | 슬래시 커맨드는 1단계, 전사는 Ctrl+T 단축키 |
| 피드백 | 스트리밍은 `▌`로 표시, 입력 비활성 힌트 추가됨 (FP-29, FP-30 resolved). 잘린 메시지 배너 추가 (FP-34 resolved) |
| 가역성 | ESC로 작업 취소 가능. 히스토리로 이전 입력 복원 가능. /help에 `↑↓ 입력 히스토리` 추가됨 (FP-35 resolved) |
| 상태 가시성 | 비활성 힌트 표시로 개선됨 (FP-29 resolved) |
| 용어 | `receiving N chars...` 제거됨 (FP-30 resolved) |
| 실수 유도 | 비활성 상태 힌트 추가로 개선됨 (FP-29 resolved) |
| 접근성 | 키보드만으로 기능 접근 가능. 텍스트 복사 불가 (FP-31 open) |
| 누락 | 텍스트 복사 방법 없음 (FP-31 open) |
