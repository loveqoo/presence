# Presence 도메인 스펙 인덱스

이 디렉토리는 presence 프로젝트의 **도메인 스펙 문서**를 관리한다.
구현 코드가 아닌 **무엇이 항상 참이어야 하는가** — 불변식, 경계 조건, 책임 경계를 기술한다.

## 스펙 목록

| 파일 | 도메인 | 핵심 관심사 |
|------|--------|-------------|
| [architecture.md](architecture.md) | 아키텍처 원칙 | FP/Free Monad, 인터프리터 계층, 멀티유저 격리 |
| [auth.md](auth.md) | 인증/인가 | 유저 등록, JWT, mustChangePassword, WS 인증 |
| [session.md](session.md) | 세션 생명주기 | 세션 유형, 소유권, 격리, 생성/종료 순서 |
| [memory.md](memory.md) | 메모리 서브시스템 | mem0 통합, 멀티유저 격리, recall/save |
| [config.md](config.md) | 설정 시스템 | 머지 우선순위, 런타임 확정, 유저 override |
| [mcp-tools.md](mcp-tools.md) | MCP/도구 | 도구 등록, 게이트웨이 패턴, persona 필터 |
| [op-interpreter.md](op-interpreter.md) | Op ADT/인터프리터 | Free Monad 순수성, 부작용 경계, 합성 규칙 |
| [server-ws.md](server-ws.md) | 서버/WebSocket | Express 파이프라인, WS 인증, state broadcast |
| [data-persistence.md](data-persistence.md) | 데이터 영속화 | 파일 경로 규칙, transient 필드, 마이그레이션 |
| [todo-state.md](todo-state.md) | Todo/State 관리 | userDataStore 분리, state projection, 이벤트 흐름 |
| [planner.md](planner.md) | Planner/Executor | Plan-Free 계층 분리, Executor 생명주기 계약, epoch 경합 방어 |
| [tui-server-contract.md](tui-server-contract.md) | TUI-서버 계약 | 부팅 순서, REST 엔드포인트, WS 프로토콜, 세션 전환 |

## 스펙 문서 구조

각 문서는 다음을 포함한다:
- **목적**: 이 도메인에서 무엇을 보장하는지
- **불변식 (I)**: 항상 참이어야 하는 규칙
- **경계 조건 (E)**: 위반 가능성이 높은 상황과 기대 동작
- **테스트 커버리지**: 각 불변식/경계 조건이 검증되는 테스트
- **관련 코드**: 스펙이 적용되는 주요 파일

## 관리 원칙

- 코드 구현 세부사항을 복붙하지 않는다
- "무엇이 참이어야 하는가"를 기술한다
- 진행 중인 리팩토링 영역은 "현재 상태 / 전환 중" 으로 명시한다
- 스펙 위반 발견 시 `file:line`으로 보고한다

## 변경 이력

- 2026-04-10: 초기 작성 — 실제 코드 기반 전 도메인 스펙화
