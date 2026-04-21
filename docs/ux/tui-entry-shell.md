감사 일자: 2026-04-10
스코프: 진입/연결/셸
감사자: ux-guardian

---

# TUI 진입/연결/셸 영역 UX 감사

대상 파일: `packages/tui/src/main.js`, `packages/tui/src/remote.js`, `packages/tui/src/http.js`, `packages/tui/src/ui/App.js`
참고 스펙: `docs/specs/tui-server-contract.md`, `docs/specs/server-ws.md`, `docs/specs/auth.md`

## 시나리오 흐름

```
npm run start:cli
  → resolveServerUrl (--server 인수 → PRESENCE_SERVER 환경변수 → 기본값)
  → GET /api/instance (1500ms 타임아웃)
  → loginFlow (사용자명 + 비밀번호, 최대 3회)
    → [선택] changePasswordFlow (mustChangePassword, 최대 3회)
  → runRemote (Promise.all + detectGitBranch → Ink 렌더)
  → App 화면 (StatusBar / ChatArea / InputBar)
```

---

## 마찰 포인트 목록

### FP-16 서버 연결 실패 시 원인 불명확 [심각도: high] — **resolved (2026-04-11)**

**해소 확인**
`http.js:checkServer`의 `catch (_) {}` 를 `err.code`를 보존하도록 변경하고, 반환값에 `reachable: false, reason: { code, message }`를 포함시켰다.

`main.js`가 `reason.code`를 분기하여 코드별 조치 힌트를 출력한다:
- `ECONNREFUSED` → `"서버가 실행 중이 아닙니다"`
- `ETIMEDOUT` → `"응답 시간 초과"`
- `ENOTFOUND` → `"호스트 못 찾음"`
- 그 외 → 기본 힌트

출력 형태:
```
서버에 연결할 수 없습니다: <url>
원인: <code> (<message>)
조치: <hint>
```

테스트: `packages/tui/test/app.test.js` 60번(ECONNREFUSED 경로), 61번(ETIMEDOUT 경로).

**원래 현상**: `checkServer`의 catch가 오류를 삼킨다(`catch (_) {}`). 유저에게는 `"서버에 연결할 수 없습니다"` 고정 메시지만 출력된다. ECONNREFUSED(서버 미실행)인지 ETIMEDOUT(방화벽/원격 서버)인지 알 수 없어 유저가 조치를 취하기 어렵다.

### FP-17 결정된 서버 URL이 화면에 보이지 않음 [심각도: medium] — **resolved (2026-04-11)**

**해소 확인**
`resolveServerUrl`이 `{ url, source }` 객체를 반환하도록 변경되었다. `source`는 `'arg' | 'env' | 'default'` 세 값이며, `SERVER_URL_SOURCE_LABEL` 맵으로 유저 친화적 레이블로 변환된다.

`main`에서 서버 접속 전 즉시 출력:
```
연결 중: http://127.0.0.1:3000 [기본값]
연결 중: https://my.server.com [--server]
연결 중: http://staging.example.com [PRESENCE_SERVER]
```

테스트: `packages/tui/test/app.test.js` 70-75번.

**원래 현상**: `resolveServerUrl`이 URL 문자열만 반환. `--server` 인수, 환경변수, 기본값 중 어느 것이 사용되는지 유저에게 표시되지 않았다. 환경변수가 설정된 환경에서 의도치 않은 서버로 연결되어도 알 방법이 없었다.

### FP-18 비밀번호 마스킹 불완전 [심각도: medium] — **resolved (2026-04-11)**

**해소 확인**
`promptPassword`의 `rl._writeToOutput` 오버라이드가 완전 mute 패턴으로 변경되었다. `*` 치환 대신, prompt 문자열이 포함된 write만 통과하고 그 외 타이핑은 화면에 전혀 반응하지 않는다. ssh/sudo 스타일의 전형적인 CLI 비밀번호 입력 UX.

```javascript
rl._writeToOutput = (s) => { if (s.includes(prompt)) origWrite.call(rl, s) }
```

비밀번호 길이 미노출, 백스페이스 `*` 잔류 없음.

**원래 현상**: `rl._writeToOutput` monkey-patch로 `*` 치환. 백스페이스 시 `*`가 잔류하거나 화면이 깨질 수 있었다. `*` 개수로 비밀번호 길이가 노출되었다.

