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
| FP-04  | open     | medium   | ux   | Ctrl+O 토글 키가 화면에 표시되지 않음                      | docs/ux/tui-status-tools.md         |
| FP-05  | open     | medium   | ux   | Op 코드가 화면에 직접 노출됨                               | docs/ux/tui-status-tools.md         |
| FP-06  | open     | medium   | ux   | 이벤트 큐 상태만 표시되고 deadLetter는 노출 안 됨           | docs/ux/tui-status-tools.md         |
| FP-07  | open     | medium   | ux   | TODOs 항목에 상태 정보가 없음                              | docs/ux/tui-status-tools.md         |
| FP-08  | open     | medium   | ux   | /status 출력에 내부 필드명이 노출됨                         | docs/ux/tui-status-tools.md         |
| FP-09  | open     | medium   | ux   | Esc 키의 동작이 상태에 따라 다른데 안내가 없음               | docs/ux/tui-status-tools.md         |
| FP-10  | open     | medium   | ux   | collapsed 상태임을 유저가 알 수 없음                        | docs/ux/tui-status-tools.md         |
| FP-11  | open     | low      | ux   | 도구 8개 초과 시 나머지가 +N more로만 표시됨                 | docs/ux/tui-status-tools.md         |
| FP-12  | open     | low      | ux   | /statusline 피드백이 영어 필드명만 표시됨                    | docs/ux/tui-status-tools.md         |
| FP-13  | open     | low      | ux   | maxLines=80 초과 시 스크롤 불가                             | docs/ux/tui-status-tools.md         |
| FP-14  | resolved | high     | ux   | 현재 세션이 화면 어디에도 표시되지 않음                       | docs/ux/tui-status-tools.md         |
| FP-15  | open     | medium   | ux   | 스트리밍 수신 중에도 StatusBar가 "thinking..."을 유지         | docs/ux/tui-status-tools.md         |
| FP-16  | resolved | high     | server | 서버 연결 실패 시 원인 불명확                             | docs/ux/tui-entry-shell.md          |
| FP-17  | open     | medium   | ux   | 결정된 서버 URL이 화면에 보이지 않음                          | docs/ux/tui-entry-shell.md          |
| FP-18  | open     | medium   | ux   | 비밀번호 마스킹 불완전                                      | docs/ux/tui-entry-shell.md          |
| FP-19  | open     | medium   | ux   | 로그인 실패 시 남은 시도 횟수 미표시                          | docs/ux/tui-entry-shell.md          |
| FP-20  | open     | low      | ux   | 비밀번호 변경 실패 시 횟수 미표시                             | docs/ux/tui-entry-shell.md          |
| FP-21  | open     | medium   | ux   | 로그인 후 무피드백 대기 구간                                 | docs/ux/tui-entry-shell.md          |
| FP-22  | resolved | high     | server | WS 복구 불가 시 침묵 — 입력 무응답 상태 지속              | docs/ux/tui-entry-shell.md          |
| FP-23  | open     | medium   | ux   | WS 재연결 중 상태 미표시                                     | docs/ux/tui-entry-shell.md          |
| FP-24  | open     | medium   | ux   | 인증 만료 후 재로그인 안내 없음                               | docs/ux/tui-entry-shell.md          |
| FP-25  | open     | low      | ux   | Escape 키 역할 미표시                                        | docs/ux/tui-entry-shell.md          |
| FP-26  | open     | low      | ux   | Ctrl+T / Ctrl+O 키바인딩 미노출                              | docs/ux/tui-entry-shell.md          |
| FP-27  | open     | low      | ux   | TranscriptOverlay 닫기 시 화면 깜박임                        | docs/ux/tui-entry-shell.md          |
| FP-28  | open     | low      | server | authRequired=false Dead Code 분기                          | docs/ux/tui-entry-shell.md          |
| FP-29  | resolved | high     | ux   | 입력 비활성 상태를 유저가 인지하기 어렵다                      | docs/ux/tui-chat-transcript.md      |
| FP-30  | resolved | high     | ux   | 스트리밍 중 "receiving N chars..." 내부 용어 노출             | docs/ux/tui-chat-transcript.md      |
| FP-31  | open     | medium   | ux   | 채팅 영역에서 텍스트를 복사할 수 없다                          | docs/ux/tui-chat-transcript.md      |
| FP-32  | open     | medium   | ux   | MarkdownText가 목록과 이탤릭을 렌더하지 못한다                  | docs/ux/tui-chat-transcript.md      |
| FP-33  | open     | medium   | ux   | 전사(Transcript) 진입 방법이 화면에 노출되지 않는다             | docs/ux/tui-chat-transcript.md      |
| FP-34  | open     | low      | ux   | 메시지 50개 상한 초과 시 유저에게 알림이 없다                   | docs/ux/tui-chat-transcript.md      |
| FP-35  | open     | low      | ux   | 입력 히스토리 기능이 /help에 언급되지 않는다                    | docs/ux/tui-chat-transcript.md      |
| FP-36  | resolved | high     | ux   | / 입력 시 커맨드 힌트 없음                                    | docs/ux/tui-slash-commands.md       |
| FP-37  | resolved | high     | ux   | /sessions switch 성공 피드백 없음                             | docs/ux/tui-slash-commands.md       |
| FP-38  | open     | medium   | server | /memory help가 구현되지 않은 기능 안내                      | docs/ux/tui-slash-commands.md       |
| FP-39  | open     | medium   | ux   | /memory clear 기간 표현 영어 하드코딩                          | docs/ux/tui-slash-commands.md       |
| FP-40  | open     | medium   | ux   | /statusline 변경 후 현재 구성 미표시                           | docs/ux/tui-slash-commands.md       |
| FP-41  | open     | medium   | ux   | 세션 커맨드 오류 시 언어 전환                                  | docs/ux/tui-slash-commands.md       |
| FP-42  | open     | medium   | server | 알 수 없는 슬래시 커맨드가 에이전트로 전달됨                 | docs/ux/tui-slash-commands.md       |
| FP-43  | open     | low      | ux   | /help에 /mcp 커맨드 누락                                      | docs/ux/tui-slash-commands.md       |
| FP-44  | open     | low      | ux   | /sessions list에 세션 이름 미표시                              | docs/ux/tui-slash-commands.md       |
| FP-45  | open     | low      | server | debug, opTrace 등 내부 용어 잠재적 노출                      | docs/ux/tui-slash-commands.md       |
| FP-46  | resolved | low      | tui  | HIGH_RISK_PATTERNS 커버리지 미흡 (curl pipe sh, chmod 777 등) | docs/ux/tui-status-tools.md         |

