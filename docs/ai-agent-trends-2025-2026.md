# AI Agent 아키텍처 패턴과 트렌드 (2025-2026)

## 1. Google의 AI Agent 문서들

### Agents 백서 (2024.09)
Julia Wiesinger, Patrick Marlow, Vladimir Vuskovic 공저. 에이전트의 3계층 아키텍처 정의:

- **Model Layer**: LLM 기반 의사결정. ReAct, Chain-of-Thought, Tree-of-Thoughts 등 추론 프레임워크 사용
- **Orchestration Layer**: 에이전트의 인지 프로세스 관장 — 정보 수집, 추론, 다음 행동 결정의 루프
- **Tools Layer**: 외부 시스템과의 상호작용
  - Extensions: 표준화된 API 호출 (에이전트 측 실행)
  - Functions: 클라이언트 측 실행 제어 (개발자가 실행 시점 결정)
  - Data Stores: 구조화/비구조화 데이터 접근

### Agents Companion (2025, 76p)
대규모 에이전트 운영: 평가, 멀티에이전트 협업, RAG → Agentic RAG 진화.

### Introduction to Agents (2025.11, 54p)
Google Cloud AI 팀의 프로덕션급 에이전트 시스템 기술 가이드라인.

### Google ADK (2025.04)
오픈소스, 코드 퍼스트 프레임워크:
- 이벤트 드리븐 런타임 (Runner → Event Processor → Event Loop)
- 계층적 에이전트 트리 (루트 에이전트가 하위 에이전트에 위임)
- 모델/배포 불가지론적 설계
- ADK 2.0 Alpha: 그래프 기반 워크플로우 오케스트레이션 추가

## 2. 핵심 디자인 패턴

### Andrew Ng의 4대 패턴 (2024.03)

| 패턴 | 설명 |
|------|------|
| **Reflection** | 자신의 출력을 비판하고 반복 개선. AI를 자기 수정 시스템으로 전환 |
| **Tool Use** | 외부 API, DB, 코드 실행기, 검색엔진 호출 |
| **Planning** | 복잡한 태스크를 구조화된 하위 태스크 로드맵으로 분해 |
| **Multi-Agent** | 각기 다른 역할의 전문 에이전트가 협업 |

### 확장 패턴 (2025-2026)

| 패턴 | 설명 |
|------|------|
| **ReAct** | Thought → Action → Observation 반복. 과도한 계획과 무분별한 실행 모두 방지. 단일 에이전트의 지배적 패턴 |
| **Plan-and-Execute** | 계획과 실행 분리 — 계획 에이전트가 전체 플랜 수립, 실행 에이전트가 각 단계 수행. 장기 태스크에 적합 |
| **Human-in-the-Loop** | 엔터프라이즈 배포의 38%가 이 방식 채택. 핵심 결정 시점에 사람 승인 요청 |
| **Agentic RAG** | 기본 RAG의 진화. 에이전트가 언제, 무엇을, 어떻게 검색할지 스스로 결정. 쿼리 재구성, 멀티스텝 검색 |

## 3. 주요 프레임워크 비교

| 프레임워크 | 핵심 접근 | 특징 |
|-----------|----------|------|
| **LangGraph** (LangChain) | 그래프 기반 | 노드 = 에이전트 스텝, 엣지 = 조건부 전이. 상태 관리에 강점. 학습 곡선 높음 |
| **CrewAI** | 역할 기반 | Crews (동적 역할 협업) + Flows (결정론적 태스크 오케스트레이션). 순차적 프로세스에 적합 |
| **AutoGen** (Microsoft) | 대화형 협업 | Core (이벤트 메시징) + AgentChat (대화 인터페이스). 빠른 배포 |
| **OpenAI Agents SDK** | 핸드오프 기반 | Agents + Handoffs + Guardrails + Tracing. Swarm의 프로덕션 버전. 상태 없는 설계 |
| **Google ADK** | 이벤트 드리븐 | 계층적 에이전트 트리. 모델 불가지론적 |

## 4. Prompt-Response에서 Agentic으로의 진화

```
Phase 1 (2022-2023): Prompt-Response
  단순 요청-응답. 상태 없음, 도구 없음, 자율성 없음

Phase 2 (2023-2024): Augmented LLMs
  RAG, Function Calling, CoT. 기능 확장되었으나 여전히 반응적

Phase 3 (2024): Single Agent
  추론 루프(ReAct), 도구 사용, 기본 메모리. 다단계 문제 해결 가능

Phase 4 (2025-2026): Multi-Agent Systems
  전문화된 에이전트 팀이 범용 단일 에이전트를 대체. Forrester/Gartner 공통 지목

Phase 5 (emerging): Autonomous Agent Networks
  MCP, A2A 등 표준 프로토콜로 조직 경계를 넘는 에이전트 간 통신
```

- Gartner 예측: 2026년 말까지 엔터프라이즈 앱의 40%가 AI 에이전트 내장 (2025년 <5%)
- 시장 규모: $7.8B → $52B+ (2030)
- **Large Action Models (LAMs)**: LLM의 후속. 소프트웨어 인터페이스와 직접 상호작용

