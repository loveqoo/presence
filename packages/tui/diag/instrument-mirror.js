import fs from 'fs'

// FP-58 진단: MirrorState.bus.publish 를 wrap 해서 모든 수신 patch 를 파일에 기록한다.
// PRESENCE_TRACE_PATCHES=1 환경변수로 활성화한다. remote-session 이 사용한다.
const instrumentMirror = (mirror, logPath = '/tmp/presence-patches.log') => {
  const t0 = Date.now()
  fs.writeFileSync(logPath, `=== FP-58 patch trace ${new Date().toISOString()} ===\n`)
  const realPublish = mirror.bus.publish.bind(mirror.bus)
  mirror.bus.publish = function (event, source) {
    const at = Date.now() - t0
    const path = event.path
    let size = -1
    try { size = JSON.stringify(event.nextValue ?? null).length } catch { /* ignore */ }
    fs.appendFileSync(logPath, `+${at.toString().padStart(6)}ms  ${path.padEnd(40)}  ${size}b\n`)
    return realPublish(event, source)
  }
}

export { instrumentMirror }
