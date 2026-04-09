import fp from '@presence/core/lib/fun-fp.js'
import { TURN_SOURCE } from '@presence/core/core/policies.js'
import { ActorWrapper } from './actor-wrapper.js'

const { Task, Reader } = fp

// TurnFailure: 턴 실행 자체가 예외로 끝났음을 나타내는 결과 마커.
// policies.js의 TurnError(message, kind)와 구분: TurnError는 턴 내부의 세분화된 에러(파싱 실패, 검증 실패 등),
// TurnFailure는 Actor 결과 채널로 "턴이 실패했다"는 신호를 전달하는 래퍼.
const TurnFailure = (message) => Object.freeze({ tag: 'TurnFailure', message })
TurnFailure.is = (result) => result != null && result.tag === 'TurnFailure'

class TurnActor extends ActorWrapper {
  static MSG = Object.freeze({ RUN: 'run' })
  static TurnFailure = TurnFailure

  constructor(runTurn) {
    // 에이전트 턴 1회 실행. 성공→결과 반환, 실패→TurnFailure로 래핑.
    super({}, (actorState, msg) => {
      if (msg.type !== TurnActor.MSG.RUN) return [null, actorState]
      return Task.fromPromise(() => runTurn(msg.input, { source: msg.source, allowedTools: msg.allowedTools || [] }))()
        .map(result => [result, actorState])
        .catchError(err => Task.of([TurnFailure(err.message), actorState]))
    })
  }

  run(input, opts = {}) {
    const { source = TURN_SOURCE.USER, allowedTools = [] } = opts
    return this.send({ type: TurnActor.MSG.RUN, input, source, allowedTools })
      .map(result => {
        if (TurnFailure.is(result)) throw new Error(result.message)
        return result
      })
  }
}

const turnActorR = Reader.asks(({ runTurn }) => new TurnActor(runTurn))

export { TurnActor, turnActorR }
