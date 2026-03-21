// Heartbeat — 주기적으로 이벤트를 생산하는 타이머.
// agent.run()을 직접 호출하지 않고, emit()으로 이벤트 큐에 넣어
// 다른 입력 채널과 같은 처리 경로를 탄다.
// setTimeout 기반 self-scheduling으로 중첩 실행 방지.
// Backpressure: 큐에 미처리 heartbeat가 있으면 coalesce (skip).

const createHeartbeat = ({ emit, state, intervalMs = 60_000, prompt = '정기 점검: 현황 확인', onError }) => {
  let timer = null
  let stopped = true

  const isHeartbeatPendingOrInFlight = () => {
    if (!state) return false
    // 큐에 미처리 heartbeat
    const queue = state.get('events.queue') || []
    if (queue.some(e => e.type === 'heartbeat')) return true
    // 현재 처리 중인 이벤트가 heartbeat
    const inFlight = state.get('events.inFlight')
    if (inFlight && inFlight.type === 'heartbeat') return true
    return false
  }

  const tick = () => {
    if (stopped) return
    try {
      if (!isHeartbeatPendingOrInFlight()) {
        emit({ type: 'heartbeat', prompt })
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