### FP-19 로그인 실패 시 남은 시도 횟수 미표시 [심각도: medium] — **resolved (2026-04-11)**

**해소 확인**
`remainingLabel(attempt, max)` 헬퍼가 추가되었다. `loginFlow`의 프롬프트에 남은 횟수가 포함된다:

```
비밀번호 (2번 남음): 
비밀번호 (마지막 시도): 
비밀번호: 
```

마지막 재시도 불가 시점(attempt=0, left=2)에는 횟수 표기. 2번째(attempt=1, left=1)에는 "마지막 시도". 3번째(attempt=2, left=0)에는 표기 없이 프롬프트만.

테스트: `packages/tui/test/app.test.js` 76-78번.

**원래 현상**: 3회 실패 시 TUI가 종료되지만 몇 번의 기회가 남았는지 표시되지 않았다. 2번째 시도에 `"다시 시도하세요."` 만 출력.

### FP-20 비밀번호 변경 실패 시 횟수 미표시 [심각도: low] — **resolved (2026-04-11)**

**해소 확인**
FP-19와 동일한 `remainingLabel` 패턴이 `changePasswordFlow`에도 적용되었다:

```
새 비밀번호 (2번 남음): 
새 비밀번호 (마지막 시도): 
새 비밀번호: 
```

**원래 현상**: `changePasswordFlow`에서 3회 실패 후 종료되는데 횟수 표시 없음. FP-19와 동일 패턴의 불일치.

### FP-21 로그인 후 무피드백 대기 구간 [심각도: medium] — **resolved (2026-04-11)**

**해소 확인**
로그인 성공 후 `runRemote` 호출 직전에 `console.log('세션을 초기화하는 중...')` 출력이 추가되었다. tools/agents/config 병렬 로드와 git branch 감지 동안 유저는 진행 중임을 확인할 수 있다.

```javascript
console.log('세션을 초기화하는 중...')
return runRemote(baseUrl, { authState, username })
```

**원래 현상**: `remote.js:196-205`의 `Promise.all([tools, agents, config])` + `detectGitBranch()` 처리 동안 터미널에 아무 출력이 없었다. 네트워크 지연 또는 git 명령 지연 시 TUI가 멈춘 것으로 오인될 수 있었다.

### FP-22 WS 복구 불가 시 침묵 — 입력 무응답 상태 지속 [심각도: high] — **resolved (2026-04-11)**

**해소 확인**
`remote.js:createMirrorState`의 `onUnrecoverable` 콜백이 `RemoteSession.#disconnected = { code, at }`를 설정하고 rerender를 트리거한다.

`App.js`가 `disconnected` prop을 받아 화면 최상단에 빨간 double border 배너를 렌더한다:
```
⚠ 서버 연결이 끊겼습니다 (close {code}). TUI 를 재시작하세요 (Ctrl+C).
```

InputBar는 `disabled: true, isActive: false`로 설정되어 입력이 차단된다. `console.error` 단독 출력은 제거되었다.

테스트: `packages/tui/test/app.test.js` 62번(disconnected 배너 렌더), 63번(InputBar 비활성화).

**원래 현상**: close 코드 4002/4003/4001(refresh 실패) 수신 시 `console.error("WS connection unrecoverable...")` 출력 후 아무 조치 없음. Ink UI는 계속 표시. 유저가 입력해도 서버 응답이 없는 무응답 상태. `console.error`는 Ink 렌더 위에 섞여 보기 어렵다.

### FP-23 WS 재연결 중 상태 미표시 [심각도: medium] — **resolved (2026-04-12)**

