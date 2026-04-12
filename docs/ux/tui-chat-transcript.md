감사 일자: 2026-04-10
스코프: 채팅/입력/전사
감사자: ux-guardian

---

# TUI 채팅/입력/전사 영역 UX 감사

대상 파일: ChatArea, InputBar, MarkdownText, TranscriptOverlay, transcript/*, report.js
참고 스펙: `docs/specs/tui-server-contract.md`, `docs/specs/session.md`, `docs/specs/planner.md`

## 요약

9개 마찰 포인트 식별. 심각도 분포: high 0(해소 2), medium 0(해소 5), low 0(해소 2).

| 심각도 | open | resolved | 항목 |
|--------|------|----------|------|
| **high** | 0 | 2 | resolved: FP-29, FP-30 |
| **medium** | 0 | 5 | resolved: FP-31, FP-32, FP-33, FP-52, FP-53 |
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

## FP-31. 채팅 영역에서 텍스트를 복사할 수 없다 — **resolved (2026-04-12)**

심각도: **medium**
위치: `packages/tui/src/ui/components/ChatArea.js` 전체

**해소 확인**
`/copy` 슬래시 커맨드가 추가되었다. 마지막 `agent` 또는 `error` role 응답을 `pbcopy`로 클립보드에 복사한다. i18n 키: `copy_cmd.copied`(복사 완료 피드백), `copy_cmd.empty`(복사할 내용 없음). `/help` 출력에 `/copy` 행이 추가되었다.

**원래 현재 동작** — ChatArea는 Ink 렌더 트리로 출력된다. 터미널 TUI 특성상 마우스 선택이 대부분의 환경에서 작동하지 않는다. 키보드 복사 전용 기능이 없다.

**원래 마찰 포인트** — 코드 블록, URL, 커맨드 출력을 복사해 다른 곳에 붙여넣을 방법이 없다. `/report`는 파일 저장 방식이라 빠른 복붙에 맞지 않는다.

**원래 제안** — 단기: `/report` 커맨드가 파일로 저장된다는 사실을 힌트로 명시한다. 중기: 마지막 어시스턴트 응답을 클립보드에 복사하는 슬래시 커맨드(`/copy`)를 추가한다.

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
| 피드백 | 스트리밍은 `▌`로 표시, 입력 비활성 힌트 추가됨 (FP-29, FP-30 resolved). 잘린 메시지 배너 추가 (FP-34 resolved). LLM truncation 시 경고 표시됨 (FP-52 resolved) |
| 가역성 | ESC로 작업 취소 가능. 히스토리로 이전 입력 복원 가능. /help에 `↑↓ 입력 히스토리` 추가됨 (FP-35 resolved) |
| 상태 가시성 | 비활성 힌트 표시로 개선됨 (FP-29 resolved) |
| 용어 | `receiving N chars...` 제거됨 (FP-30 resolved) |
| 실수 유도 | 비활성 상태 힌트 추가로 개선됨 (FP-29 resolved) |
| 접근성 | 키보드만으로 기능 접근 가능. `/copy` 커맨드로 클립보드 복사 가능 (FP-31 resolved) |
| 누락 | `/copy` 슬래시 커맨드 추가로 클립보드 복사 경로 확보됨 (FP-31 resolved) |

---

## [FP-52] KG-09 연계 — LLM truncation 시 유저에게 경고 없음 (2026-04-12) — **resolved (2026-04-12)**

**관련 KG**: KG-09 (LLM 응답 max_tokens 미설정 → truncation)
**심각도**: medium
**영역**: `packages/tui/src/ui/components/ChatArea.js` + StatusBar retry 경로

**해소 확인**

- `sse-parser`가 `finish_reason: "length"` 감지 → `truncated` 플래그를 전파한다.
- `streamingUi.set({ status: 'truncated' })`로 truncation 상태가 설정된다.
- 유저에게 응답이 길이 제한으로 잘렸음을 알리는 경고가 표시된다.
- `max_tokens`가 assembly budget에서 API까지 전달되어 truncation 발생 빈도 자체가 줄어들었다.

**원래 관찰**

`useAgentState.js:74`에 retry 발생 시 `activity: 'retry N/M...'`가 StatusBar에 노출된다. 즉, retry 자체는 유저에게 보인다.

그러나 `finish_reason: "length"` 와 `"stop"` 을 구분하지 않아 다음 두 가지 UX 마찰이 발생했다:

1. **최종 응답이 truncation으로 끊긴 경우** — retry가 모두 소진되거나 재조립에 실패하면 짧아진 응답이 그냥 출력된다. 유저는 응답이 중간에 잘렸다는 사실을 알 수 없다.
2. **retry 중 진행 상황** — StatusBar에 `retry 2/3...` 은 표시되지만 "왜 다시 시도 중인지" (JSON 파싱 실패인지, LLM이 응답을 잘랐는지) 알 수 없다.

**원래 제안**

truncation으로 인한 retry가 발생할 때 StatusBar activity 또는 retry 완료 후 system 메시지로 "응답이 잘려 다시 요청 중" 안내를 추가한다. 최종 응답이 truncation으로 끊긴 경우 응답 아래에 경고 한 줄(`[응답이 길이 제한으로 잘렸습니다]`)을 표시한다.

---

## [FP-53] KG-10 연계 — Iterations 탭에서 retry 중복 번호 혼란 (2026-04-12) — **resolved (2026-04-12)**

**관련 KG**: KG-10 (Planner retry 시 iteration index 중복 기록)
**심각도**: medium
**영역**: `packages/tui/src/ui/components/transcript/iterations.js:16`, `packages/tui/src/ui/report.js:83`

**해소 확인**

- `iterationHistory`에 `retryAttempt` 필드가 추가되었다.
- `iterations.js`에서 `retryAttempt > 0`이면 헤더에 `(retry N)` 태그를 표시한다.
- `report.js`에서도 동일한 `(retry N)` 태그가 표시된다.
- 유저는 Iterations 탭과 `/report` 양쪽에서 retry 발생 여부와 횟수를 구분할 수 있다.

**원래 관찰**

`iterations.js`가 각 항목의 헤더를 `── Iteration ${iter.iteration + 1} ──` 로 렌더했다 (line 16). retry 시 동일 `iter.iteration` 값이 두 번 이상 기록되면 Iterations 탭에 `── Iteration 2 ──` 가 연속으로 두 번 나타났다.

유저 시나리오: 멀티턴 작업 중 에이전트가 retry를 수행했을 때 `Ctrl+T` → Iterations 탭에서 이력을 확인하려 한다. 동일 번호가 중복 등장하면 "몇 번 retry가 발생했는지"를 세기 어렵고 어떤 것이 최종 결과인지 혼란스럽다.

`report.js:83`도 동일하게 `iter.iteration + 1` 을 사용하므로 `/report` 출력에서도 같은 중복이 발생한다.

**원래 제안**

iteration 헤더에 배열 내 표시 순서(index)와 실제 `iter.iteration` 번호를 함께 표시한다. 예: `── [표시 1] Iteration 2 (retry) ──`. 또는 동일 번호가 중복될 때 `(retry)` 태그를 붙인다. KG-10 해소(서버 측 index 중복 수정) 이후에도 UI 레이어에서 방어적으로 표시 순서를 별도로 유지하는 것이 안전하다.
