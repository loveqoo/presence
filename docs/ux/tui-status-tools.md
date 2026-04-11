감사 일자: 2026-04-10
스코프: 상태/도구/승인
감사자: ux-guardian

---

# TUI 상태·도구·승인 영역 UX 감사

## 관찰 방법

대상 파일: StatusBar.js, SidePanel.js, ApprovePrompt.js, ToolResultView.js, PlanView.js, CodeView.js,
App.js, useAgentState.js, useSlashCommands.js, slash-commands.js, slash-commands/statusline.js,
slash-commands/memory.js, transcript/turn.js
참고 스펙: op-interpreter.md, mcp-tools.md, planner.md, todo-state.md

시나리오 경로:
  서버 상태 확인 → 도구 실행 요청 → 승인 프롬프트 → 결과 확인 → 플랜 리뷰 → 코드 diff 검토 → 사이드패널 토글/탐색

---

## 마찰 포인트 목록

### [FP-01] 심각도: high | StatusBar.js:58 | 에러 상태에서 원인을 알 수 없음 — **resolved (2026-04-11)**

**해소 확인**
`StatusBar.js:buildIndicator()`에 `errorHint` prop이 추가되었다. `status === 'error'`일 때 `errorHint`가 있으면 `✗ error: {errorHint}` 형태로 렌더하고, 없으면 기존 `✗ error`를 유지한다.

`App.js`는 `agentState.lastTurn?.tag === 'failure'`일 때 `lastTurn.error.kind`를 `errorHint`로 StatusBar에 전달한다. 노출되는 ERROR_KIND 값: `planner_parse`, `planner_shape`, `interpreter`, `max_iterations`.

렌더 예시:
```
✗ error: interpreter │ mock-model │ presence-scenario │ branch: main
```

유저는 이제 에러 분류를 StatusBar에서 즉시 볼 수 있다. 에러 상세(스택 트레이스 등)는 여전히 `/report`로 확인 가능하며, 두 경로가 역할을 분담한다.

테스트: `packages/tui/test/app.test.js` 14b, 14c(StatusBar errorHint 렌더), 64번(App에서 lastTurn 경유 전달).

**원래 현상**
`status === 'error'`일 때 StatusBar는 `'✗ error'`만 표시한다. 에러 내용이나 원인은 없다.

**원래 시나리오**
유저가 메시지를 보낸다 → 에이전트가 실패한다 → StatusBar에 `✗ error`가 표시된다 → 유저는 무슨 일이 생겼는지 알 수 없다.

**원래 제안**
에러 발생 시 StatusBar에 짧은 원인 힌트가 함께 표시되어야 한다. 예: `✗ error: timeout`. 길면 말줄임 처리. 또는 에러 상태에서 Esc를 누르면 에러 상세가 ChatArea에 system 메시지로 나타나는 경로가 있어야 한다.

---

### [FP-02] 심각도: high | ApprovePrompt.js:7-9 | 승인 거부 후 결과 피드백 없음 — **resolved (2026-04-11, 커밋 eb82174)**

**해소 확인**
`App.js:55-60` `handleApprove(approved)` 콜백에서 결정 직후 `addMessage({ role: 'system', content: \`${tag} ${desc}\` })`를 호출한다. `tag`는 i18n `approve.approved_log`/`approve.rejected_log` (`[승인됨]`/`[거부됨]`). `desc`는 `agentState.approve.description` 그대로.

재현 프레임(`docs/ux/frames/mock/approve-prompt/04-거부-입력-n-ChatArea에-거부-기록이-남아야-함.txt`):
```
  [거부됨] shell_exec rm -rf /Users/testuser
```
시나리오 4/4 통과(README.md 확인).

**원래 현상**
`[n]`을 눌러 거부하면 `onResolve(false)`가 호출된다. 이후 화면에 "거부됨"이라는 피드백이 보이지 않는다. `ApprovePrompt` 컴포넌트 자체는 사라지지만 ChatArea에 결과가 기록되지 않는다.