**해소 확인**
콜백 대신 상태 publish 경로를 채택했다. `policies.js`에 `STATE_PATH.RECONNECTING = '_reconnecting'`를 추가하고, `MirrorState.setReconnecting(flag)` 메서드가 값 변경 시 `publishChange('_reconnecting', ...)`로 구독자에 통지한다. `handleClose`의 지수 백오프 진입 직전에 `setReconnecting(true)`, `ws.on('open', ...)`에서 `setReconnecting(false)`로 복귀한다 (4001/4002/4003 unrecoverable 경로는 건드리지 않음). `useAgentState.js`가 `_reconnecting` path를 구독해 `reconnecting` state를 유지하며, `App.js`는 StatusBar에 `reconnecting: agentState.reconnecting && !disconnected`를 전달해 disconnected 배너와의 중복을 방지한다. `StatusBar.js`의 `buildIndicator`가 reconnecting=true를 최우선 분기로 처리하여 `⠦ 연결 중...` (yellow) 노출. 기존 `useAgentState`의 path 구독 패턴에 자연스럽게 합류하여 콜백 추가 없이 일관된 상태 흐름을 유지하는 것이 이 경로를 선택한 이유다. 테스트: `mirror-state.test.js` RS10/RS11(서버 terminate → `_reconnecting=true` publish → 재연결 성공 → false 복귀, 4002 unrecoverable은 플래그 유지), `app.test.js` 63b-FP23(reconnecting 시 "연결 중" 표시, idle/working indicator 가려짐, disconnected 배너와 중복 안 됨) 3 assertion.

**원래 현상**: 네트워크 순단 후 지수 백오프 재연결 중(최대 15초 간격) App은 이전 스냅샷을 그대로 표시한다. 재연결 중임을 알 수 없고, 이 구간에 채팅을 시도하면 응답 push를 못 받는다.

**원래 제안**: MirrorState에 `onReconnecting`/`onReconnected` 콜백 추가. App이 StatusBar에 `[연결 중...]` 인디케이터를 표시.

### FP-24 인증 만료 후 재로그인 안내 없음 [심각도: medium] — **resolved (2026-04-11)**

**해소 확인**
`App.js`의 `disconnectedBanner`가 `disconnected.code` 값에 따라 제목 라인을 분기하도록 확장되었다:

- `4001` (AUTH_FAILED, refresh 실패 포함): `"세션이 만료되었습니다"`
- `4002` (PASSWORD_CHANGE_REQUIRED): `"비밀번호 변경이 필요합니다"`
- `4003` (ORIGIN_NOT_ALLOWED): `"접근이 거부되었습니다"`
- 그 외: `"서버 연결이 끊겼습니다"` (기존 문구 유지)

하단 `"TUI 를 재시작하세요 (Ctrl+C)."` 힌트는 모든 코드에서 공통 표시. FP-22의 배너 프레임(double border, 빨간색)이 그대로 사용되며 제목 라인만 코드별로 교체된다.

테스트: `packages/tui/test/app.test.js` 62번(4001 → 세션 만료 확인), 62-2번(그 외 → 서버 연결 끊김 확인).

**원래 현상**: refresh 실패 → `onUnrecoverable` 호출 → FP-22와 동일한 침묵 상태. 유저는 Ctrl+C로 재시작해야 하는데 이를 화면에서 알 수 없었다.

### FP-25 Escape 키 역할 미표시 [심각도: low] — **resolved (2026-04-12)**

**해소 확인**
`App.js`에 idle 전용 키 힌트 라인이 신설되어 전역적으로 해소되었다. transient 메시지가 활성화된 상태에서는 힌트 라인 끝에 `· Esc 임시메시지 닫기`가 접미로 추가된다 (i18n `key_hint.transient`). working 상태에서 Esc로 작업 취소 시 "작업이 취소되었습니다" system 메시지가 ChatArea에 남아 취소 피드백도 제공된다 (i18n `key_hint.cancelled`). 힌트 라인은 App.js 전역에서 관리되며 진입/연결 흐름에도 동일하게 적용된다.

관련 코드: `packages/tui/src/ui/App.js` (힌트 라인 렌더), i18n `key_hint.*` (ko.json).
테스트: `packages/tui/test/app.test.js` 63c(idle 힌트), 63d(working 숨김), 63e(disconnected 숨김).

**원래 현상**: Escape는 작업 중일 때 취소, 평소에는 임시 메시지 삭제로 동작이 달라지는데 화면에 표시 없음.
**원래 제안**: 작업 중일 때만 `[Esc: 취소]` 힌트를 StatusBar 또는 InputBar 근처에 표시.

### FP-26 Ctrl+T / Ctrl+O 키바인딩 미노출 [심각도: low] — **resolved (2026-04-12)**

