# Presence Debug Report
**Generated:** 2026-04-20T15:33:31.281Z

## Turn
- **Input:** `fsm에 대한 정의를 위키에서 찾아주시겠어요?`
- **Result:** plan
- **Iteration:** 0
- **Error:** none
- **Timestamp:** 2026-04-20 15:32:57

## Timeline (16 ops, 9.0s)
```
  # Op                                    Duration Status
─── ─────────────────────────────────── ────────── ────────────────────
  1 GetState(context.memories)                 1ms done
  2 GetState(context.conversationHis...      < 1ms done
  3 AskLLM(2 msgs)                            3.5s done
  4 UpdateState(_debug.lastTurn)             < 1ms done
  5 UpdateState(_debug.lastPrompt)           < 1ms done
  6 UpdateState(_debug.lastResponse)         < 1ms done
  7 GetState(_debug.iterationHistory)        < 1ms done
  8 UpdateState(_debug.iterationHist...        1ms done
  9 ExecuteTool(web_fetch)                    1.8s done
 10 AskLLM(1 msgs)                            3.7s done (slowest)
 11 Respond(제공된 위키백과 HTML 콘텐츠에는 FSM(...      < 1ms done
 12 UpdateState(_streaming)                  < 1ms done
 13 GetState(context.conversationHis...      < 1ms done
 14 UpdateState(context.conversation...      < 1ms done
 15 UpdateState(lastTurn)                    < 1ms done
 16 UpdateState(_pendingInput)               < 1ms done
```

## Iterations (1)

### Iteration 1
- **Parsed type:** plan
- **Step count:** 3
- **Assembly used:** 2509 tokens
- **Prompt:** 2 messages, 8229 chars
- **Response (333 chars):**
```json
{"type": "plan", "steps": [{"op": "EXEC", "args": {"tool": "web_fetch", "tool_args": {"url": "https://en.wikipedia.org/wiki/_Finite-state_machine"}}}, {"op": "ASK_LLM", "args": {"prompt": "사용자가 제공한 위키백과 FSM(Finite State Machine, 유한 상태 기계) 문서 내용을 바탕으로 FSM의 정의를 한국어로 간결하게 설명해주세요.", "ctx": [1]}}, {"op": "RESPOND", "args": {"ref": 2}}]}
```

## Assembly
- **Budget:** 7000 tokens
- **Used:** 2509 tokens (36%)
- **History:** 0 used, 0 dropped
- **Memories:** 10 recalled

## Prompt (2 messages, 8229 chars)
```
[0] system (8204 chars): You are a planner for a task-delegation agent.
[1] user (25 chars): fsm에 대한 정의를 위키에서 찾아주시겠어요?
```

## LLM Response (333 chars)
```json
{"type": "plan", "steps": [{"op": "EXEC", "args": {"tool": "web_fetch", "tool_args": {"url": "https://en.wikipedia.org/wiki/_Finite-state_machine"}}}, {"op": "ASK_LLM", "args": {"prompt": "사용자가 제공한 위키백과 FSM(Finite State Machine, 유한 상태 기계) 문서 내용을 바탕으로 FSM의 정의를 한국어로 간결하게 설명해주세요.", "ctx": [1]}}, {"op": "RESPOND", "args": {"ref": 2}}]}
```

## Recalled Memories (10)
1. FSM에 대해 이야기한다
2. 사용자는 Mem0를 잘 모릅니다.
3. 광안리, 서면, 대연동, 광복로를 중심으로 커피 여행 경로를 원함
4. 고민 중입니다. 부산 투어 (Hesitating about a Busan tour)
5. User is asking about Gwangalli
6. User is looking for 3 Busan tour candidates
7. User lives in Incheon
8. User is looking for a cafe in Gwangalli with modern interior and ocean view
9. Considering a coffee tour during the Busan trip
10. Finds Haemul-pajeon (seafood pancake) delicious

## State
- **Turn:** 303
- **Status:** idle
- **Last Result:** success
- **Memories:** 10 recalled
- **History:** 1 entries

## Config
- **Model:** qwen3.6-35b
- **Base URL:** http://127.0.0.1:8045/v1
- **Response Format:** json_object
- **Max Retries:** 2
- **Max Iterations:** 10
- **Embedder:** active

## System
- **Node:** v24.13.0
- **Platform:** darwin arm64
- **Generated:** 2026-04-20T15:33:31.281Z

## TUI에서 응답
```
  제공된 위키백과 HTML 콘텐츠에는 FSM(Finite State Machine)의 텍스트 정의가 명시적으로 포함되어 있지 않습니다(주로
  페이지의 구조와 메타데이터만 포함됨).

  따라서 일반적인 위키백과 및 컴퓨터 과학의 정의를 바탕으로 FSM의 정의를 간결하게 설명해 드리겠습니다.

  FSM(Finite State Machine, 유한 상태 기계)의 정의:
  FSM은 제한된 개수의 상태(State)를 가지며, 특정 조건(이벤트 또는 입력)이 발생하면 한 상태에서 다른 상태로
  전환(Transition)하는 계산 모델 또는 컴퓨터 프로그램입니다.
```