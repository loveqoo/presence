# 티켓 레지스트리

presence 프로젝트의 작업 항목(UX 마찰점 · 스펙 Known Gap)을 전역 유일 ID로 관리하는 단일 진실의 원천.

## 운영 규칙

- **정의**: 항목의 본문은 `Source` 에 있는 문서에 산다. 이 레지스트리는 인덱스이자 라이프사이클 트래커다.
- **ID 부여**: 새 티켓 추가 시 `scripts/tickets.sh next-id [fp|kg]` 로 다음 번호 확인. `FP-XX` / `KG-XX` 는 한번 부여되면 **재사용 금지** (resolved 된 것도 번호 유지).
- **소스 역참조**: 소스 문서의 항목 옆에 `(REGISTRY: FP-14)` 같은 표기를 둔다. 레지스트리 → 소스, 소스 → 레지스트리 양방향 링크.
- **상태 동기화**: status 변경 시 반드시 같은 커밋에서 레지스트리 + 소스 문서 둘 다 갱신.
- **검증**: `scripts/tickets.sh check` 는 pre-commit 훅에서 중복/고아/동기화 누락을 자동 감지.
- **스펙 불변식(I 항목)은 포함하지 않음**: I 는 라이프사이클이 없는 선언이다. 이 레지스트리는 "라이프사이클이 있는 작업" 만 다룬다.

## 범례

- **Type**: `fp` (UX friction point) / `known-gap` (스펙 Known Gap)
- **Status**: `open` / `resolved` / `wontfix`
- **Severity**: `high` / `medium` / `low`
- **Area**: `tui` / `server` / `infra` / `ux` / `spec`

## Friction Points (FP)

