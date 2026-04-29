// KG-28 P5 — Cedar evaluator hot reload 의 callable wrapper.
// closure-bound state 로 매 호출마다 state.current 를 읽어 reload 후에도 자동 새 정책 적용.
// 호출 사이트는 wrapper 의 존재를 모름 — 그대로 함수처럼 호출.
// 살아있는 세션 / 캐시된 UserContext 가 잡고 있는 wrapper 함수가 자동으로 새 정책 사용.
//
// reload 전용 인터페이스 (replace / snapshot) 는 UserContextManager 만 호출.
// wrapper 는 typeof === 'function' 유지 — 5 주입 사이트의 invariant (`evaluator must be a function`) 통과.

// reload 시 state 객체 전체를 재할당 (`state = { ... }`) — 직접 필드 변이 (`state.x = y`) 회피.
// fp-monad.md "직접 변이 금지" 규칙 준수. wrapper 의 closure 가 매 호출 state.current 를 읽으므로
// 객체 재할당 후 다음 호출부터 새 evaluator 자동 적용.
const createEvaluatorRef = (initial, { version = 1 } = {}) => {
  if (typeof initial !== 'function') {
    throw new Error('createEvaluatorRef: initial evaluator must be a function')
  }
  let state = Object.freeze({
    current: initial,
    version,
    reloadedAt: new Date().toISOString(),
  })

  // wrapper 가 evaluator 인터페이스 — 호출 시 항상 state.current 읽음
  const evaluator = (args) => state.current(args)

  // reload 전용 인터페이스 — 호출자가 ref 임을 인지해야만 사용
  evaluator.replace = (newFn, newVersion) => {
    if (typeof newFn !== 'function') {
      throw new Error('evaluator.replace: newFn must be a function')
    }
    if (typeof newVersion !== 'number') {
      throw new Error('evaluator.replace: newVersion must be a number')
    }
    state = Object.freeze({
      current: newFn,
      version: newVersion,
      reloadedAt: new Date().toISOString(),
    })
  }
  evaluator.snapshot = () => ({ version: state.version, reloadedAt: state.reloadedAt })

  return evaluator
}

export { createEvaluatorRef }