**해소 확인**
`App.js`에 idle 전용 키 힌트 라인이 신설되어 전역적으로 해소되었다. idle 상태에서 항상 다음 문구가 표시된다:
```
/help 커맨드 · Ctrl+T 전사 · Ctrl+O 도구 상세
```
working / approve / disconnected 상태에서는 중복 방지를 위해 숨김 처리된다.

관련 코드: `packages/tui/src/ui/App.js` (힌트 라인 렌더), i18n `key_hint.idle` (ko.json).
테스트: `packages/tui/test/app.test.js` 63c(idle 힌트), 63d(working 숨김), 63e(disconnected 숨김).

부수 효과: `tool-result-expand` 시나리오 step 3 "펼침 키 안내가 보이는가?" assertion이 7/7 통과 (이전 6/7).

**원래 현상**: 트랜스크립트 오버레이(Ctrl+T), 툴 상세 토글(Ctrl+O)이 화면에 전혀 표시되지 않아 발견 불가.
**원래 제안**: StatusBar 힌트 영역 또는 `/help` 슬래시 커맨드로 노출.

### FP-27 TranscriptOverlay 닫기 시 화면 깜박임 [심각도: low] — **resolved (2026-04-12)**

- **위치**: `App.js:68-70`
- **해소 확인**: `App.js`에서 `setShowTranscript(false)` 직후 실행하던 `process.stdout.write('\x1b[2J\x1b[H')` 수동 클리어가 제거되었다. Ink가 `setShowTranscript(false)` 시 자동 re-render를 담당하므로 이중 처리로 인한 플리커가 해소되었다.
- **원래 현상**: `process.stdout.write('\x1b[2J\x1b[H')` 강제 클리어 + Ink 재렌더로 인한 이중 처리. 짧은 플리커 발생.
- **원래 제안**: 강제 클리어의 필요성 재검토. Ink가 이미 전체 재렌더를 담당한다면 제거.

### FP-28 authRequired=false Dead Code 분기 [심각도: low] — **resolved (2026-04-12)**

- **위치**: `main.js:100-103`, 스펙 `E4 "Known Gap"`
- **해소 확인**: `main.js`에서 `authRequired=false` dead branch가 제거되었다. `loginFlow`가 무조건 호출되도록 단순화되었다(서버 `authEnabled=true` 고정). KG-02도 함께 해소됨.
- **원래 현상**: `authEnabled`가 항상 `true`로 하드코딩되어 있으므로 `authRequired=false` 분기는 운영에서 도달 불가. 스펙에 Dead Code로 명시. 실수로 활성화되면 `username=null`로 세션 ID가 `'user-default'`가 되는 예측 어려운 동작 발생.
- **원래 제안**: 코드 주석으로 "운영 환경 미도달" 명시 또는 제거.

---

## Phase 20 영향 감사 (2026-04-20)

감사 범위: Phase 20 (세션별 workingDir 도입) 이후 TUI 진입/연결/셸 영역 UX 영향.

### 기존 FP 영향 없음

- FP-16 ~ FP-28 전체 resolved 상태 유지 확인. Phase 20은 WS join 메시지 + POST /sessions body에 `cwd` 추가, 서버 측 allowedDirs 검증, init 응답에 `workingDir` 포함 등이 핵심 변경이다. 이 변경들은 기존 해소된 FP의 경로(서버 URL 결정, 인증 흐름, WS 재연결 표시 등)를 건드리지 않는다.

### 신규 마찰 포인트

### FP-63 WS close 4004 시 "서버 연결이 끊겼습니다" 기본 문구 노출 [심각도: high] — **open**

**시나리오**: 사용자가 allowedDirs에 포함되지 않은 디렉토리에서 TUI를 실행한다. WS join 단계에서 서버가 `close(4004, 'cwd outside allowedDirs')`를 전송하고, MirrorState가 이를 영구 실패로 처리해 `onUnrecoverable(4004)`를 호출한다. App.js가 disconnected 배너를 표시한다.

**현재 동작**: `App.js`의 `disconnectedReason` 분기 (`4001/4002/4003/else`)에서 4004는 else로 떨어져 `"서버 연결이 끊겼습니다 (close 4004)."`가 표시된다. 하단에는 `"TUI 를 재시작하세요 (Ctrl+C)."`만 노출된다.