**원래 시나리오**
LLM이 파일을 삭제하려 한다 → `APPROVE: 파일 삭제` 프롬프트가 뜬다 → 유저가 `n`을 누른다 → 화면에서 프롬프트가 사라진다 → 유저는 "실제로 거부된 건지, 아니면 그냥 닫힌 건지" 알 수 없다.

**잔여 관찰 사항**
`addMessage`는 TUI local 메시지 배열에만 추가되며 서버 세션 `conversationHistory`에는 포함되지 않는다. 세션을 전환하거나 TUI를 재시작하면 `[승인됨]`/`[거부됨]` 기록이 사라진다. 현재 세션 내 즉시 피드백으로는 충분하나, 감사 로그가 필요한 시나리오(긴 자동화 작업 후 결과 검토)에서는 누락이 된다. 즉시 마찰 수준은 아니므로 현재 FP-02 해소 기준을 만족한다고 판단한다. 필요 시 후속 FP로 별도 등록.

---

### [FP-03] 심각도: high | ApprovePrompt.js:12-18 | 위험 수준이 모든 승인 요청에 동일하게 표시됨 — **resolved (2026-04-11, 커밋 eb82174)**

**해소 확인**
`ApprovePrompt.js:8-18` `classifyRisk(description)`로 2단계 분류:
- `HIGH_RISK_PATTERNS`: `shell_exec`, `rm -`, `file_write/delete`, `sudo`, `delete`, `DROP TABLE`
- high → 빨간 double border + `⚠⚠ 위험 — 승인 요청: `
- normal → 노란 single border + `⚠ 승인 요청: `

재현 프레임 비교:
- `02-*.txt` (file_read): 노란 single border, `⚠ 승인 요청:` — 일반 레이블 정상
- `03-*.txt` (shell_exec rm -rf): 빨간 double border(`╔═…╗`), `⚠⚠ 위험 — 승인 요청:` — HIGH RISK 레이블 정상

시나리오 4/4 통과.

**해소 품질 평가**

*위험도 2단계의 충분성*
현재 high/normal 2단계는 "행동 필요 vs 참고" 구분으로 충분하다. medium 단계를 추가하면 유저가 3가지 색상/형태를 구분해야 하므로 인지 부담이 높아진다. 2단계 유지가 적절하다.

*색맹/단색 터미널 구분 가능성*
border style(double vs single)이 색상과 함께 두 번째 신호로 작동한다. 색을 구분하지 못하는 환경에서도 `╔═…╗`(double)와 `┌─…┐`(single)의 글자 형태 차이로 위험도를 구별할 수 있다. 색 단독 의존이 아니므로 접근성 기준을 만족한다.

*`HIGH_RISK_PATTERNS` 커버리지*
`curl ... | sh`, `chmod 777`, `kill -9`, `git push --force`, `truncate`, `mkfs` 등 누락 패턴은 FP-46으로 등록되었으며 2026-04-11 해소되었다. 패턴이 6개 → 21개로 확장되어 false normal 리스크가 대폭 감소했다(아래 FP-46 참조).

**원래 현상**
`⚠ APPROVE:` 앞에 노란색 bold 경고가 항상 동일하게 표시된다. 파일 읽기 승인이든 외부 쉘 실행 승인이든 같은 포맷이다. 위험도 차이가 시각적으로 없다.

**원래 시나리오**
`file_read /tmp/safe.txt` 승인과 `shell_exec rm -rf ~/` 승인이 같은 시각적 형식으로 표시된다 → 유저는 두 요청의 위험 수준 차이를 화면에서 즉시 인지할 수 없다.

---

### [FP-04] 심각도: medium | App.js:47-52 | Ctrl+O 토글 키가 화면에 표시되지 않음 — **resolved (2026-04-12)**

**해소 확인**
`App.js`의 InputBar 하단과 StatusBar 사이에 idle 전용 키 힌트 라인이 신설되었다.

idle 상태 기본 표시:
```
/help 커맨드 · Ctrl+T 전사 · Ctrl+O 도구 상세
```