| ID     | Status   | Severity | Area | Title                                                    | Source                              |
|--------|----------|----------|------|----------------------------------------------------------|-------------------------------------|
| FP-01  | resolved | high     | ux   | 에러 상태에서 원인을 알 수 없음                            | docs/ux/tui-status-tools.md         |
| FP-02  | resolved | high     | ux   | 승인 거부 후 결과 피드백 없음                              | docs/ux/tui-status-tools.md         |
| FP-03  | resolved | high     | ux   | 위험 수준이 모든 승인 요청에 동일하게 표시됨                 | docs/ux/tui-status-tools.md         |
| FP-04  | resolved | medium   | ux   | Ctrl+O 토글 키가 화면에 표시되지 않음                      | docs/ux/tui-status-tools.md         |
| FP-05  | resolved | medium   | ux   | Op 코드가 화면에 직접 노출됨                               | docs/ux/tui-status-tools.md         |
| FP-06  | resolved | medium   | ux   | 이벤트 큐 상태만 표시되고 deadLetter는 노출 안 됨           | docs/ux/tui-status-tools.md         |
| FP-07  | resolved | medium   | ux   | TODOs 항목에 상태 정보가 없음                              | docs/ux/tui-status-tools.md         |
| FP-08  | resolved | medium   | ux   | /status 출력에 내부 필드명이 노출됨                         | docs/ux/tui-status-tools.md         |
| FP-09  | resolved | medium   | ux   | Esc 키의 동작이 상태에 따라 다른데 안내가 없음               | docs/ux/tui-status-tools.md         |
| FP-10  | resolved | medium   | ux   | collapsed 상태임을 유저가 알 수 없음                        | docs/ux/tui-status-tools.md         |
| FP-11  | resolved | low      | ux   | 도구 8개 초과 시 나머지가 +N more로만 표시됨                 | docs/ux/tui-status-tools.md         |
| FP-12  | resolved | low      | ux   | /statusline 피드백이 영어 필드명만 표시됨                    | docs/ux/tui-status-tools.md         |
| FP-13  | resolved | low      | ux   | maxLines=80 초과 시 스크롤 불가                             | docs/ux/tui-status-tools.md         |
| FP-14  | resolved | high     | ux   | 현재 세션이 화면 어디에도 표시되지 않음                       | docs/ux/tui-status-tools.md         |
| FP-15  | resolved | medium   | ux   | 스트리밍 수신 중에도 StatusBar가 "thinking..."을 유지         | docs/ux/tui-status-tools.md         |
| FP-16  | resolved | high     | server | 서버 연결 실패 시 원인 불명확                             | docs/ux/tui-entry-shell.md          |
| FP-17  | resolved | medium   | ux   | 결정된 서버 URL이 화면에 보이지 않음                          | docs/ux/tui-entry-shell.md          |
| FP-18  | resolved | medium   | ux   | 비밀번호 마스킹 불완전                                      | docs/ux/tui-entry-shell.md          |
| FP-19  | resolved | medium   | ux   | 로그인 실패 시 남은 시도 횟수 미표시                          | docs/ux/tui-entry-shell.md          |
| FP-20  | resolved | low      | ux   | 비밀번호 변경 실패 시 횟수 미표시                             | docs/ux/tui-entry-shell.md          |
| FP-21  | resolved | medium   | ux   | 로그인 후 무피드백 대기 구간                                 | docs/ux/tui-entry-shell.md          |
| FP-22  | resolved | high     | server | WS 복구 불가 시 침묵 — 입력 무응답 상태 지속              | docs/ux/tui-entry-shell.md          |
| FP-23  | resolved | medium   | ux   | WS 재연결 중 상태 미표시                                     | docs/ux/tui-entry-shell.md          |
| FP-24  | resolved | medium   | ux   | 인증 만료 후 재로그인 안내 없음                               | docs/ux/tui-entry-shell.md          |
| FP-25  | resolved | low      | ux   | Escape 키 역할 미표시                                        | docs/ux/tui-entry-shell.md          |
| FP-26  | resolved | low      | ux   | Ctrl+T / Ctrl+O 키바인딩 미노출                              | docs/ux/tui-entry-shell.md          |
| FP-27  | resolved | low      | ux   | TranscriptOverlay 닫기 시 화면 깜박임                        | docs/ux/tui-entry-shell.md          |
| FP-28  | resolved | low      | server | authRequired=false Dead Code 분기                          | docs/ux/tui-entry-shell.md          |
| FP-29  | resolved | high     | ux   | 입력 비활성 상태를 유저가 인지하기 어렵다                      | docs/ux/tui-chat-transcript.md      |
| FP-30  | resolved | high     | ux   | 스트리밍 중 "receiving N chars..." 내부 용어 노출             | docs/ux/tui-chat-transcript.md      |
| FP-31  | resolved | medium   | ux   | 채팅 영역에서 텍스트를 복사할 수 없다                          | docs/ux/tui-chat-transcript.md      |
| FP-32  | resolved | medium   | ux   | MarkdownText가 목록과 이탤릭을 렌더하지 못한다                  | docs/ux/tui-chat-transcript.md      |
| FP-33  | resolved | medium   | ux   | 전사(Transcript) 진입 방법이 화면에 노출되지 않는다             | docs/ux/tui-chat-transcript.md      |
| FP-34  | resolved | low      | ux   | 메시지 50개 상한 초과 시 유저에게 알림이 없다                   | docs/ux/tui-chat-transcript.md      |
| FP-35  | resolved | low      | ux   | 입력 히스토리 기능이 /help에 언급되지 않는다                    | docs/ux/tui-chat-transcript.md      |
| FP-36  | resolved | high     | ux   | / 입력 시 커맨드 힌트 없음                                    | docs/ux/tui-slash-commands.md       |
| FP-37  | resolved | high     | ux   | /sessions switch 성공 피드백 없음                             | docs/ux/tui-slash-commands.md       |
| FP-38  | resolved | medium   | server | /memory help가 구현되지 않은 기능 안내                      | docs/ux/tui-slash-commands.md       |
| FP-39  | resolved | medium   | ux   | /memory clear 기간 표현 영어 하드코딩                          | docs/ux/tui-slash-commands.md       |
| FP-40  | resolved | medium   | ux   | /statusline 변경 후 현재 구성 미표시                           | docs/ux/tui-slash-commands.md       |
| FP-41  | resolved | medium   | ux   | 세션 커맨드 오류 시 언어 전환                                  | docs/ux/tui-slash-commands.md       |
| FP-42  | resolved | medium   | server | 알 수 없는 슬래시 커맨드가 에이전트로 전달됨                 | docs/ux/tui-slash-commands.md       |
| FP-43  | resolved | low      | ux   | /help에 /mcp 커맨드 누락                                      | docs/ux/tui-slash-commands.md       |
| FP-44  | resolved | low      | ux   | /sessions list에 세션 이름 미표시                              | docs/ux/tui-slash-commands.md       |
| FP-45  | resolved | low      | server | debug, opTrace 등 내부 용어 잠재적 노출                      | docs/ux/tui-slash-commands.md       |
| FP-46  | resolved | low      | tui  | HIGH_RISK_PATTERNS 커버리지 미흡 (curl pipe sh, chmod 777 등) | docs/ux/tui-status-tools.md         |
| FP-47  | resolved | high     | tui  | /copy 커맨드가 messages 미전달로 항상 실패                     | docs/ux/tui-slash-commands.md       |
| FP-48  | open     | medium   | tui  | /mcp 커맨드 피드백 영어 하드코딩                               | docs/ux/tui-slash-commands.md       |
| FP-49  | open     | low      | tui  | /report 저장 피드백 영어 하드코딩                              | docs/ux/tui-slash-commands.md       |
| FP-50  | open     | medium   | tui  | /copy가 macOS 전용 (pbcopy)                                   | docs/ux/tui-slash-commands.md       |
| FP-51  | open     | low      | tui  | 스트리밍 중 thinking... 영어 하드코딩                          | docs/ux/tui-slash-commands.md       |

