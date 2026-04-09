# @presence/tui

Ink 기반 TUI 클라이언트.

## 구조

```
src/
├── main.js           ← 서버 접속 + 로그인 + bootstrap
├── remote.js         ← RemoteSession 클래스 (WS/REST 기반 세션 관리)
├── http.js           ← HTTP 요청 헬퍼
└── ui/
    ├── App.js        ← 메인 Ink 앱 (렌더 트리 조립만)
    ├── report.js     ← 디버그 리포트 빌더
    ├── slash-commands.js  ← 슬래시 커맨드 디스패치 테이블
    ├── components/   ← ChatArea, InputBar, StatusBar, SidePanel, ApprovePrompt 등
    │   └── transcript/  ← op-chain, op-chain-format (Op 타임라인 렌더링)
    ├── hooks/
    │   ├── useAgentState.js     ← State → React 바인딩 (17개 상태 구독)
    │   ├── useAgentMessages.js  ← agent state → messages 동기화 (4개 useEffect 통합)
    │   └── useSlashCommands.js  ← 슬래시 커맨드 디스패치 + 일반 입력 처리
    └── slash-commands/  ← sessions, memory, statusline 서브커맨드
```

## 접속 흐름

1. 서버 접속 (`resolveServerUrl`)
2. 사용자 이름 + 비밀번호 로그인 (`loginFlow`)
3. 비밀번호 변경 필요 시 변경 화면 (`changePasswordFlow`)
4. `RemoteSession` 생성 → App 렌더링

## RemoteSession

서버 세션 상태 + WS/REST 통신 + App props 조립을 응집한 클래스.

- `#currentSessionId`, `#remoteState`, `#currentTools` — 세션 mutable state
- `switchSession(id)` — MirrorState 재연결 + App 재마운트
- `#buildAppProps()` — 현재 세션 기반 App props 조립
- `render()` — ink render + rerender 콜백 보관

## App.js 설계

App은 렌더 트리 조립에만 집중. 로직은 custom hook으로 분리.

- `useAgentState` — State → React 상태 바인딩
- `useAgentMessages` — conversationHistory, budgetWarning, toolResults, 턴 초기화 동기화
- `useSlashCommands` — 슬래시 커맨드 + 일반 입력 핸들링