transient 메시지가 표시 중일 때는 접미 추가:
```
/help 커맨드 · Ctrl+T 전사 · Ctrl+O 도구 상세 · Esc 임시메시지 닫기
```

working / approve / disconnected 상태에서는 힌트 라인 숨김 (InputBar가 이미 상황별 힌트를 표시하므로 중복 방지).

i18n 키: `key_hint.idle`, `key_hint.transient` (ko.json).

테스트: `packages/tui/test/app.test.js` 63c(idle 힌트 표시), 63d(working 숨김), 63e(disconnected 숨김).

부수 효과: `tool-result-expand` 시나리오 step 3 "펼침 키 안내가 보이는가?" assertion이 7/7 통과 (이전 6/7).

**원래 현상**
도구 결과 펼침/접힘은 `Ctrl+O`로 토글된다(`App.js:50`). 그러나 이 키 바인딩이 화면 어디에도 표시되지 않는다. StatusBar, InputBar, ChatArea 모두 이 키를 안내하지 않는다.

**원래 시나리오**
유저가 도구 결과를 자세히 보고 싶다 → 어떤 키를 눌러야 하는지 모른다 → `/help`를 쳐봐야 알 수 있다.

**원래 제안**
`/help` 출력에 Ctrl+O(도구 펼침), Ctrl+T(트랜스크립트 오버레이), Esc(취소) 등 키 바인딩을 포함해야 한다. 또는 InputBar 하단에 힌트 라인을 두어 자주 쓰는 키를 상황에 따라 표시한다.

---

### [FP-05] 심각도: medium | PlanView.js:31-44 | Op 코드가 화면에 직접 노출됨

**현상**
`formatStepLabel`이 `EXEC`, `ASK_LLM`, `RESPOND`, `APPROVE`, `DELEGATE`, `LOOKUP_MEMORY` 등 내부 Op 코드를 그대로 표시한다. 예: `EXEC file_read(path: "/tmp/test.txt")`, `ASK_LLM "분석해줘..."`.

**시나리오**
에이전트가 플랜을 실행하는 동안 유저는 `EXEC`, `ASK_LLM` 같은 내부 표현을 본다 → 기술적 의미를 모르는 유저는 이것이 무엇인지 알 수 없다.

**제안**
Op 코드를 유저 언어로 번역해야 한다:
- `EXEC file_read` → `파일 읽기: /tmp/test.txt`
- `ASK_LLM` → `AI 분석 중...`
- `LOOKUP_MEMORY` → `기억 검색 중...`
- `DELEGATE` → `하위 에이전트 위임: {target}`
- `RESPOND` → `응답 생성 중`

**근거**
UX 원칙 1: 내부 구현 용어가 화면에 보이는 순간 UX 실패다.

---

### [FP-06] 심각도: medium | SidePanel.js:57-62 | 이벤트 큐 상태만 표시되고 deadLetter는 노출 안 됨

**현상**
SidePanel의 Events 섹션은 `events.queue.length`만 표시한다. `todo-state.md` E9에 따르면 `deadLetter`에 쌓인 이벤트는 자동 재처리가 없고 수동 개입이 필요하다. 그러나 SidePanel에 deadLetter 개수가 표시되지 않는다.

**시나리오**
외부 이벤트 처리가 실패한다 → deadLetter에 쌓인다 → 유저는 사이드패널을 열어도 이 사실을 알 수 없다 → 주의가 필요한 상태가 숨겨진다.

**제안**
deadLetter에 이벤트가 있을 때 Events 섹션에 경고 표시가 있어야 한다. 예: `큐: 0개 | 실패: 2개` (빨간색).

**근거**
`todo-state.md` E9: "deadLetter에 쌓인 이벤트는 수동 개입 또는 `/status` 확인 필요"라고 명시. 수동 개입이 필요한 상태는 화면에서 능동적으로 알려야 한다.

---

### [FP-07] 심각도: medium | SidePanel.js:46-55 | TODOs 항목에 상태 정보가 없음