## Known Gaps (KG)

| ID     | Status | Severity | Area   | Title                                                      | Source                                         |
|--------|--------|----------|--------|------------------------------------------------------------|------------------------------------------------|
| KG-01  | resolved | high   | server | 401 자동 refresh 실패 후 재로그인 유도 미구현                | docs/specs/tui-server-contract.md#I5           |
| KG-02  | resolved | medium | server | authRequired=false 분기 미도달 (dead code)                   | docs/specs/tui-server-contract.md#E4           |
| KG-03  | resolved | medium | server | POST /sessions type 파라미터 SESSION_TYPE 검증 부재           | docs/specs/session.md#E11                      |
| KG-04  | resolved | high   | infra  | 유저 삭제 시 Memory orphan 남음                               | docs/specs/session.md#I13                      |
| KG-05  | resolved | low    | infra  | Repl의 메모리 조회가 userId 인자 없이 호출 (미사용 경로)       | docs/specs/memory.md#I9                        |
| KG-06  | resolved | medium | infra  | PRESENCE_DIR 환경변수 변경 후 이전 경로 데이터 미접근          | docs/specs/data-persistence.md#E8              |
| KG-07  | resolved | medium | server | 재연결 중 pending approve Promise 가 서버 측에 hang             | docs/specs/approve.md#E4                       |

## 통계

- FP 총 **51개** — open **4**, resolved **47**
- KG 총 **7개** — open **0**, resolved **7** (KG-01, KG-02, KG-03, KG-04, KG-05, KG-06, KG-07)
- Severity 분포 (open만): high **0**, medium **2** (FP-48, FP-50), low **2** (FP-49, FP-51)

## 변경 이력

