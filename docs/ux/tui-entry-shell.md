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

### #1 서버 연결 실패 시 원인 불명확 [심각도: high]
- **위치**: `main.js:94-98`, `http.js:47`
- **현상**: `checkServer`의 catch가 오류를 삼킨다(`catch (_) {}`). 유저에게는 `"서버에 연결할 수 없습니다"` 고정 메시지만 출력된다. ECONNREFUSED(서버 미실행)인지 ETIMEDOUT(방화벽/원격 서버)인지 알 수 없어 유저가 조치를 취하기 어렵다.
- **제안**: `catch`에서 오류 코드(`err.code`)를 보존하고, `checkServer`의 반환값에 `reason`을 포함. `main.js`가 이를 출력. 예: `"연결 실패: 서버가 응답하지 않습니다 (ECONNREFUSED)"` vs `"연결 실패: 응답 시간 초과 (1500ms)"`

### #2 결정된 서버 URL이 화면에 보이지 않음 [심각도: medium]
- **위치**: `main.js:9-16`
- **현상**: `--server` 인수, 환경변수, 기본값 중 어느 것이 사용되는지 유저에게 표시되지 않는다. 환경변수가 설정된 환경에서 의도치 않은 서버로 연결되어도 알 방법이 없다.
- **제안**: `resolveServerUrl()` 직후 `"연결 중: http://127.0.0.1:3000"` 한 줄 출력.

### #3 비밀번호 마스킹 불완전 [심각도: medium]
- **위치**: `main.js:26-39`
- **현상**: `rl._writeToOutput` monkey-patch로 `*` 치환. 백스페이스 시 `*`가 잔류하거나 화면이 깨질 수 있다. `*` 개수로 비밀번호 길이가 노출된다.
- **제안**: readline의 `mute` 패턴(입력 자체를 숨기고 `*` 미출력) 또는 검증된 라이브러리 활용 검토.

### #4 로그인 실패 시 남은 시도 횟수 미표시 [심각도: medium]
- **위치**: `main.js:64-83`
- **현상**: 3회 실패 시 TUI가 종료되지만 몇 번의 기회가 남았는지 표시되지 않는다. 2번째 시도에 `"다시 시도하세요."` 만 출력.
- **제안**: `"로그인 실패 (2번 남음)"`, `"로그인 실패 (마지막 시도)"` 형태로 남은 횟수 표시.

### #5 비밀번호 변경 실패 시 횟수 미표시 [심각도: low]
- **위치**: `main.js:42-61`
- **현상**: #4와 동일 패턴. 3회 실패 후 종료되는데 횟수 표시 없음.
- **제안**: 프롬프트에 `"새 비밀번호 설정 (2번 남음):"` 형태로 포함.

### #6 로그인 후 무피드백 대기 구간 [심각도: medium]
- **위치**: `remote.js:196-205`
- **현상**: 로그인 성공 후 `Promise.all([tools, agents, config])` + `detectGitBranch()` 처리 동안 터미널에 아무 출력이 없다. 네트워크 지연 또는 git 명령 지연 시 TUI가 멈춘 것으로 오인된다.
- **제안**: 로그인 성공 즉시 `"세션을 초기화하는 중..."` 출력.

### #7 WS 복구 불가 시 침묵 — 입력 무응답 상태 지속 [심각도: high]
- **위치**: `remote.js:137-140`
- **현상**: close 코드 4002/4003/4001(refresh 실패) 수신 시 `console.error("WS connection unrecoverable...")` 출력 후 아무 조치 없음. Ink UI는 계속 표시. 유저가 입력해도 서버 응답이 없는 무응답 상태. `console.error`는 Ink 렌더 위에 섞여 보기 어렵다.
- **제안**: `onUnrecoverable` 콜백이 App 컴포넌트에 상태로 전달되어, 화면에 `"서버 연결이 끊겼습니다. 재시작하세요 (Ctrl+C)."` 배너를 표시하고 InputBar를 비활성화.

### #8 WS 재연결 중 상태 미표시 [심각도: medium]
- **위치**: `mirror-state.js:106-107`
- **현상**: 네트워크 순단 후 지수 백오프 재연결 중(최대 15초 간격) App은 이전 스냅샷을 그대로 표시한다. 재연결 중임을 알 수 없고, 이 구간에 채팅을 시도하면 응답 push를 못 받는다.
- **제안**: MirrorState에 `onReconnecting`/`onReconnected` 콜백 추가. App이 StatusBar에 `[연결 중...]` 인디케이터를 표시.

### #9 인증 만료 후 재로그인 안내 없음 [심각도: medium]
- **위치**: `remote.js:135`, 스펙 `tui-server-contract.md I5 "Known Gap"`
- **현상**: refresh 실패 → `onUnrecoverable` 호출 → #7과 동일한 침묵 상태. 유저는 Ctrl+C로 재시작해야 하는데 이를 화면에서 알 수 없다.
- **제안**: #7 제안과 동일 경로. 배너에 `"세션이 만료되었습니다. TUI를 재시작하세요 (Ctrl+C)."` 포함.

### #10 Escape 키 역할 미표시 [심각도: low]
- **위치**: `App.js:47-52`
- **현상**: Escape는 작업 중일 때 취소, 평소에는 임시 메시지 삭제로 동작이 달라지는데 화면에 표시 없음.
- **제안**: 작업 중일 때만 `[Esc: 취소]` 힌트를 StatusBar 또는 InputBar 근처에 표시.

### #11 Ctrl+T / Ctrl+O 키바인딩 미노출 [심각도: low]
- **위치**: `App.js:50-51`
- **현상**: 트랜스크립트 오버레이(Ctrl+T), 툴 상세 토글(Ctrl+O)이 화면에 전혀 표시되지 않아 발견 불가.
- **제안**: StatusBar 힌트 영역 또는 `/help` 슬래시 커맨드로 노출.

### #12 TranscriptOverlay 닫기 시 화면 깜박임 [심각도: low]
- **위치**: `App.js:68-70`
- **현상**: `process.stdout.write('\x1b[2J\x1b[H')` 강제 클리어 + Ink 재렌더로 인한 이중 처리. 짧은 플리커 발생.
- **제안**: 강제 클리어의 필요성 재검토. Ink가 이미 전체 재렌더를 담당한다면 제거.

### #13 authRequired=false Dead Code 분기 [심각도: low]
- **위치**: `main.js:100-103`, 스펙 `E4 "Known Gap"`
- **현상**: `authEnabled`가 항상 `true`로 하드코딩되어 있으므로 `authRequired=false` 분기는 운영에서 도달 불가. 스펙에 Dead Code로 명시. 실수로 활성화되면 `username=null`로 세션 ID가 `'user-default'`가 되는 예측 어려운 동작 발생.
- **제안**: 코드 주석으로 "운영 환경 미도달" 명시 또는 제거.

---

## 심각도별 요약

| 심각도 | 건수 | 항목 |
|--------|------|------|
| **high** | 2 | #1(서버 연결 실패 원인 불명), #7(WS 복구 불가 침묵) |
| **medium** | 6 | #2(서버 URL 미표시), #3(마스킹 불완전), #4(로그인 횟수), #6(무피드백 대기), #8(재연결 상태 미표시), #9(인증 만료 안내) |
| **low** | 5 | #5(변경 횟수), #10(Esc 힌트), #11(단축키 미노출), #12(깜박임), #13(Dead code) |