**현상**
SidePanel의 TODOs 섹션은 `t.title || t.type`만 표시한다. `todo-state.md`의 TODO 구조에는 `category`, `status` 필드가 있다. 상태(ready/done/blocked 등)가 표시되지 않는다.

**시나리오**
유저가 사이드패널을 열어 TODO 목록을 본다 → 항목 제목만 보인다 → 어떤 것이 완료되었고 어떤 것이 대기 중인지 알 수 없다.

**제안**
TODO 항목에 상태 아이콘을 붙여야 한다. 예: `○ 보고서 작성` (대기), `✓ 이메일 확인` (완료). `policies.js`의 TODO.STATUS_READY 상수를 활용.

**근거**
할 일 목록에서 상태가 빠지면 목록의 가치가 반감된다. "뭘 해야 하는가"와 "뭘 했는가"가 구분되어야 한다.

---

### [FP-08] 심각도: medium | slash-commands.js:80 | /status 출력에 내부 필드명이 노출됨

**현상**
`/status` 커맨드 출력: `status: idle | turn: 3 | mem: 12 | last: none`.
- `mem`은 메모리 노드 개수인데 레이블이 불명확하다.
- `last: none`의 `none`이 무엇을 의미하는지 맥락 없이 표시된다.
- `last: failure`가 표시될 때 유저는 `failure`가 무엇을 뜻하는지 알 수 없다.

**시나리오**
유저가 `/status`를 쳐서 상태를 확인한다 → `last: failure`를 본다 → 마지막 턴이 실패했다는 것인지, 에러 상태인지 판단하기 어렵다.

**제안**
- `mem: 12` → `메모리: 12개` 또는 `memories: 12`
- `last: failure` → `마지막 결과: 실패` 또는 `last turn: failed`
- `last: none` → `last turn: (없음)` 또는 생략

**근거**
내부 태그 값(`failure`, `success`, `none`)이 그대로 노출되면 유저가 의미를 추론해야 한다.

---

### [FP-09] 심각도: medium | App.js:47-49 | Esc 키의 동작이 상태에 따라 다른데 안내가 없음 — **resolved (2026-04-12)**

**해소 확인**
두 가지 마찰이 모두 해소되었다.

1. **Esc 힌트 노출**: FP-04와 동일한 idle 전용 힌트 라인에서 transient 메시지 활성 시 `· Esc 임시메시지 닫기`가 접미로 추가된다. i18n 키: `key_hint.transient`.

2. **취소 피드백**: working 상태에서 Esc를 누르면 `onCancel()` 호출 후 `addMessage({ role: 'system', content: t('key_hint.cancelled') })`로 "작업이 취소되었습니다" system 메시지가 ChatArea에 남는다. 이전에는 아무 피드백 없이 작업만 중단되었다. i18n 키: `key_hint.cancelled`.

테스트: `packages/tui/test/app.test.js` 63c(idle 힌트 표시), 63d(working 힌트 숨김), 63e(disconnected 힌트 숨김).

**원래 현상**
```
if (key.escape && agentState.status === 'working' && onCancel) onCancel()     // 작업 취소
if (key.escape && agentState.status !== 'working') clearTransientMessages()   // transient 메시지 제거
```
같은 Esc 키가 상황에 따라 완전히 다른 동작을 한다. 화면에는 어떤 안내도 없다.

**원래 시나리오**
에이전트가 작업 중이다 → 유저가 실수로 Esc를 누른다 → 작업이 취소된다 → 유저는 왜 작업이 멈췄는지 알 수 없다. 또는 transient 메시지를 보는 중에 Esc를 누르면 메시지가 사라진다 → 유저는 "왜 내용이 사라졌지?"라고 혼란스러워한다.

**원래 제안**
- 작업 중일 때: InputBar 또는 StatusBar에 `[Esc] 취소` 힌트 표시
- transient 메시지 표시 중: 메시지 하단에 `[Esc] 닫기` 힌트 표시
- 작업 취소 후: "작업이 취소되었습니다" system 메시지를 ChatArea에 표시

---

### [FP-10] 심각도: medium | ToolResultView.js:172-176 | collapsed 상태임을 유저가 알 수 없음

