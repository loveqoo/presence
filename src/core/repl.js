import { Free, respond, updateState, getState } from './op.js'

// REPL을 Free 프로그램으로 표현
// Read → Exec → Write 루프. 각 Op는 인터프리터가 처리.
// REPL 자체의 Op (Read/Write/Exec)는 별도 정의하지 않고,
// 콜백 기반으로 구현하여 ink UI나 readline 등과 쉽게 연결.

const createRepl = ({ agent, onOutput, onError }) => {
  let running = true
  let turnCount = 0

  const handleInput = async (input) => {
    if (input === '/quit' || input === '/exit') {
      running = false
      return null
    }

    if (input === '/status') {
      const program = getState(null) // 전체 state
      // status는 agent.program을 거치지 않고 직접 반환
      return { type: 'status' }
    }

    turnCount++

    try {
      const result = await agent.run(input)
      if (onOutput) onOutput(result)
      return result
    } catch (err) {
      if (onError) onError(err)
      return null
    }
  }

  return {
    handleInput,
    get running() { return running },
    get turnCount() { return turnCount },
    stop: () => { running = false },
  }
}

export { createRepl }
