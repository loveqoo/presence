# @presence/tui

Ink 기반 TUI 클라이언트.

## 구조

```
src/
├── main.js           ← 서버 접속 + 로그인
└── ui/
    ├── App.js        ← 메인 Ink 앱
    ├── report.js     ← 리포트
    ├── components/   ← ChatArea, InputBar, StatusBar, SidePanel 등
    └── hooks/        ← useAgentState
```

## 접속 흐름

1. 서버 접속
2. 사용자 이름 + 비밀번호 로그인
3. 비밀번호 변경 필요 시 변경 화면
4. 채팅 화면 진입