**현상**
도구 결과가 collapsed 상태일 때 `tool   > file_read /tmp/test.txt — 42 lines` 형식으로 표시된다. 이것이 요약(접힌 상태)인지 전체인지 화면에서 구분이 안 된다.

**시나리오**
유저가 도구 결과를 본다 → 한 줄 요약이 보인다 → 더 보고 싶은데 어떻게 펼치는지 모른다 → Ctrl+O를 모르면 접힌 상태임도 인지하기 어렵다.

**제안**
collapsed 상태에 접힘 표시(`▶`)를 붙이고, expanded 상태에 `▼`를 붙여 토글 가능함을 암시한다. 예: `▶ tool > file_read /tmp/test.txt — 42 lines`. 또는 첫 사용 시 한 번 `[Ctrl+O] 도구 결과 펼치기` 힌트를 표시한다.

**근거**
도구 결과 탐색의 진입점이 숨겨진 키 바인딩(Ctrl+O)이고, 접힌 상태임을 알리는 시각 신호도 없어 기능 발견성이 매우 낮다.

---

### [FP-11] 심각도: low | SidePanel.js:34-38 | 도구 8개 초과 시 나머지가 `+N more`로만 표시됨

**현상**
도구가 9개 이상이면 `+N more`로 잘린다. 숨겨진 도구를 보는 방법이 없다.

**시나리오**
유저가 어떤 도구를 사용할 수 있는지 확인하고 싶다 → SidePanel에 8개만 보인다 → `+3 more`라고 나온다 → 나머지를 보려면 `/tools`를 쳐야 한다.

**제안**
`+N more` 옆에 `(/tools로 전체 보기)` 힌트를 추가하거나, SidePanel에서 스크롤이 가능하면 더 자연스럽다. 현재 SidePanel은 정적 렌더링이므로, 적어도 경로 안내 텍스트가 있어야 한다.

**근거**
기능이 있어도 진입 경로를 모르면 없는 것과 같다.

---

### [FP-12] 심각도: low | statusline.js:5-11 | /statusline 피드백이 영어 필드명만 표시됨

**현상**
`/statusline` 출력:
```
statusline items: status, budget, model, dir, branch (status: always on)
available: turn, mem, tools
usage: /statusline +item  /statusline -item
```
`turn`, `mem`, `tools`, `budget`, `dir`, `branch`, `model` 등 내부 필드명이 그대로 노출된다.

**시나리오**
유저가 `/statusline`을 쳐서 현재 상태표시줄 항목을 확인한다 → `mem`이 무엇인지, `turn`이 무엇인지 맥락 없이 표시된다.

**제안**
각 항목에 설명을 붙인다. 예: `mem (메모리 노드 수)`, `turn (현재 턴 번호)`, `tools (등록 도구 수)`.

**근거**
내부 필드명이 곧 유저 인터페이스가 되어선 안 된다.

---

### [FP-13] 심각도: low | CodeView.js:185-208 | maxLines=80 초과 시 스크롤 불가

**현상**
`CodeView`는 최대 80줄까지만 표시하고 초과분은 `... +N lines`로 잘린다. 잘린 내용을 볼 방법이 없다.

**시나리오**
에이전트가 200줄짜리 파일을 읽는다 → ToolResultView가 expanded 상태에서 CodeView를 보여준다 → 80줄 이후는 `... +120 lines`로 잘린다 → 유저는 나머지 내용을 볼 수 없다.

**제안**
잘린 파일 내용을 볼 방법(TranscriptOverlay 또는 별도 오버레이)이 있어야 한다. 또는 `... +120 lines (원본: /path/to/file)` 형식으로 경로를 표시하여 유저가 직접 파일을 열 수 있게 안내한다.

**근거**
TUI 환경에서 스크롤이 어려운 것은 이해할 수 있으나, 잘린 내용에 접근하는 경로 자체가 없다는 점이 문제다.

---

### [FP-14] 심각도: high | StatusBar.js:9-34 | 현재 세션이 화면 어디에도 표시되지 않음 — **resolved (2026-04-11)**