## Known Gaps (KG)

| ID     | Status | Severity | Area   | Title                                                      | Source                                         |
|--------|--------|----------|--------|------------------------------------------------------------|------------------------------------------------|
| KG-01  | open   | high     | server | 401 자동 refresh 실패 후 재로그인 유도 미구현                | docs/specs/tui-server-contract.md#I5           |
| KG-02  | open   | medium   | server | authRequired=false 분기 미도달 (dead code)                   | docs/specs/tui-server-contract.md#E4           |
| KG-03  | open   | medium   | server | POST /sessions type 파라미터 SESSION_TYPE 검증 부재           | docs/specs/session.md#E11                      |
| KG-04  | open   | high     | infra  | 유저 삭제 시 Memory orphan 남음                               | docs/specs/session.md#E13                      |
| KG-05  | open   | low      | infra  | Repl의 메모리 조회가 userId 인자 없이 호출 (미사용 경로)       | docs/specs/memory.md#I9                        |
| KG-06  | open   | medium   | infra  | PRESENCE_DIR 환경변수 변경 후 이전 경로 데이터 미접근          | docs/specs/data-persistence.md#E8              |
| KG-07  | resolved | medium | server | 재연결 중 pending approve Promise 가 서버 측에 hang             | docs/specs/approve.md#E4                       |

## 통계

- FP 총 **46개** — open **35**, resolved **11** (FP-01, FP-02, FP-03, FP-14, FP-16, FP-22, FP-29, FP-30, FP-36, FP-37, FP-46)
- KG 총 **7개** — open **6**, resolved **1** (KG-07)
- Severity 분포 (open만): high **0**, medium **24**, low **11** (FP) + high **2**, medium **3**, low **1** (KG)

## 변경 이력

- 2026-04-11: 초기 생성. FP 45개, KG 6개 import. 파일 처리 순서는 `tui-status-tools.md` 먼저 → FP-14 (현재 세션 표시, resolved) 의 기존 커밋(`6c6c1dc`) 참조 보존.
- 2026-04-11: FP-02 (거부 피드백), FP-03 (위험도 구분) resolved — ApprovePrompt 위험도 분류 + handleApprove 에서 system 메시지 기록.
- 2026-04-11: FP-46 추가 — HIGH_RISK_PATTERNS 커버리지 미흡 (FP-03 의 후속 잔여). spec-guardian/ux-guardian 리뷰에서 식별.
- 2026-04-11: FP-46 resolved — HIGH_RISK_PATTERNS 21개로 확장 (curl|sh, chmod 777/-R, kill -9, pkill, git push --force, git reset --hard, truncate, mkfs, dd if=, > /dev/sd*, DROP DATABASE, TRUNCATE 등). 시나리오 회귀 케이스 추가.
- 2026-04-11: KG-07 추가 — 재연결 중 pending approve Promise 가 서버 측에 hang (approve.md E4). spec-guardian 식별, 별도 fix 작업 필요.
- 2026-04-11: FP-01 / FP-16 / FP-22 resolved — "에러 가시성" 클러스터. StatusBar errorHint(ERROR_KIND) 표시, checkServer err.code 보존 + main.js 힌트 포매팅, onUnrecoverable → App 배너 + InputBar 차단.
- 2026-04-11: FP-29 / FP-30 / FP-36 / FP-37 resolved — "상태 인지" 클러스터. InputBar disabled 힌트(응답 대기/승인 필요/연결 끊김), 스트리밍 "receiving N chars" 제거 → thinking 통일, `/` 입력 시 slash tip 표시, 세션 전환 성공 메시지 주입. 남은 high FP 0건.
- 2026-04-11: KG-07 resolved — spec 재검증 결과 버그가 아님. `stripTransient` 는 disk persistence 에만 적용되고 WS init snapshot 은 `_approve` 를 포함. 서버 test S20 이 재연결 후 `_approve` 복원 + POST /approve → turn 완료까지 전 흐름을 검증. approve.md E4 문구 정정 예정.
