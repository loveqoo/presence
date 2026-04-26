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
| FP-48  | resolved | medium   | tui  | /mcp 커맨드 피드백 영어 하드코딩                               | docs/ux/tui-slash-commands.md       |
| FP-49  | resolved | low      | tui  | /report 저장 피드백 영어 하드코딩                              | docs/ux/tui-slash-commands.md       |
| FP-50  | resolved | medium   | tui  | /copy가 macOS 전용 (pbcopy)                                   | docs/ux/tui-slash-commands.md       |
| FP-51  | resolved | low      | tui  | 스트리밍 중 thinking... 영어 하드코딩                          | docs/ux/tui-slash-commands.md       |
| FP-52  | resolved | medium   | tui  | LLM truncation 시 유저에게 경고 없음 (KG-09 연계)                     | docs/ux/tui-chat-transcript.md      |
| FP-53  | resolved | medium   | tui  | Iterations 탭에서 retry 중복 번호 혼란 (KG-10 연계)            | docs/ux/tui-chat-transcript.md      |
| FP-54  | resolved | low      | tui  | /report 에러 iteration 데이터 "?" 미구분 (KG-11 연계)          | docs/ux/tui-slash-commands.md       |
| FP-55  | resolved | medium   | tui  | StatusBar retry 활동 표시 "retry N/M..." 영어 하드코딩          | docs/ux/tui-chat-transcript.md      |
| FP-56  | resolved | low      | tui  | Iterations 탭에 parsedType 등 영어 필드명 직접 노출 (TUI만)     | docs/ux/tui-chat-transcript.md      |
| FP-57  | resolved | high     | tui  | TranscriptOverlay Iterations 탭 ↑/↓ 스크롤 시 프레임 스태킹    | docs/ux/tui-chat-transcript.md      |
| FP-58  | resolved | high     | tui  | 메인 뷰 응답 대기/스트리밍 중 화면 깜빡임                      | docs/ux/tui-chat-transcript.md      |
| FP-59  | resolved | medium   | tui  | Plan EXEC 가 검증되지 않은 URL 을 tool_args 로 생성 (KG-12 연계) | docs/ux/tui-chat-transcript.md      |
| FP-60  | resolved | medium   | tui  | Plan 마지막 ASK_LLM + RESPOND 누락 시 결과 폐기 (KG-13 연계)     | docs/ux/tui-chat-transcript.md      |
| FP-61  | resolved | high     | tui  | 메시지 아키텍처 재설계 — 순서 역전/abort 메시지 소실/cancel flash 해소 | docs/specs/tui-server-contract.md   |
| FP-62  | resolved | medium   | tui  | web_fetch 도구 결과 품질 미점검 — 비정상 응답을 LLM 이 정상으로 처리   | docs/ux/tui-status-tools.md         |
| FP-63  | resolved | high     | tui  | WS close 4004 시 원인·조치 미전달 — allowedDirs 위반 메시지 누락       | docs/ux/tui-entry-shell.md          |
| FP-64  | resolved | medium   | tui  | /sessions new workingDir 거부 시 영어 서버 에러 노출                   | docs/ux/tui-entry-shell.md          |
| FP-65  | resolved | medium   | infra| 경로 차단 에러 메시지가 존재하지 않는 tools.allowedDirs 설정 안내       | docs/ux/tui-status-tools.md         |
| FP-66  | resolved | low      | tui  | StatusBar dir 세그먼트가 TUI cwd 표시 — 실제 워크스페이스와 불일치      | docs/ux/tui-status-tools.md         |
| FP-67  | resolved | medium   | infra| A2A 응답 메시지에 내부 에이전트 ID와 "A2A" 용어가 노출됨                | docs/ux/tui-chat-transcript.md      |
| FP-68  | open     | medium   | tui  | admin 두 번째 세션 거부 시 원문 코드 노출 (`Access denied: admin-singleton`) | docs/ux/tui-slash-commands.md       |
| FP-69  | open     | medium   | tui  | 빈 워크스페이스에서 외부 파일 요청 시 LLM 수렴 루프 + 안내 부재          | docs/ux/tui-status-tools.md         |
| FP-70  | open     | low      | infra| Cedar audit JSONL rotation 운영자 가시성 부재 — 무음 + 상태 조회 경로 없음 | docs/ux/tui-status-tools.md         |

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
| KG-08  | resolved | medium | tui    | 멀티턴 시 중간 LLM 응답이 TranscriptOverlay에 표시되지 않음      | docs/specs/transcript.md#KG-08                 |
| KG-09  | resolved | high   | infra  | LLM 응답 max_tokens 미설정으로 truncation 발생                   | docs/specs/llm-client.md#KG-09                 |
| KG-10  | resolved | medium | core   | Planner retry 시 iteration index 중복 기록                       | docs/specs/planner.md#KG-10                    |
| KG-11  | resolved | low    | tui    | report.js 에러 iteration 데이터 불완전 표시                      | docs/specs/transcript.md#KG-11                 |
| KG-12  | resolved | medium | core   | Plan EXEC tool_args 가 finite 선택 공간 밖 — planner 환각 침투 | docs/specs/planner.md#KG-12                    |
| KG-13  | resolved | medium | core   | Plan 마지막 ASK_LLM + RESPOND 누락 허용 — 수렴 루프 vs LLM 실수 구분 불가 | docs/specs/planner.md#KG-13 |
| KG-14  | resolved | medium | spec   | history entry 의 SYSTEM type 도입으로 스키마 확장 — prompt/compaction 배제 불변식 | docs/specs/tui-server-contract.md   |
| KG-15  | resolved | medium | server | Admin singleton session 강제 미구현 (concurrent approve race 대응)              | docs/specs/agent-identity.md#KG-15 |
| KG-16  | resolved | medium | server | M3 primaryAgentId 미이행 — `{username}/default` hardcode                        | docs/specs/agent-identity.md#KG-16 |
| KG-17  | resolved | high   | server | A2A JWT 서명 검증 stub (`X-Presence-Caller` 헤더) — authz phase 대기            | docs/specs/agent-identity.md#KG-17 |
| KG-18  | resolved | medium | spec   | 5진입점 canAccessAgent 테스트 정적 grep 수준 — 동적 spy 강화 필요                | docs/specs/agent-identity.md#KG-18 |
| KG-19  | resolved | medium | infra  | JobStore 소유권 필터링 누락 — listJobs/updateJob/deleteJob 가 owner 무시         | docs/specs/agent-identity.md#KG-19 |
| KG-20  | resolved | medium | spec   | AgentId branded type 런타임 강제 부재 — validateAgentId 우회 회귀 검증 없음       | docs/specs/agent-identity.md#KG-20 |
| KG-21  | resolved | medium | spec   | Parser→Resolver→Authz 순서 런타임 검증 부재 — resolver 우회 raw target 탐지 불가  | docs/specs/agent-identity.md#KG-21 |
| KG-22  | resolved | low    | infra  | i18n 동적 호출 namespace EN 미정의 — KO 에만 있는 91 키가 EN 미정의, locale=en 시 부분 한글 잔재 | docs/specs/config.md#KG-22 |
| KG-23  | resolved | low    | infra  | Cedar evaluate 호출이 Op ADT 로 wrapping 안 됨 — finite 선택 공간 강제 약화, LLM 직접 트리거 시 우회 위험 | docs/design/cedar-infra.md#KG-23 |
| KG-24  | resolved | low    | infra  | CI-Y6 deny-path 자동화는 정책/엔진 측 deny 능력만 검증 — 호출처 정합성은 GV-Y1~Y4 (governance phase) 와 합쳐야 완전 | docs/design/cedar-infra.md#KG-24 |
| KG-25  | resolved | low    | infra  | Cedar audit JSONL 파일 무한 증가 — rotation policy 부재 (Y' 범위 밖) | docs/design/cedar-infra.md#KG-25 |

## 통계

- FP 총 **70개** — open **3** (FP-68/69/70), resolved **67**
- KG 총 **25개** — open **0**, resolved **25**
- Severity 분포 (open만): medium 2 (FP-68/69) · low 1 (FP-70)

## 변경 이력

- 2026-04-26: FP-68/69/70 추가 (open) — `feature/cedar-governance-v2` UX 감사 (ux-guardian 병렬 호출 3건). FP-68 (medium/tui): KG-15 admin singleton 거부 시 TUI `formatCreateError` (`sessions.js:20-26`) 가 서버 응답의 raw `Access denied: admin-singleton` 을 그대로 노출 — 내부 REASON 상수 값이 사용자에게. 해소 방향 (issue 문서): `session-api.js` 응답에 `reason` 필드 추가 + `sessions_cmd.error.admin_singleton` i18n 키 + formatCreateError 분기. FP-69 (medium/tui): 신규 가입자가 빈 워크스페이스 (`~/.presence/users/{username}/`) 에서 외부 파일 (예: 프로젝트 root 의 `package.json`) 요청 시 LLM 이 도구 에러 후 retry → 120s timeout. 라이브 e2e S2-1 에서 관찰. FP-65/66 의 allowedDirs 안내 와는 분리 — 회복 안내 부재 패턴. FP-70 (low/infra): KG-25 audit rotation 무음 처리 (logger 호출 0) + 운영자가 audit log 상태 조회할 TUI/CLI 경로 없음 + `.gz` 백업 안내 없음. 최소 해소: rotation 시 server.log 한 줄 + admin status 명령에 audit log 정보 추가.
- 2026-04-26: KG-23 resolved — `feature/cedar-governance-v2` 후속. 옵션 1 (형식 일관성) 채택. `Op.CheckAccess` Op constructor (`core/op.js`) + `runCheckAccess(evaluator, op)` standalone runner (`infra/authz/cedar/op-runner.js`) + `checkAccessInterpreterR` 인터프리터 (`infra/interpreter/check-access.js`). 서비스 레이어 (`agent-governance.js submitUserAgent`) 가 Op data 를 만들고 standalone runner 위임 — LLM 시나리오 인터프리터도 같은 runner 위임 = 호출 경로 통일. LLM 경계 밖이라 즉시 보호 효과 0, 형식 일관성만 확보. CK1~CK8 회귀 검증 (`check-access-interpreter.test.js`). UserContext.evaluator 가 prod 인터프리터 env 로 전파.
- 2026-04-26: KG-25 resolved — `feature/cedar-governance-v2` 후속. `audit.js` 에 size-based rotation 구현. 매 `append` 직전 `statSync` size 체크 → `maxBytes` (기본 10MB) 초과 시 cascade rotation: `.maxBackups.gz` 삭제 → `.N.gz → .(N+1).gz` 역순 shift → 현재 → `.1.gz` (gzip + 0600). `maxBackups` 기본 5. CA7~CA11 회귀 (rotation 발생 / cascade 정확성 / 백업 권한 / 기본값 미트리거). 단일 프로세스 가정 — 멀티 프로세스 race 는 Y' 범위 밖.
- 2026-04-26: KG-25 추가 (open) — `cedar-infra.md` v1.2 §7 의 "Audit 로그 무한 증가" 위험 항목이 "KG 등록 후 후속" 으로 명시되어 있던 것을 정식 KG 로 등록. Cedar audit JSONL (`~/.presence/logs/authz-audit.log`) 의 rotation policy 부재 — Y' phase 범위 밖. 1차 옵션 size-based (10MB/5 파일 + gzip), 2차 옵션 time-based (일 단위 + 30 일 보존). 운영 빈도 임계 도달 시 처리.
- 2026-04-26: KG-17 resolved — `feature/cedar-governance-v2` 후속. A2A 라우터 caller 인증을 stub (`X-Presence-Caller` 헤더) → JWT Bearer 토큰으로 교체. `tokenService.signA2aToken(sub)` / `verifyA2aToken(token)` 추가 (HS256 + payload `type: 'a2a'` 분리, `AUTH.A2A_TOKEN_EXPIRY_S = 60`). a2a-router 가 `Authorization: Bearer <a2a-jwt>` 파싱 → 서명/만료/audience/type 검증 → `payload.sub` 를 caller 로 추출 후 `canAccessAgent({ jwtSub, intent: DELEGATE })`. Op.Delegate remote 경로 (`delegate.js`) 가 Reader env 의 `a2aSigner(currentUserId)` 로 caller 토큰 발급 후 첨부. boot 순서 재배치 — `createAuthSetup` 가 `UserContext.create` 보다 먼저 실행되어 a2aSigner 주입 (KG-17 + UserContextManager lazy 부트 양쪽 일관). scope: self-A2A (같은 머신 = 같은 secret), 멀티 머신은 Phase 2 (peer key registry / mTLS). A2A1~A2A4 (token sign/verify + type 분리) + AI1~AI11 (Bearer 검증 + 위조 서명/access 토큰 misuse 거부). 신규 invariant I13 (A2A 토큰 type 분리 + Bearer 헤더 강제 + tokenService 부재 시 createA2aRouter throw).
- 2026-04-26: KG-22 resolved — `feature/cedar-governance-v2` 후속. `en.json` 에 91 missing 키 영어 번역 일괄 추가 (KO/EN 모두 223 키 동등). `test/regression/i18n-key-parity.test.js` INV-I18N-PARITY 정적 검사 도입 — flat key 집합 동등성을 test 단계에 강제, 새 KO 키 추가 시 EN 미갱신 회귀 즉시 차단. 후속의 옵션 (b) (dev 로그) 보다 정적 검사가 더 강한 방어.
- 2026-04-26: KG-21 resolved — `feature/cedar-governance-v2` 후속. `test/regression/delegate-order-enforcement.test.js` 신규. `delegate.js` 의 `resolveDelegateTarget` 첫 호출 라인이 `canAccessAgent` 첫 호출 라인보다 앞서는지 정적 라인 비교로 검증. KG-21 의 후속 두 옵션 (ResolvedAgentId 마커 / 호출 순서 spy) 은 침습적이라 미적용 — 실사 결과 호출 순서 자체는 이미 정확 (line 18 / line 27), 부족한 회귀 방어만 정적 grep 으로 보강.
- 2026-04-26: KG-20 resolved — `feature/cedar-governance-v2` 후속. `test/regression/agent-id-validation-enforcement.test.js` 신규. KG-18 INV-AGENT-ACCESS 정적 grep 패턴을 미러한 INV-AGENT-ID-VALIDATION 5 사이트 (Session 생성자 / AgentRegistry.register / resolveDelegateTarget / Op.SendA2aMessage / A2A self card) 회귀 방어. 후속 두 옵션 (Session 생성자 검증 / spy 패턴 확장) 중 전자는 이미 시행 중 (`assertValidAgentId(opts.agentId)`) 임을 실사로 확인. agent-identity.md I3/I10 stale ⚠️ 제거 (SD11~13, RDT1~9 으로 이미 커버됨).
- 2026-04-26: KG-16 resolved — `feature/cedar-governance-v2` 후속. `resolvePrimaryAgent(config, fallbackUserId)` 헬퍼 (`packages/core/src/core/agent-id.js`) 추가 + `Config.Schema` 에 `primaryAgentId` 필드 추가 (이전엔 zod strip 으로 admin 의 `admin/manager` 가 런타임에 소실되던 잠재 버그 동시 해결). 4 진입점 (`server/index.js` boot 기본 / `session-api.js` lazy + POST / `scheduler-factory.js` legacy null-owner) 모두 헬퍼 경유로 통일. PA1~PA6 + AE18 테스트.
- 2026-04-26: KG-15 resolved — `feature/cedar-governance-v2` 에서 admin singleton 강제 구현. `SessionManager.findAdminSession()` 추가 (USER 타입 + reserved username prefix 매치) + `canAccessAgent` 의 NEW_SESSION + reserved owner 분기에 `REASON.ADMIN_SINGLETON` 거부 로직 + `session-api.js` POST `/sessions` 진입점에서 callback 주입. concurrent admin approve race 가 새 세션 진입 자체에서 차단됨. takeover 미도입 (option a) — 회복은 명시 DELETE 또는 서버 재시작. 단위 테스트 AS1~AS5 (agent-access) + SM-admin1~4 (session-manager-routing).
- 2026-04-26: KG-24 resolved — `feature/cedar-governance-v2` 의 GC1 커밋 (`cce021b`) 에서 GV-Y1.1~1.8 (8 케이스 호출 정합) + GV-Y2 (호출 횟수 1:1) + GV-Y4 (mock deny → 코드 분기 미도달) 자동화 완료. CI-Y6 (정책/엔진 측 deny 능력) + GV-Y1/Y2/Y4 (호출 정합성) 가 합쳐 옵션 Y' enforcement 완전 검증. KG-24 의 "GV-Y1~Y4 와 합쳐야 완전" 조건 충족.
- 2026-04-26: KG-24 추가 (open) — Cedar 인프라 플랜 (`cedar-infra-y-prime.md`) plan-reviewer round 2 에서 발견. CI-Y6 (deny-path 자동화) 가 정책/엔진 측 deny 능력만 검증하고, 실제 호출처 (`agent-governance.js`) 가 evaluator 를 정확히 호출하는지는 검증하지 못함 — 호출 정합성은 governance-cedar v2.1 phase 의 GV-Y1~Y4 가 담당. (b) 분류로 plan 흡수가 아닌 KG 등록. 인프라 phase 단독 머지 시 enforcement 부재 = 호출처 미사용 = 의미론 우회 위험 0 (cedar-infra.md §7) 으로 안전망 보장.
- 2026-04-25: KG-23 추가 (open) — Cedar 인프라 design (cedar-infra.md v1.1) codex 리뷰에서 발견. Cedar evaluate 호출이 Op ADT 로 wrapping 안 됨 — Op ADT 의 finite 선택 공간 강제 원칙과 충돌. Y' phase 의도된 미수용 (인프라 phase 에선 호출이 서비스 레이어, LLM 경계 밖). LLM 이 직접 권한 조회를 트리거하는 시나리오가 생기면 Op 으로 wrapping 도입.
- 2026-04-25: KG-20 / KG-21 / KG-22 추가 (open) — A2A Phase 1 S4 + FP-67 humanize + KG-18 spy infra 마무리 후 진실의 원천 정합성 검증에서 발견. KG-20 (medium/spec): AgentId branded type 런타임 강제 부재 — validateAgentId 미경유 raw 문자열 주입 회귀 검증 없음. KG-21 (medium/spec): Parser→Resolver→Authz 순서 런타임 검증 부재 — resolver 우회 raw target 이 canAccessAgent 에 직접 들어오는 경로 탐지 불가. KG-22 (low/infra): en.json 91 키 누락으로 locale=en 시 humanize 경로 fallback 한국어 잔재. 동시에 `memory_cmd.help` EN 텍스트의 tier leftover (`/memory list <tier>`, "node count by tier") 정리 — KO 와 정렬.
- 2026-04-25: KG-18 resolved — `agent-access.js` 에 spy infra 도입 (`inspectAccessInvocations` / `resetAccessInvocations`, ring 버퍼 cap 200). 5 진입점 통합 테스트에 동적 spy 검증 추가 — server.test.js S1/S10 (#1, #3), a2a-invoke.test.js AI1 (#2), scheduler-e2e.test.js SE1 (#4), delegate.test.js #1 (#5). spy infra unit AA17~AA19 + regression test 헤더에 동적 검증 위치 매핑. 정적 grep 의 "반환값 무시" 잠재 회귀가 호출 자체와 INTENT/agentId/jwtSub 캡처로 차단됨.
- 2026-04-25: FP-67 resolved — `formatResponseMessage` 헤더 라벨을 i18n `a2a.header.*` 키로 전환 (`completed` / `failed` / `expired` / `fallback`), failed 분기에 `a2a.advice.*` 매핑 합성 (queue-full / server-restart 등 4 코드), 출력에서 `fromAgentId` + "A2A" 내부 용어 제거. error 코드 raw 보존 (interpreter / LLM 영향 없음), 표시 계층만 변환. 테스트 HM1~HM7 + AI5 갱신. `a2a-internal.md` v10.
- 2026-04-25: FP-67 추가 (open) — A2A Phase 1 S4 후속 UX 감사. `events.js:formatResponseMessage` 가 "A2A 응답" 내부 용어 + `{username}/default` 에이전트 ID + 영한 혼합 헤더 + 실패 시 조치 안내 부재 4 개 마찰 포인트. 제안: `[서브 에이전트 응답]` 등 유저 친화적 라벨 + 에러별 조치 안내. 소스: `docs/ux/tui-chat-transcript.md`.
- 2026-04-25: A2A Phase 1 S4 완료 — `feature/a2a-phase1` 4 커밋 (`10e6da5` 큐 상한 트랜잭션 + audit, `27981e6` recoverA2aQueue + 두 부트 hook + single-flight, `a3bbddd` i18n humanize, `ca96e02` 설계 v9). bounded batch (1000) + feature flag (config.a2a.recoverOnStart) 로 OOM/배포 차단 회피. UserContextManager single-flight 로 동시 첫 접근 race window 차단 (기존 잠재 버그 동시 해결). `data-persistence.md` I13 / `session.md` I16 갱신.
- 2026-04-25: A2A 네이밍 범용화 + 스펙 불변식 승격 — `feature/a2a-phase1` 브랜치 4 커밋 (`c1faef7` design v8, `e79141f` TodoMessage → A2aMessage rename + EventActor 정리, `e8eb939` complexity.js class method 이중 카운트 수정, `74ce889` schema v2 a2a_messages + category 컬럼 + migration v1→v2). 도메인 특정 이름(todo)을 프리미티브에 고정하지 않는다는 원칙을 `data-persistence.md` I13 / `session.md` I16 에 불변식으로 명시. 향후 Op/EVENT_TYPE/테이블에 `Op.SendTodo`, `todo_request`, `todo_messages` 같은 category 특정 이름 재도입 차단.
- 2026-04-24: KG-19 resolved — JobStore agent tool 경로 5 메서드 (`listJobs`/`getJob`/`updateJob`/`deleteJob`/`getRunHistory`) 에 `{ ownerAgentId }` 옵션 필터링 활성화. `JobToolFactory` 가 `#ownerAgentId` 고정 전달. 단일 커밋 + 20 신규 테스트 (store 필터 6 + 시스템 경로 보호 4 + tool layer 10 including drift guard). 범위: tool boundary 봉합 (partial resolve) — 관측성 분리, TODO_REVIEW agent-per-instance 정책, 시스템 경로 자동 drift 탐지는 후속 작업. **숨은 전제: M1 단계 유저당 agent 1 개**. M3 복수 agent 허용 시 롤백 보안 regression 가능 — 재검토 필요.
- 2026-04-24: data-scope-alignment 구현 완료 — `feature/agent-scoped-data` 브랜치 3 커밋 (`305a88d` Memory API agentId 전환, `4ade796` 세션 경로 agent 디렉토리 삽입, 후속 커밋 remove-user agentIds 순회 + 스펙 갱신). Memory/Session 을 agent 단위 격리로 전환. TODO/Jobs/Scheduler 는 유저 단위 유지. 기존 데이터 버림 (legacy migration 제거). 관련 스펙 5 개 (`architecture.md` I7, `memory.md` I2/I4/I9 + E4a, `data-persistence.md` I3, `session.md` I5/I10/I13 + E6, `agent-identity.md` 관련 코드 목록) 갱신. 설계 문서: `docs/design/data-scope-alignment.md` v1.
- 2026-04-24: KG-19 추가 — `feature/agent-scoped-data` 브랜치 data-scope 조사에서 발견. JobStore 의 `owner_user_id`/`owner_agent_id` 컬럼이 schema 에만 존재, 조회/수정/삭제 쿼리에서 필터링에 사용 안 됨. 이번 data-scope 리팩토링 범위 분리 — 별도 티켓으로 등록.
- 2026-04-23: FP-66 resolved — MirrorState 가 WS `init` 의 `workingDir` 을 캐시. App 이 StatusBar 에 `workspace={state?.workingDir}` 전달, 세그먼트 라벨은 `ws: {basename}` 으로 교체. `cwd` prop 은 App/RemoteSession 에서 제거. `ko.json` dir 라벨을 "워크스페이스 (에이전트 작업 디렉토리)" 로 갱신. 에이전트가 실제로 파일 작업을 수행하는 디렉토리가 StatusBar 에 정확히 반영됨.
- 2026-04-23: FP-65 resolved — `ko.json`/`en.json` `error.access_denied` 메시지를 워크스페이스 기반으로 재작성. `tools.allowedDirs` 편집 안내 제거. 호출부 `local-tools.js:109` 변수명도 `dirs` → `workspace` 로 정렬.
- 2026-04-23: FP-65/FP-66 추가 (open) — feature/agent-identity-model 브랜치 UX 감사 (W1 workingDir 단일 규칙 반영). FP-65 medium: 파일 경로 차단 에러 메시지(`ko.json error.access_denied`)가 `~/.presence/config.json` 의 `tools.allowedDirs` 편집을 안내하지만 W1 이후 `tools.allowedDirs` 설정 자체가 존재하지 않음 — 유저를 존재하지 않는 조치로 유도. FP-66 low: StatusBar `dir` 세그먼트가 TUI 프로세스 cwd 를 표시하지만 실제 파일 작업 기준점은 `~/.presence/users/{username}/` 워크스페이스 — 두 경로 불일치로 혼란 가능.
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
- 2026-04-12: KG-08 추가 — 멀티턴 시 중간 LLM 응답이 TranscriptOverlay에 미표시. iterationHistory 데이터는 이미 존재하나 UI에 연결 안 됨. docs/specs/transcript.md 신규 작성.
- 2026-04-12: FP-48/FP-49/FP-51 resolved — "i18n 한글화" 묶음. /mcp 피드백 6곳 → mcp_cmd.* i18n 이관. /report 저장 피드백 → report_cmd.* i18n 이관. App.js 'thinking...' → streaming.thinking i18n 이관.
- 2026-04-12: FP-50 resolved — copyToClipboard 헬퍼 추출 (process.platform 기반 darwin/linux/win32). /copy + /report 양쪽에서 사용. 실패 시 copy_cmd.fallback i18n 안내.
- 2026-04-12: KG-08 resolved — TranscriptOverlay 5번째 탭(Iterations) 추가. App.js→iterationHistory prop 전달. transcript/iterations.js 신규. **FP/KG open 0건 달성.**
- 2026-04-12: KG-09/KG-10/KG-11 추가 — 디버그 리포트 분석. KG-09: LLM max_tokens 미설정 truncation (high). KG-10: retry iteration index 중복 (medium). KG-11: report 에러 iteration 불완전 표시 (low).
- 2026-04-12: FP-52/FP-53/FP-54 추가 — KG 3건의 UX 영향. FP-52: truncation 경고 없음 (KG-09 연계). FP-53: retry 중복 번호 혼란 (KG-10 연계). FP-54: "?" 미구분 (KG-11 연계).
- 2026-04-12: KG-09/KG-10/KG-11 resolved — Op DSL Reader 전환 + max_tokens 파이프라인 완성. retryAttempt 필드. 에러 레이블 개선. FP-52/FP-53/FP-54 resolved. **FP/KG open 0건 재달성.**
- 2026-04-14: FP-55/FP-56 추가 — ux-guardian 감사. FP-55: StatusBar retry 표시 영어 하드코딩(medium). FP-56: Iterations 탭/리포트 parsedType 등 영어 필드명 노출(low).
- 2026-04-15: FP-57 추가 + 해소 — TranscriptOverlay Iterations 탭 ↑/↓ 스크롤 시 헤더 스태킹(high). 원인: `tab.data.slice(o, o+viewHeight)` 가 아이템 단위 슬라이스인데 `buildIterationMeta` 가 `\n`-joined 멀티라인 Text 반환 → 1 아이템 = 4~10 터미널 행 → Ink 인라인 렌더가 터미널 rows 초과 출력. 해소: `iterations.js` 를 `buildIterationLines` 로 평탄화 (1 라인 = 1 행 보장, \n 분해), `TranscriptOverlay` Iterations 탭을 `mode: 'lines'` 로 전환. 테스트 20c-20g 갱신 (367 passed).
- 2026-04-16: KG-12 resolved — SERP URL 구조적 차단 (`policies.js` 정규식 6개 + `validate.js` `isSerpUrl`). 프롬프트 완화 + 구조 차단 이중 방어. `agent.test.js` T6b 4 assertion 추가.
- 2026-04-16: FP-59 resolved — PLAN_RULES Rule 10/11 (URL 환각 금지 + web_fetch 검색 엔진 아님) + web_fetch 도구 설명 강화. KG-12 는 프롬프트 완화만으로 구조적 gap open 유지.
- 2026-04-16: FP-52 resolved (재해소) — `safeJsonParse` truncation 휴리스틱 + `TurnError.truncated` 파라미터 + `buildRetryPrompt` truncation 힌트 + `useAgentState` retry cause "응답 절단" 분기. parse 실패 시 200자 이상 미종결 응답을 truncation 으로 탐지, retry 프롬프트에 "use shorter response" 가이드 포함.
- 2026-04-16: FP-60/KG-13 resolved — `validatePlan` 에 I9 불변식 추가 (ASK_LLM 종결 플랜 거부), `PLAN_RULES` Rule 6 `$N` 미구현 규칙 → "ASK_LLM 마지막이면 RESPOND 필수" 교체, ASK_LLM+RESPOND 예제 추가. `$N` 프롬프트 참조 미구현 이력을 E6 으로 기록.
- 2026-04-16: FP-55/FP-56 resolved — TUI i18n 한글화. `useAgentState.js` retry activity 를 `t('status.retry')` 로, `iterations.js` 전체 라벨을 `transcript.iter_*` i18n 키로 이관. `interactive.test.js` 에 `initI18n('ko')` 누락 수정. report-sections.js (개발자 디버그 도구) 는 영어 유지.
- 2026-04-16: FP-60/KG-13 추가 + FP-52/FP-59/KG-12 사례 보강 — 2026-04-15 두 번째 debug report (66.2s, 37 ops) 재검토. FP-60/KG-13: plan 마지막 스텝이 ASK_LLM 인데 RESPOND 누락 → `planner.js:135-146` 가 수렴 루프로 재진입, inner ASK_LLM (26.9s) 출력 폐기 → 다음 iteration 에서 direct_response 1971/1898 chars 연속 절단 (FP-52 병리) → 616 chars 변명 응답. 의도적 수렴 vs planner LLM 실수 구조적 구분 불가. KG-12 확장: google SERP URL + `$1`/`$2` placeholder 환각 — 침투 경로가 tool_args 뿐 아니라 모든 자유 텍스트 필드 (prompt 포함) 에 걸쳐 있음.
- 2026-04-16: FP-52 reopened + FP-59/KG-12 추가 — debug report (2026-04-15) 재검토. FP-52: `interpreter/llm.js` 가 `streamingUi.set({ status: 'truncated' })` 를 호출하지만 TUI 어디에서도 소비하지 않음 (grep 결과 0건). retry 도 JSON parse 실패로만 트리거되지 `truncated` 플래그 검사 없음. 2026-04-12 resolved 는 UX 까지 도달하지 않은 미완. FP-59/KG-12: plan 의 EXEC tool_args.url 이 grounded 되지 않은 환각 URL 2건 (`visitbusan.net/.../gId=10234`, `tripadvisor.com/.../g293851-d470615-...`). CLAUDE.md "Op ADT 바깥 계층 hallucination" 경고의 직접 사례. 수정 방향: host whitelist → grounded reference → pre-execution approval 순.
- 2026-04-21: FP-64 resolved — `POST /api/sessions` 400 응답에 `code` 필드 추가 (WORKING_DIR_OUT_OF_BOUNDS / WORKING_DIR_NOT_RESOLVABLE / SESSION_CREATE_FAILED). TUI `cmdNew` 가 code 기반으로 `sessions_cmd.error.*` 한국어 메시지 표시. 테스트: server.test.js S20c (code assertion), session-commands.test.js SC4b (UI 한국어 메시지 + 영어 원문 미노출).
- 2026-04-21: FP-63 resolved — App.js `disconnectedReason` 에 `WS_CLOSE.WORKING_DIR_INVALID` 분기 추가. 원인 "현재 폴더가 서버의 허용 범위를 벗어났습니다" + 조치 "허용된 폴더로 이동한 뒤 TUI 를 다시 실행하세요" 표시. 기존 4001/4002/4003 하드코드도 `WS_CLOSE.*` 상수로 정리. 단위 테스트 3개 추가 (app.test.js 62-3).
- 2026-04-21: FP-63/FP-64 추가 (open) — Phase 20 workingDir UX 감사 결과. FP-63 high: WS close 4004 (`WORKING_DIR_INVALID`) 수신 시 App.js `disconnectedReason` 분기에 코드가 누락되어 "서버 연결이 끊겼습니다" 기본 문구만 표시 — allowedDirs 위반 원인/조치 안내 부재. FP-64 medium: `/sessions new` workingDir 거부 시 서버 400 에러 메시지 (`Session: workingDir "/x" outside allowedDirs [...]`) 가 영어 그대로 노출.
- 2026-04-21: FP-62 resolved — `@mozilla/readability` + `jsdom` 도입으로 HTML 본문 추출 근본 해결. 이전 regex 기반 tag strip 은 Wikipedia 템플릿 boilerplate 가 앞쪽에 포함되어 10KB truncate 경계에서 실제 article 본문이 잘리던 문제. Readability 알고리즘이 nav/sidebar/ad 자동 제거 후 article 본문만 반환. 판정 실패 시 body.textContent fallback. 도메인 특화 패턴 (may refer to / disambiguation / missing article) 은 사용자 피드백 "위키피디아만을 위한 기능 추가는 안됨" 을 따라 제거. 라이브 qwen3.6-35b 검증 — 기존 재현 쿼리에서 LLM 이 1회 web_fetch 로 답변 완료 (6.9s). FP-44 는 유지 (본문 비는 페이지는 Readability 이후 empty_response 로 잡힘).
- 2026-04-22: KG-15 ~ KG-18 추가 — `feature/agent-identity-model` 브랜치 spec-guardian 검증 결과. KG-15 admin singleton session 미강제 (v2). KG-16 M3 primaryAgentId 미이행 (`{username}/default` hardcode). KG-17 A2A JWT 서명 stub (authz phase P23-5 대기, a2a.enabled=false 기본값으로 프로덕션 노출 제한). KG-18 5진입점 canAccessAgent 테스트 정적 grep 수준 (동적 spy 강화 필요). 신규 스펙 `docs/specs/agent-identity.md` 작성 (I1~I12 불변식 + E1~E17 경계 + KG 섹션).
- 2026-04-21: FP-62 추가 (open) — web_fetch 결과 품질 미점검. 2026-04-20 error report 에서 LLM 이 hallucination URL (`_Finite-state_machine`) 을 web_fetch 로 호출 → Wikipedia 가 비정상 HTML 반환 → LLM 이 결과 보고 "내용 없음, 일반 지식으로 대답" → turn 은 success 처리. FP-44 (SERP URL 사전 차단) 방식은 false-positive 로 검색 질 저하 우려. 해소 방향: 사후 결과 품질 점검 (경고 prefix) 으로 패러다임 전환, 작동 확인 후 FP-44 정규식 제거 검토.
- 2026-04-18: FP-61/KG-14 추가 + 즉시 resolved — 메시지 아키텍처 재설계. 서버 `conversationHistory` 를 TUI 메시지의 단일 진실의 원천으로 승격. `history-writer` pure helpers 도입(makeEntry/appendAndTrim/markLastTurnCancelled) 으로 id/trim/truncate 규칙 단일화. `TurnLifecycle` 재구성 — Free API(recordSuccess/recordFailure/finish) + Imperative API(recordAbortSync/recordFailureSync/appendSystemEntrySync/markLastTurnCancelledSync) 병행. cancel flash(I16 재정의), SYSTEM entry 스키마(INV-SYS-1/2/3), abort 판별(INV-ABT-1), /clear 초기화 범위(INV-CLR-1), 후행 cancel 타겟(INV-CNC-1), pendingInput 수명(INV-PND-1), toolTranscript 계약(INV-TTR-1) 을 `tui-server-contract.md` 에 계약화. 누더기 패치 4회 후 근본 원인 (이중 출처 메시지 관리) 을 구조적으로 해소.
- 2026-04-16: FP-58 추가 + 해소 — 메인 뷰 응답 대기/스트리밍 중 화면 깜빡임(high). 진단: `ink-testing-library frames` + `PRESENCE_TRACE_PATCHES` 실환경 계측으로 원인 단계적 추적. 세 가지 주원인을 순차 해소 — (1) StatusBar spinner `setInterval(100ms)` 가 전체 frame erase+rewrite 유발 → spinner/elapsed 타이머 완전 제거, 정적 `◌` 인디케이터로 대체. (2) streaming chunk 가 60ms 주기로 도착 (16 Hz re-render) → `useAgentState` 에서 `_streaming` path 를 200ms trailing throttle 로 wrap (5 Hz 이하). (3) 완료된 대화 메시지가 매 frame rewrite 에 포함 → `ChatArea` 를 `<Static>` 패턴으로 분리, 완료 메시지는 scrollback 에 append-only 로 이동. 부수: App 루트 `height: '100%'` 제거, `keyHintLine`/`streamingView` placeholder 로 프레임 높이 고정. 진단 도구: `packages/tui/diag/measure-writes.js`, `measure-patches.js`, `PRESENCE_TRACE_PATCHES=1` 환경변수. Trade-off: Ctrl+O tool toggle 은 과거 tool 에 적용 안 됨 (Static append-only 한계). 테스트 377 passed.