**해소 확인**
FP-14 수정 완료. 아래 변경 사항이 코드에 반영되어 있음:
- `DEFAULT_ITEMS`: `['status', 'session', 'budget', 'model', 'dir', 'branch']` — session이 기본 표시 항목에 포함
- `TOGGLEABLE_ITEMS`: `['session', 'turn', 'mem', 'tools', 'budget', 'dir', 'branch', 'model']` — `/statusline +session` / `-session` 토글 가능
- `buildSegment` `case 'session'`: `ctx.sessionId` 가 있으면 `session: {sessionId}` 형식 표시, 없으면 null(숨김) — `sessionName` fallback 제거됨 (YAGNI: 서버 세션 모델에 name 필드 없음)
- App.js: `sessionId` prop이 StatusBar에 전달됨

**해소 후 프레임** (`docs/ux/frames/mock/session-switch/05-전환-후-화면-현재-세션-가시성.txt`):
```
● idle │ session: work │ mock-model │ presence-scenario │ branch: main
```
시나리오 `session-switch.scenario.js` 5/5 통과. step 5 assertion이 `statusLine.includes('session: work')`로 명확히 고정되어 있어 회귀 감지 가능.

---

**잔여 관찰 사항 (후속 FP 후보)**

1. **`sessionName` 경로 제거됨 — 단일 경로로 정리**
   `sessionName` prop, ctx 필드, fallback이 모두 제거되었다. `session: ${sessionId}` 단일 경로로 통일. 서버 세션 모델(`GET /api/sessions`, `POST /api/sessions`)에 `name` 필드가 없으며, 유저가 세션에 별명을 붙이는 기능 자체가 존재하지 않으므로 YAGNI 원칙에 부합한다. 별명 기능이 향후 필요해지면 그 시점에 별도 FP로 등록한다.

2. **긴 세션 ID가 StatusBar 레이아웃을 압박할 수 있음**
   `DEFAULT_ITEMS`에 session이 포함되면서 StatusBar 세그먼트가 `status | session | budget | model | dir | branch` 6개로 늘었다. 터미널 너비가 좁을 때(`< 100컬럼`) `testuser-default` 같은 17자 세션 ID가 다른 세그먼트와 충돌할 여지가 있다. Ink는 넘치면 줄바꿈하므로 StatusBar가 두 줄로 렌더될 수 있다. 실 환경에서 재현 시 별도 FP로 기록할 것.

3. **`/statusline` 도움말에 session 항목 설명이 없음**
   `statusline.js`의 `cmdShow`는 아이템 키 목록만 나열하고 각 항목이 무엇을 표시하는지 설명하지 않는다. `session`이 기본 항목에 추가되었으나 `/statusline`을 쳐보면 `statusline items: status, session, budget, model, dir, branch (status: always on)` 처럼 `session`이 내부 키 이름 그대로 노출된다. 이 문제는 FP-12(기존 open 상태)와 동일 범주이므로 FP-12 해소 시 함께 다루어야 한다.

---

**원래 시나리오 기록 (감사 근거)**
유저가 `/sessions new work`로 작업용 세션을 만들고 `/sessions switch work`로 전환한다 → 전환 직후에도 StatusBar에는 `● idle │ mock-model │ presence-scenario │ branch: main` 뿐이다 → 현재 세션이 `work`인지 `testuser-default`인지 알 방법은 `/sessions list`를 매번 치는 것뿐이다.

**근거**
presence는 "서버 1개 = 유저 N명" + 유저별 멀티세션이 핵심이다. 멀티세션 아키텍처에서 현재 세션 가시성은 가장 기본적인 요건이며, 이것이 없으면 세션을 여러 개 만드는 의미가 없다. 이 갭은 파일 단위 감사에서 놓쳤고, 시나리오 기반 감사(session-switch.scenario.js)로 드러났다.

---

### [FP-15] 심각도: medium | StatusBar.js:56-60, App.js:74-82 | 스트리밍 수신 중에도 StatusBar가 "thinking..."을 유지