## 5. 메모리 패턴

2025.12 칭화대 서베이 기반, 인간 인지 구조를 모방한 분류:

### 단기 / 작업 메모리
- 컨텍스트 윈도우. 단일 대화 내 일관성 유지
- 활성 추론을 위한 즉시 작업 메모리
- 컨텍스트 윈도우 크기에 제한

### 장기 메모리 (3종)

| 유형 | 설명 | 예시 |
|------|------|------|
| **Episodic** | 특정 과거 경험 기록 | "지난 화요일 X 접근법이 Y 클라이언트에서 Z 이유로 실패" |
| **Semantic** | 일반화된 지식과 사실 저장 | "조건 A,B일 때 접근법 X가 일반적으로 최적" |
| **Procedural** | 방법론 인코딩 — 다단계 워크플로우, 학습된 도구 사용 전략 | 종종 간과되지만 복잡한 태스크 실행에 필수 |

### 메모리 관리 연산
생성 → 저장 → 검색 → 통합 → 갱신 → 삭제(망각)

> 복수 메모리 유형을 가진 에이전트는 다중 세션 벤치마크에서 측정 가능한 태스크 완료율 향상을 보임.

## 6. 오케스트레이션 패턴

| 패턴 | 설명 | 적합한 상황 |
|------|------|------------|
| **Single Agent** | 하나의 에이전트 + 추론 루프 + 도구 + 메모리 | 집중된 단일 태스크 |
| **Supervisor / Hierarchical** | 중앙 오케스트레이터가 분해 → 위임 → 감독 → 종합 | 엔터프라이즈 자동화 |
| **Peer-to-Peer / Swarm** | 중앙 없이 에이전트 간 직접 통신. OpenAI Swarm의 핸드오프 모델 | 동적 역할 전환 |
| **Sequential Pipeline** | 고정된 선형 순서로 에이전트 실행, 출력을 다음에 전달 | 단순하고 예측 가능한 플로우 |
| **Parallel Fan-out/Fan-in** | 독립 하위 태스크를 병렬 처리 후 결과 집계 | 독립적 하위 태스크 |
| **Consensus / Debate** | 복수 에이전트가 솔루션 생성 + 집단 평가 | 높은 신뢰성 요구 결정 |

> 프로덕션 시스템은 대부분 하이브리드: 전체 계층적 구조 + 실시간 이벤트 드리븐 + 핵심 결정에 합의 패턴.
> 오케스트레이션 패턴에 따라 토큰 사용량이 200% 이상 차이남.

## 7. 상호운용성 프로토콜 (MCP, A2A)

3계층 프로토콜 스택이 업계 표준으로 수렴 중:

| 프로토콜 | 주체 | 시기 | 역할 |
|---------|------|------|------|
| **MCP** (Model Context Protocol) | Anthropic | 2024.11 | 에이전트 ↔ 도구 연결. "AI의 USB-C". JSON-RPC 2.0 기반 |
| **A2A** (Agent-to-Agent) | Google | 2025.04 | 에이전트 ↔ 에이전트 통신. MCP와 상호보완 |
| **AAIF** (Agentic AI Foundation) | Linux Foundation | 2025.12 | Anthropic, OpenAI, Google, Microsoft, AWS 참여. MCP + A2A 표준 통합 관리 |

- OpenAI가 2025.03 MCP 채택
- IBM의 ACP가 2025.08 A2A에 합류
- 2026.02 기준 100+ 기업 참여

## 8. Presence 프로젝트와의 연결

Free Monad 패턴은 최신 에이전트 아키텍처 개념과 자연스럽게 대응:

| Presence | 업계 용어 | 대응 |
|----------|----------|------|
| **AgentOp ADT** | Tools Layer | 각 연산(LLM 호출, 메모리, 도구)이 대수적 데이터 타입 |
| **Free Monad 프로그램** | Orchestration Layer | 순수 데이터 구조로 워크플로우 선언 (실행 없이) |
| **Interpreter** | Model Layer + 효과 실행 | 같은 프로그램에 다른 인터프리터 (mock, prod, logging) |
| **인터프리터 교체** | 테스트 가능성 | 모든 현대 에이전트 프레임워크가 강조하는 핵심 요구사항 |

> 기술(description)과 실행(execution)의 분리 — LangGraph의 그래프 노드, CrewAI의 Flows, Google ADK의 이벤트 아키텍처 모두 이 패턴으로 수렴 중.

## 참고 자료

- [Google Agents Whitepaper](https://www.kaggle.com/whitepaper-agents)
- [Andrew Ng's Agentic Design Patterns](https://x.com/AndrewYNg/status/1773393357022298617)
- [From Prompt-Response to Goal-Directed Systems (arxiv)](https://arxiv.org/html/2602.10479)
- [Memory in the Age of AI Agents (arxiv, Tsinghua)](https://arxiv.org/abs/2512.13564)
- [Google ADK Documentation](https://google.github.io/adk-docs/)
- [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
- [Agentic AI Foundation](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation)
- [Agentic AI Design Patterns 2026 Guide](https://www.sitepoint.com/the-definitive-guide-to-agentic-design-patterns-in-2026/)
