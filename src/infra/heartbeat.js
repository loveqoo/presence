// Heartbeat — 주기적으로 이벤트를 생산하는 타이머.
// EventActor 경유로 이벤트 큐에 넣어 다른 입력 채널과 같은 처리 경로를 탄다.
// setTimeout 기반 self-scheduling으로 중첩 실행 방지.
// Backpressure: EventActor 내부 상태(queue/inFlight)로 heartbeat 중복 방지.

import { withEventMeta } from './events.js'

const createHeartbeat = ({ eventActor, state, intervalMs = 60_000, prompt = '정기 점검: 현황 확인', onError }) => {
  let timer = null
  let stopped = true

  const isHeartbeatPendingOrInFlight = () => {
    if (!eventActor) return false
    const actorState = eventActor.getState()
    if (actorState.queue.some(e => e.type === 'heartbeat')) return true
    if (actorState.inFlight && actorState.inFlight.type === 'heartbeat') return true
    return false
  }

  const tick = () => {
    if (stopped) return
    try {
      if (!isHeartbeatPendingOrInFlight()) {
        const enriched = withEventMeta({ type: 'heartbeat', prompt })
        eventActor.send({ type: 'enqueue', event: enriched }).fork(() => {}, () => {})
      }
    } catch (e) {
      if (onError) onError(e)
    }
    if (!stopped) timer = setTimeout(tick, intervalMs)
  }

  const start = () => {
    if (!stopped) return
    stopped = false
    timer = setTimeout(tick, intervalMs)
  }

  const stop = () => {
    stopped = true
    if (timer) { clearTimeout(timer); timer = null }
  }

  return { start, stop, get running() { return !stopped } }
}

export { createHeartbeat }
