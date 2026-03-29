# React 내 Actor 사용 규칙

## Actor는 외부 객체다

Actor는 React 상태가 아니다. React 패턴에 끌려가지 말 것.

```javascript
// ✅ useRef lazy init — 1회 생성, 렌더링과 무관
const actorRef = useRef(null)
if (!actorRef.current) actorRef.current = Actor({ init, handle })
const actor = actorRef.current

// ❌ useState — Actor는 변하지 않고 re-render 유발 이유 없음
const [actor] = useState(() => Actor({ init, handle }))

// ❌ useEffect 안에서 생성 — effect는 부수 효과용이지 객체 생성용이 아님
useEffect(() => { actorRef.current = Actor({ init, handle }) }, [])
```

## subscribe는 mount 시 1회

```javascript
// ✅ useEffect로 1회 연결, cleanup에서 해제
useEffect(() => actor.subscribe((_result, s) => {
  setMessages(derive(s))
}), [actor])
```

## 상태 변경은 메시지로

```javascript
// ✅ 세션 변경 → 메시지
useEffect(() => {
  actor.send({ type: 'sessionReset' }).fork(() => {}, () => {})
}, [sessionId])

// ❌ Actor 재생성
useEffect(() => {
  actorRef.current = Actor({ init, handle })  // 금지
}, [sessionId])
```

## Actor + Reducer 결합

- Reducer는 순수 함수: `state + message → nextState`
- Actor가 주체: 상태 소유, 메시지 큐, 직렬 처리, 구독
- `useReducer`를 Actor처럼 쓰지 말 것 — `Actor.handle`이 reducer 역할 수행

## 판단 기준

- "이게 React 상태인가, 외부 객체인가?" 먼저 판단
- Actor, WebSocket, 타이머 → `useRef` (React 렌더링과 무관)
- 렌더링에 반영할 값 → `useState` (Actor의 subscribe에서 setState)
