// FP-58: trailing throttle — 고빈도 setState 를 제한하기 위한 helper.
// scheduleOrFlush(value): value 를 저장하고 delayMs 후 onFlush(latest) 호출.
// flushNow(value): 즉시 onFlush 호출 + 타이머 취소.
// dispose(): 타이머 정리.
const createTrailingThrottle = ({ delayMs, onFlush, timerRef, latestRef }) => {
  const flush = () => {
    timerRef.current = null
    onFlush(latestRef.current)
  }
  const scheduleOrFlush = (value) => {
    latestRef.current = value
    if (timerRef.current) return
    timerRef.current = setTimeout(flush, delayMs)
  }
  const flushNow = (value) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    latestRef.current = value
    onFlush(value)
  }
  const dispose = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
  }
  return { scheduleOrFlush, flushNow, dispose }
}

export { createTrailingThrottle }