관련 코드: `packages/tui/src/ui/App.js:129-133` (disconnectedReason 분기), `packages/infra/src/infra/states/mirror-state.js:123-128` (4004 영구 실패 처리).

**마찰 포인트**: 사용자는 왜 끊겼는지, 무엇을 고쳐야 하는지 전혀 알 수 없다. "close 4004"는 내부 코드다. 실제 원인(실행 디렉토리가 허용 범위 밖)과 조치(allowedDirs에 디렉토리 추가 또는 허용된 디렉토리에서 TUI 재실행)를 알려줘야 한다.

**제안**: `disconnectedReason` 분기에 4004를 추가해 아래와 같은 경험을 제공해야 한다:
```
⚠ 작업 디렉토리 접근이 거부되었습니다 (close 4004).
현재 디렉토리가 허용된 경로 밖입니다.
~/.presence/config.json 의 tools.allowedDirs 를 확인하거나, 허용된 디렉토리에서 TUI 를 다시 실행하세요.
TUI 를 재시작하세요 (Ctrl+C).
```

**근거**: FP-16(서버 연결 실패)과 동일한 원칙 — 코드가 아닌 원인과 조치를 표시한다. 4004는 영구 실패이며 재연결이 없으므로, 사용자가 이 화면에서 취할 수 있는 행동(조치→Ctrl+C→재실행)을 즉시 안내해야 한다.

### FP-64 `/sessions new` workingDir 거부 시 영어 서버 에러 노출 [심각도: medium] — **open**

**시나리오**: 사용자가 `/sessions new myproject`를 입력한다. TUI는 `POST /api/sessions { id: '...', type: 'user', workingDir: process.cwd() }`를 전송한다. workingDir이 allowedDirs 밖이면 서버가 `400 { error: 'cwd outside allowedDirs' }` 또는 세션 생성 예외 메시지를 반환한다.

**현재 동작**: `sessions.js:23`에서 `catch(e) → addMessage({ role: 'system', content: t('slash_cmd.error', { message: e.message }) })`. 결과: `"오류: cwd outside allowedDirs"` 또는 영어 예외 메시지가 그대로 채팅창에 노출된다.

관련 코드: `packages/tui/src/ui/slash-commands/sessions.js:21-24` (cmdNew), `packages/server/src/server/session-api.js:162-165` (400 에러 반환).

**마찰 포인트**: 오류 메시지가 영어 내부 표현이다. 사용자는 "cwd outside allowedDirs"가 무엇을 의미하는지, 어디를 고쳐야 하는지 알 수 없다. ko.json의 `tools.access_denied` 키에 이미 한글 안내가 있으나 이 경로에서는 사용되지 않는다.

**제안**: `cmdNew` 에러 핸들러에서 서버 응답 에러 메시지를 분기 처리하거나, 서버가 일관된 에러 코드(예: `{ error: '...', code: 'WORKING_DIR_INVALID' }`)를 반환해 TUI가 `tools.access_denied`에 해당하는 한글 안내로 치환해야 한다. 경험:
```
오류: 현재 디렉토리가 허용된 경로 밖입니다.
~/.presence/config.json 의 tools.allowedDirs 를 확인하세요.
```

**근거**: 같은 allowedDirs 위반이지만 FP-63(WS 경로)과 FP-64(REST 경로) 두 곳에서 동일한 마찰이 발생한다. 이미 `tools.access_denied` i18n 키에 한글 안내가 존재하므로 코드 경로를 연결하는 것으로 해소 가능하다.

---

## 심각도별 요약

| 심각도 | open | resolved | 항목 |
|--------|------|----------|------|
| **high** | 1 | 2 | open: FP-63(4004 close 원인 미표시) / resolved: FP-16(서버 연결 실패 원인 불명), FP-22(WS 복구 불가 침묵) |
| **medium** | 1 | 6 | open: FP-64(/sessions new 400 영어 에러) / resolved: FP-17(서버 URL 미표시), FP-18(마스킹 불완전), FP-19(로그인 횟수), FP-21(무피드백 대기), FP-23(재연결 상태 미표시), FP-24(인증 만료 안내) |
| **low** | 0 | 5 | resolved: FP-20(변경 횟수), FP-25(Esc 힌트), FP-26(단축키 미노출), FP-27(깜박임), FP-28(Dead code) |