- 2026-04-11: 초기 생성. FP 45개, KG 6개 import. 파일 처리 순서는 `tui-status-tools.md` 먼저 → FP-14 (현재 세션 표시, resolved) 의 기존 커밋(`6c6c1dc`) 참조 보존.
- 2026-04-11: FP-02 (거부 피드백), FP-03 (위험도 구분) resolved — ApprovePrompt 위험도 분류 + handleApprove 에서 system 메시지 기록.
- 2026-04-11: FP-46 추가 — HIGH_RISK_PATTERNS 커버리지 미흡 (FP-03 의 후속 잔여). spec-guardian/ux-guardian 리뷰에서 식별.
- 2026-04-11: FP-46 resolved — HIGH_RISK_PATTERNS 21개로 확장 (curl|sh, chmod 777/-R, kill -9, pkill, git push --force, git reset --hard, truncate, mkfs, dd if=, > /dev/sd*, DROP DATABASE, TRUNCATE 등). 시나리오 회귀 케이스 추가.
- 2026-04-11: KG-07 추가 — 재연결 중 pending approve Promise 가 서버 측에 hang (approve.md E4). spec-guardian 식별, 별도 fix 작업 필요.
- 2026-04-11: FP-01 / FP-16 / FP-22 resolved — "에러 가시성" 클러스터. StatusBar errorHint(ERROR_KIND) 표시, checkServer err.code 보존 + main.js 힌트 포매팅, onUnrecoverable → App 배너 + InputBar 차단.
- 2026-04-11: FP-29 / FP-30 / FP-36 / FP-37 resolved — "상태 인지" 클러스터. InputBar disabled 힌트(응답 대기/승인 필요/연결 끊김), 스트리밍 "receiving N chars" 제거 → thinking 통일, `/` 입력 시 slash tip 표시, 세션 전환 성공 메시지 주입. 남은 high FP 0건.
- 2026-04-11: KG-07 resolved — spec 재검증 결과 버그가 아님. `stripTransient` 는 disk persistence 에만 적용되고 WS init snapshot 은 `_approve` 를 포함. 서버 test S20 이 재연결 후 `_approve` 복원 + POST /approve → turn 완료까지 전 흐름을 검증. approve.md E4 문구 정정 예정.
- 2026-04-11: FP-17 ~ FP-21 resolved — "진입/로그인 플로우" 클러스터. main.js 단일 파일 수정. resolveServerUrl 이 source 태그 포함 반환 + "연결 중: URL [source]" 출력, promptPassword 완전 mute(길이/backspace 잔류 제거), 로그인/비밀번호 변경 프롬프트에 "N번 남음/마지막 시도" 표기, 로그인 성공 후 "세션을 초기화하는 중..." 출력.
- 2026-04-11: FP-24 resolved — App disconnected 배너가 close code 별로 사유 분기 (4001 "세션이 만료되었습니다", 4002 "비밀번호 변경이 필요합니다", 4003 "접근이 거부되었습니다", 그 외 "서버 연결이 끊겼습니다"). FP-22 배너 위에 이유 문구만 교체.
- 2026-04-11: FP-04/09/25/26 resolved — "키바인딩 가시성" 클러스터. App.js 에 idle 전용 키 힌트 라인 신설 (`/help 커맨드 · Ctrl+T 전사 · Ctrl+O 도구 상세`), transient 메시지 있으면 `Esc 임시메시지 닫기` 추가. Esc 가 working 상태에서 취소 시 "작업이 취소되었습니다" system 메시지 생성. i18n key_hint.* 추가. tool-result-expand 시나리오도 덤으로 7/7 통과.
- 2026-04-12: FP-38/39/40 + FP-12 resolved — "슬래시 커맨드 한글/정확성" 묶음. /memory help 에서 미구현 tier 필터 설명 제거 (FP-38), /memory clear 피드백을 cleared_with_age i18n 키로 이관 (FP-39), /statusline 이 변경 후 전체 구성을 내부 키 설명과 함께 한글로 출력 (FP-40 + 덤으로 FP-12). i18n statusline_cmd.label.* 추가.
- 2026-04-12: FP-05/06/07 + FP-11 resolved — "사이드 패널/Op 라벨 한글화" 묶음. PlanView.formatStepLabel 과 transcript op-chain-format 의 모든 op 라벨/phase 를 i18n plan_op/op_phase/op_label 로 이관 (FP-05). SidePanel 섹션 헤더 한글화 + TODO status 아이콘 (○/✓/⊘/·) 추가 (FP-07) + deadLetter 카운트 빨간색 강조 (FP-06) + /tools 경로 힌트 (FP-11). side-panel 시나리오 4/6 → 6/6.
- 2026-04-12: FP-41/42/43/44/45 resolved — "슬래시 커맨드 인식" 묶음. dispatchSlashCommand 가 `/` 로 시작하는 알 수 없는 입력을 흡수하고 "알 수 없는 커맨드" 한글 안내로 차단 (FP-42, slash-typo 시나리오 해소). /help 에 /mcp 행 추가 (FP-43). /sessions list 가 name 이 id 와 다를 때 함께 표시 (FP-44). sessions/useSlashCommands 의 `Error:` 영어 하드코딩을 slash_cmd.error i18n 으로 이관 (FP-41). FP-45 는 grep 검증으로 debug/opTrace 내부 변수명의 user-facing 노출이 현재 없음을 확인 — 예방 체크 완료.
- 2026-04-12: KG-01 resolved — "인증 실패 수렴 경로" 구현. `createAuthClient` 가 `onAuthFailed` 콜백과 `{ kind: 'AUTH_FAILED' }` sentinel 로 refresh 실패를 구조화, `RemoteSession.markDisconnected(4001)` 로 WS close 4001 과 동일한 disconnected 배너 경로에 수렴. 부트스트랩 단계는 `process.exit(1)` 로 fail-fast. `packages/tui/test/remote.test.js` 신규 (httpFn 주입 기반 단위 테스트).
- 2026-04-12: KG-04 resolved — "유저 삭제 시 Memory orphan" 해소. `packages/infra/src/infra/auth/remove-user.js` 신규 — `removeUserCompletely` 가 memory.clearAll(best effort) → userDir 재귀 삭제 → store.removeUser 3 단계를 수행. `cmdRemove` 는 Config + Memory 인스턴스 부팅 후 호출. `auth-remove-user.test.js` 5 시나리오 커버. 남은 high KG 0 건.
- 2026-04-12: FP-15/FP-23 resolved — "진행 상태 인식" 묶음. FP-15: `useAgentState` 의 `activity='thinking...'` 하드코딩 제거, App 이 `streaming?.content` 유무로 `status.streaming` 라벨을 파생해 StatusBar 에 전달. activity 는 retry override 전용으로 좁아짐. FP-23: MirrorState 가 `_reconnecting` path 를 publish — 지수 백오프 재연결 직전 true, WS open 이후 false. STATE_PATH.RECONNECTING 추가, useAgentState 가 구독, App 이 `reconnecting && !disconnected` 로 전달, StatusBar 가 최우선 분기로 `⠦ 연결 중...` (yellow) 표시. i18n `status.streaming`/`status.reconnecting` 추가. mirror-state RS10/RS11 + app.test.js FP-15/FP-23 섹션 총 22 assertion 추가.
- 2026-04-12: FP-08/FP-10 resolved — "상태/도구 라벨" 묶음. FP-08: `/status` 출력을 i18n 한글화. `formatStatusR` (Reader 모나드)를 `packages/core/src/core/format-status.js`에 공용 함수로 추출, TUI + 서버 양쪽 사용. `status_cmd.*` i18n 키 추가. FP-10: ToolResultView에 프리픽스 상수 3종 (PLAIN/COLLAPSED `▶`/EXPANDED `▼`) 추가, collapsed/expanded 상태를 시각적으로 구별.
- 2026-04-12: FP-33/FP-34/FP-35 resolved — "채팅 영역 안내" 묶음. FP-33: idle 힌트에 `Ctrl+T 전사`가 이미 표시되어 있음을 확인 — 추가 구현 없이 resolved. FP-34: ChatArea에 truncation 배너 추가, MAX_VISIBLE 초과 시 `↑ N개 이전 메시지 — Ctrl+T에서 확인` 표시. `chat.truncated` i18n 키. FP-35: /help 단축키 섹션에 `↑↓ 입력 히스토리` 행 추가.
- 2026-04-12: FP-32 resolved — MarkdownText 렌더링 확장. `parseInline`에 `*italic*`, `_italic_`(단어 경계 보호), `[text](url)`(괄호 depth 스캔) 추가. 블록 레벨에 목록 인식(`-`/`*` → `•`, 숫자 보존). 중첩 emphasis는 미지원(flat 토큰).
- 2026-04-12: FP-31/FP-27/FP-28/FP-13 + KG-02 resolved — "나머지 FP 일괄" 묶음. FP-31: `/copy` 슬래시 커맨드 추가 (마지막 응답 클립보드 복사). FP-27: TranscriptOverlay 닫기 시 `\x1b[2J\x1b[H` 수동 clear 제거. FP-28+KG-02: `authRequired=false` dead branch 제거 (서버 authEnabled=true 고정). FP-13: CodeView truncation 안내에 파일 경로 표시 (`원본: path`). **FP open 0건 달성.**
- 2026-04-12: KG-03/KG-05/KG-06 resolved — "Known Gap 일괄" 묶음. KG-03: POST /sessions에 SESSION_TYPE 화이트리스트 검증 추가 (400 반환). KG-05: Repl/TUI memory 호출에 userId 전달 (I2 불변식 준수). TUI App→useSlashCommands→memory.js 경로에 username prop 추가. KG-06: 서버 부트 시 PRESENCE_DIR 변경 감지 + users.json 존재 확인으로 경고 로그 출력. **KG open 0건 달성.**
- 2026-04-12: FP-47/FP-48/FP-49 추가 — ux-guardian 진단. FP-47: /copy 커맨드 messages 미전달 버그 (high). FP-48: /mcp 피드백 영어 하드코딩 (medium). FP-49: /report 피드백 영어 하드코딩 (low).
- 2026-04-12: FP-47 resolved — useSlashCommands props를 4개 그룹(core/context/ui/session)으로 구조화. `messages`가 `ui` 그룹에 포함되어 `/copy` 커맨드 버그 해소. spec-guardian config.md I7 업데이트 반영.