**현상**
`_streaming.content`가 이미 도착하여 ChatArea에 마크다운으로 렌더되고 있는 중에도, StatusBar의 indicator는 `⠦ thinking... 0s`를 유지한다. "생각 중"이라는 문구는 content가 전혀 없을 때(진짜 사고 단계)에만 적합하다.

**시나리오**
유저가 질문을 보낸다 → 잠시 후 응답 텍스트가 ChatArea에 실시간으로 찍히기 시작한다 → 그럼에도 StatusBar는 계속 `thinking...` → 유저 입장에서는 "텍스트가 나오고 있는데 왜 아직 생각 중이지?" 라는 모순된 신호를 받는다.

**재현 프레임**: `docs/ux/frames/mock/streaming-response/05-스트리밍-content-도착-마크다운-렌더로-전환.txt`
```
  오늘 서울의 날씨는 맑습니다. 기온은 섭씨 22도이며 습도는 낮은 편입니다.▌
 ──────────────────────────────────────────────────────────────────────────────
 >
 ──────────────────────────────────────────────────────────────────────────────
 ⠦ thinking... 0s │ mock-model │ presence-scenario │ branch: main
```

**제안**
`deriveStatus`/`buildIndicator`에 스트리밍 단계를 구분한다:
- `turnState=working` + `_streaming.content`가 비어있음 → `thinking...`
- `turnState=working` + `_streaming.content`가 있음 → `streaming...` 또는 `응답 중...`
- `turnState=working` + `_streaming.status === 'receiving'` + `content` 없음 → `receiving...`

**근거**
StatusBar의 indicator는 유저에게 시스템이 무엇을 하고 있는지 알리는 1차 신호다. 실제 진행 단계와 indicator 문구가 일치하지 않으면 신호 자체를 신뢰하지 못하게 된다.

---

### [FP-46] **resolved (2026-04-11)** | 심각도: low | ApprovePrompt.js:8-15 | HIGH_RISK_PATTERNS 커버리지 미흡

**현상**
`classifyRisk`의 `HIGH_RISK_PATTERNS`가 대표적인 위험 패턴만 포함하고 있다. 현재 포함: `shell_exec`, `rm -`, `file_write/delete`, `sudo`, `delete`, `DROP TABLE`.

누락된 위험 패턴 예시:
- `curl ... | sh` — 원격 스크립트 즉시 실행
- `chmod 777` — 권한 전체 개방
- `kill -9` / `pkill` — 프로세스 강제 종료
- `git push --force` — 원격 히스토리 파괴
- `truncate` — 파일 내용 삭제
- `mkfs` — 파일시스템 포맷

**시나리오**
에이전트가 `curl https://example.com/install.sh | sh`를 실행하려 한다 → 현재 패턴에 매칭되지 않아 normal 레이블(노란 single border)로 표시된다 → 유저는 이것이 위험한 명령임을 즉시 인지하지 못한다.

**마찰 포인트**
위험도 구분 자체(FP-03)는 해결됐으나, "위험"으로 분류되는 범위가 좁아 false normal(실제로 위험한데 normal로 표시) 케이스가 존재한다. FP-03 해소의 완성도 문제이므로 심각도는 low(기능 자체는 있고, 커버리지만 좁음).

**제안**
`HIGH_RISK_PATTERNS`에 추가:
- `/\bcurl\b.*\|\s*(ba)?sh\b/i`
- `/\bchmod\s+[0-7]*7[0-7][0-7]\b/i`
- `/\bkill\s+-9\b/i`
- `/\bpkill\b/i`
- `/\bgit\s+push\s+.*--force\b/i`
- `/\btruncate\b/i`
- `/\bmkfs\b/i`

패턴 확장은 `ApprovePrompt.js`만 수정하면 되며 시나리오 테스트에 `curl | sh` 케이스를 추가해 회귀를 막는 것이 권장된다.

**근거**
false normal은 경고 시스템에서 false negative와 같다. 위험한 작업이 일반 승인으로 표시되면 FP-03이 제거하려 했던 "경고 피로"가 반대 방향으로 재발한다.

