감사 일자: 2026-04-10
스코프: 채팅/입력/전사
감사자: ux-guardian

---

# TUI 채팅/입력/전사 영역 UX 감사

대상 파일: ChatArea, InputBar, MarkdownText, TranscriptOverlay, transcript/*, report.js
참고 스펙: `docs/specs/tui-server-contract.md`, `docs/specs/session.md`, `docs/specs/planner.md`

## 요약

13개 마찰 포인트 식별. 심각도 분포: high 1(해소 4), medium 1(해소 5), low 1(해소 3).

| 심각도 | open | resolved | 항목 |
|--------|------|----------|------|
| **high** | 0 | 4 | resolved: FP-29, FP-30, FP-57, FP-58 |
| **medium** | 1 | 5 | open: FP-55 / resolved: FP-31, FP-32, FP-33, FP-52, FP-53 |
| **low** | 1 | 3 | open: FP-56 / resolved: FP-34, FP-35, FP-54 |

(REGISTRY: FP-55, FP-56, FP-57, FP-58)

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

---

## [FP-55] StatusBar의 retry 활동 표시가 영어 하드코딩 — **open (2026-04-14)**

**심각도**: medium
**영역**: `packages/tui/src/ui/hooks/useAgentState.js:74`
**상태**: open

### 시나리오

유저가 에이전트와 대화 중 LLM 파싱 실패나 응답 오류로 에이전트가 자동 재시도한다. StatusBar에 진행 상태가 표시되는데 `retry 1/3...`처럼 영어 텍스트가 그대로 나온다.

### 현재 동작

`useAgentState.js:74`에서 retry 정보를 받으면 activity 를 다음과 같이 설정한다:

```js
setActivity(`retry ${info.attempt}/${info.maxRetries}...`)
```

이 문자열이 그대로 StatusBar `activity` prop으로 전달되어 화면에 표시된다. 예: `⠋ retry 2/3...`

### 마찰 포인트

1. `retry`는 영어다. 한글 UI 전체에서 이 한 단어만 영어로 노출된다.
2. "retry"가 무엇을 의미하는지(왜 다시 시도하는지) 알 수 없다. 유저는 "에러가 난 건지, 정상 동작인지" 구분이 어렵다.
3. FP-51(스트리밍 thinking... 영어)은 해소됐는데 retry 활동 표시는 누락 상태다.

### 제안

`setActivity(t('status.retrying', { attempt: info.attempt, max: info.maxRetries }))` 형태로 i18n 이관한다. 예: `⠋ 재시도 중 2/3`.

### 근거

나머지 상태 표시(`thinking`, `streaming`, `reconnecting`)는 모두 i18n을 통해 한글로 표시된다. retry만 예외인 상태다. 일관성이 없으면 유저는 언어 혼란을 겪고 앱이 불완전하다는 인상을 받는다.

---

## [FP-56] Iterations 탭과 디버그 리포트에 영어 필드명 직접 노출 — **open (2026-04-14)**

**심각도**: low
**영역**: `packages/tui/src/ui/components/transcript/iterations.js:22`, `packages/tui/src/ui/components/transcript/op-chain.js:75`, `packages/tui/src/ui/report-sections.js:25`
**상태**: open

### 시나리오

유저가 에이전트 응답이 이상하다고 느끼고 `Ctrl+T` → Iterations 탭을 열어 내용을 확인하려 한다. 또는 `/report`로 저장된 파일을 열어 이력을 분석한다.

### 현재 동작

Iterations 탭의 각 iteration 메타 정보가 다음과 같이 표시된다:

```
  parsedType: direct_response
  stepCount:  3
```

Op Chain 탭의 마지막 줄:
```
└─ Finish Turn (120ms)
```

`/report` 파일의 Iterations 섹션:
```
- **Parsed type:** direct_response
- **Result:** direct_response
```

### 마찰 포인트

1. `parsedType`, `stepCount`, `Finish Turn`, `retry N` — 모두 코드 내부 필드명 또는 영어 리터럴이다.
2. `parsedType: direct_response` 와 `parsedType: plan` 은 일반 유저에게 무의미하다. 화면을 보고 "직접 응답이란 무엇인가?"를 이해할 수 없다.
3. TranscriptOverlay Turn 탭에서는 `debug.parsedType`이 i18n(`t('transcript.result_direct')`, `t('transcript.result_plan')`)으로 변환되나, Iterations 탭(`iterations.js:22`)과 리포트(`report-sections.js:25`)에서는 원시 값이 그대로 노출된다.

### 제안

- `iterations.js`와 `report-sections.js`의 `parsedType` 표시에 Turn 탭과 동일한 i18n 변환을 적용한다. `'unknown'` 폴백도 `t('transcript.unknown_type')`으로 이관.
- `op-chain.js:75`의 `Finish Turn` 문자열을 `t('transcript.finish_turn')` i18n 키로 이관.
- `useAgentState.js:74`의 `retry N/M...`은 FP-55에서 별도 다룬다.

### 근거

디버그 탭과 리포트는 유저가 문제를 진단하는 주요 경로다. 이 화면에서 내부 용어가 노출되면 유저가 원인을 이해하기 어렵다. Turn 탭은 이미 한글 변환을 하는데 Iterations 탭과 리포트만 누락된 상태는 일관성 결여다.

---

## [FP-57] TranscriptOverlay Iterations 탭에서 ↑/↓ 스크롤 시 화면 프레임 스태킹 — **resolved (2026-04-15)**

**심각도**: high
**영역**: `packages/tui/src/ui/components/TranscriptOverlay.js`, `packages/tui/src/ui/components/transcript/iterations.js`
**상태**: resolved (2026-04-15)

### 시나리오

유저가 `Ctrl+T`로 전사 오버레이를 열고 Iterations 탭으로 전환 후 ↑/↓ 화살표로 스크롤을 시도한다.

### 현재 동작 (해소 전)

첫 렌더링은 정상이지만, ↑/↓를 누르는 순간 헤더("── 트랜스크립트 ")와 탭 바가 수직으로 여러 번 겹쳐 쌓이면서 화면이 완전히 깨졌다. 좁은 터미널일수록 증상이 심각했다.

### 원인

- `TranscriptOverlay.js:53`의 `visible = tab.data.slice(scrollOffset, scrollOffset + viewHeight)`는 "아이템 개수" 단위 슬라이스
- `viewHeight = rows - 4`는 "터미널 행 수" 단위
- Iterations 탭의 각 iteration은 `buildIterationMeta`가 `\n`으로 4-5줄 합친 단일 Text 요소를 반환(`iterations.js:20-29`) + `buildIterationResponse`는 멀티라인 Box 반환(`iterations.js:36-45`)
- 결과: 1 아이템 = 4-10 터미널 행 → 슬라이스된 아이템 수 × 실제 행 수 ≫ 터미널 rows → Ink 인라인 렌더가 터미널을 초과 출력 → 이전 프레임이 scrollback으로 밀려나며 스태킹

### 해소

- `packages/tui/src/ui/components/transcript/iterations.js`를 `buildIterationLines`로 전면 재작성 — 평탄한 `{ text, color }` 라인 배열 반환, 각 라인은 `\n` 없음 보장
- `TranscriptOverlay.js`의 Iterations 탭을 `mode: 'lines'`로 전환 (elements 모드 제거)
- 멀티라인 response는 `split('\n')`으로 개별 행 분해
- 테스트 `packages/tui/test/app.test.js` 20c-20g 갱신 (367 passed)
- 관련 커밋: 미커밋 (변경 작업 완료 상태)

### 근거

스크롤 단위(아이템 수)와 화면 단위(터미널 행 수)의 불일치가 프레임 스태킹을 유발했다. 라인 단위 평탄화로 두 단위를 통일하면 슬라이스 경계가 항상 터미널 행 수와 일치하므로 초과 출력이 발생하지 않는다. 화면이 깨지는 high 심각도 마찰이었으며, 스크롤 자체가 불가능한 수준이었다.

---

## [FP-58] 메인 뷰 응답 대기/스트리밍 중 화면 깜빡임 — **resolved (2026-04-16)**

**심각도**: high
**영역**: `packages/tui/src/ui/components/StatusBar.js`, `packages/tui/src/ui/hooks/useAgentState.js`, `packages/tui/src/ui/components/ChatArea.js`
**상태**: resolved (2026-04-16)

### 시나리오

유저가 채팅을 입력하고 Enter 를 누른다. 응답이 스트리밍되어 오는 동안 화면 전체가 주기적으로 깜빡인다. 특히 대화가 길어질수록 깜빡임이 두드러진다.

### 원인

메인 에이전트가 `ink-testing-library frames` 배열 + 실환경 WS patch trace (`PRESENCE_TRACE_PATCHES=1`) 로 단계적 측정해서 세 가지 주원인을 확정:

1. **StatusBar spinner `setInterval(100ms)`** — spinner 프레임 변경이 매 100ms 마다 setState 호출 → React re-render → Ink 가 전체 frame 을 stdout 으로 erase+rewrite. 측정: working 1 초당 frame writes = 10.
2. **Streaming chunk 60ms 주기** — LLM 서버가 WS 로 토큰 단위 streaming 을 60ms 간격으로 push. MirrorState.applyPatch → useAgentState.setStreaming → App re-render. 측정: `_streaming` patch 가 1 초에 16 회.
3. **완료된 대화 메시지가 매 re-render 에 포함** — 30+ 라인의 frame 전체가 매번 erase+rewrite 대상. Ink 의 log-update standard 모드는 부분 업데이트 불가.

### 해소

1. **StatusBar**: `setInterval` + `useState/useEffect/useRef` 제거. `SPINNER_FRAMES`/`formatElapsed` 삭제. 정적 `◌` indicator 로 대체. working/reconnecting 상태 식별은 `activity` 라벨로 충분.
2. **useAgentState**: `_streaming` handler 에 200ms trailing throttle 적용. null 전환 (시작/종료) 은 즉시 flush, 중간 chunk 는 200ms 간격으로 최신 값만 반영. 16 Hz → 5 Hz.
3. **ChatArea**: `<Static>` 컴포넌트로 전환. 완료된 메시지는 scrollback 에 append-only 로 렌더, 이후 dynamic frame rewrite 대상에서 제외. transient 메시지만 dynamic 으로 유지.

부수 변경:
- App 루트의 `height: '100%'` 제거 (frame 이 터미널 행 수로 강제 확장되던 것)
- `keyHintLine` / `streamingView` 를 조건부 null 대신 placeholder 로 렌더해 frame 높이 고정

### 테스트

`packages/tui/test/app.test.js` 에 측정 기반 회귀 테스트 4건 추가:
- idle 1s frame writes ≤ 2
- working idle 2s frame writes ≤ 2
- streaming 16 chunks/1s frame writes ≤ 8 (throttle 검증)
- spinner working 1s frame writes ≤ 15

377 passed.

### Trade-off

- **Ctrl+O tool toggle 은 과거 tool 에 적용되지 않음** — Static 은 append-only 라 이미 렌더된 아이템을 재렌더 불가. 새로 나올 tool 부터 토글 반영. 이 regression 은 체감상 무시 가능 (대부분 유저는 직전 tool 에만 관심).
- **`CHAT.MAX_VISIBLE` 절단 경고 제거** — Static 은 전체 메시지를 scrollback 에 쌓으므로 유저가 터미널 scroll 로 직접 확인 가능. 오히려 개선.

### 관련 파일

진단 도구 (영구 보존):
- `packages/tui/diag/measure-writes.js` — 실제 TTY 에서 stdout.write 호출 계측
- `packages/tui/diag/measure-patches.js` — MirrorState patch 수신 계측 (독립 실행형)
- `PRESENCE_TRACE_PATCHES=1` 환경변수 — `remote-session.js` 에 내장된 mirror patch 로거 활성화 → `/tmp/presence-patches.log` 기록

### 근거

Ink 인라인 모드는 부분 프레임 업데이트를 지원하지 않고 매 commit 마다 전체 frame 을 erase+rewrite 한다. 프레임이 작으면 시지각 임계 아래지만, 대화 UI 는 본질적으로 프레임이 크다. 해결책은 (a) 재렌더 빈도 낮추기 (throttle), (b) 프레임 자체 축소 (Static). 두 가지를 병행해야 완전한 해소.