**해소 확인 (2026-04-11)**
`HIGH_RISK_PATTERNS` 6개 → 21개로 확장. 추가된 패턴: `curl|wget ... | sh|bash|zsh|ksh|dash`, `chmod 777/666/X7Y7`, `chmod -R`, `kill -9`, `pkill`, `git push --force/-f`, `git reset --hard`, `truncate`, `mkfs`, `dd if=`, `> /dev/sd[a-z]`, `DROP DATABASE/SCHEMA`, `TRUNCATE`. 단위 테스트 56-57(HIGH 14개 + 음성 3개) 및 시나리오 step 4(`curl ... | sh` 회귀)로 커버리지 검증됨.

---

### 기존 FP의 시나리오 재현 증거

다음 FP들은 시나리오 기반 감사로 실제 프레임이 확보되어 근거가 강화되었다.

| FP | 재현 시나리오 | 증거 프레임 |
|----|---------------|-----------|
| **FP-02** (resolved) 승인 거부 후 피드백 없음 | `approve-prompt` | `04-*.txt` — `[거부됨] shell_exec rm -rf /Users/testuser` 정상 표시 |
| **FP-03** (resolved) 위험도 구분 없는 승인 UI | `approve-prompt` | `02-*.txt`(normal) vs `03-*.txt`(HIGH RISK) — border style·색상 모두 다름 |
| **FP-04/10** 접힘 상태 가시성 / 키바인딩 미노출 | `tool-result-expand` | `03-*.txt` — `file_read — 120 lines` 요약만 있고 `Ctrl+O` 힌트 없음 |
| **(기존 감사 누락 / FP-2 in tui-chat-transcript.md)** `receiving N chars...` 내부 용어 노출 | `streaming-response` | `03-*.txt` — `receiving 42 chars...` 문자 그대로 |

시나리오는 `packages/tui/test/scenarios/`에 정의되어 있으며 `npm run scenarios:mock`으로 재실행할 수 있다. 프레임이 `docs/ux/frames/mock/` 아래 저장되므로 git diff로 UI 회귀 감지가 가능하다.

---

## 시나리오별 흐름 평가 요약

| 시나리오 | 평가 | 주요 마찰 포인트 |
|---------|------|----------------|
| 서버 상태 확인 | 보통 | **FP-01 해소** (에러 분류 즉시 표시). 잔여: /status 레이블 불명확 (FP-08) |
| 도구 실행 요청 | 보통 | Op 코드 직접 노출 (FP-05), collapsed 상태 미인지 (FP-10) |
| 승인 프롬프트 | **양호** | **FP-02, FP-03, FP-46 모두 해소. 잔여 마찰 없음** |
| 결과 확인 | 보통 | **FP-04 해소** (힌트 라인 신설). 잔여: collapsed 상태 가시성 (FP-10) |
| 플랜 리뷰 | 나쁨 | Op 코드 노출 (FP-05) |
| 코드 diff 검토 | 보통 | 80줄 제한 (FP-13) |
| 사이드패널 토글/탐색 | 보통 | deadLetter 미표시 (FP-06), TODO 상태 없음 (FP-07), 도구 목록 잘림 (FP-11) |
| 세션 전환 | 보통 | FP-14 해소. 잔여: 긴 세션 ID 레이아웃 압박(관찰 중), /statusline 설명 누락(FP-12 범주) |
| 응답 스트리밍 | 보통 | indicator 라벨 부정확 (FP-15) |

## 심각도별 집계 (2026-04-12 업데이트)

| 심각도 | open | resolved | 항목 |
|--------|------|----------|------|
| **high** | 0 | 4 | resolved: FP-01, FP-02, FP-03, FP-14 |
| **medium** | 6 | 2 | open: FP-05, FP-06, FP-07, FP-08, FP-10, FP-15 / resolved: FP-04, FP-09 |
| **low** | 3 | 1 | open: FP-11, FP-12, FP-13 / resolved: FP-46 |
