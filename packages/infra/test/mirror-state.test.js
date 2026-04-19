import http from 'node:http'
import { WebSocketServer } from 'ws'
import { createMirrorState } from '@presence/infra/infra/states/mirror-state.js'
import { WS_CLOSE } from '@presence/core/core/policies.js'
import { assert, summary } from '../../../test/lib/assert.js'

const delay = (ms) => new Promise(r => setTimeout(r, ms))

// 최소 WS 서버: 연결 수 추적 + 메시지 응답 + Authorization 헤더 기록 + 지정 코드로 닫기
const createMockWsServer = () => {
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  const connections = []
  const authHeaders = []
  // closeWith: 다음 연결을 지정 코드로 close하도록 예약 (null이면 정상 init)
  let closeWith = null

  wss.on('connection', (ws, req) => {
    connections.push(ws)
    authHeaders.push(req.headers.authorization || null)
    if (closeWith != null) {
      const code = closeWith
      closeWith = null
      setTimeout(() => ws.close(code), 10)
      return
    }
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'join') {
        ws.send(JSON.stringify({ type: 'init', session_id: msg.session_id, state: { turn: 0, turnState: { tag: 'idle' } } }))
      }
    })
  })

  return {
    connections,
    authHeaders,
    scheduleCloseWith: (code) => { closeWith = code },
    start: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise(resolve => {
      for (const ws of wss.clients) ws.terminate()
      server.close(resolve)
    }),
  }
}

async function run() {
  console.log('createMirrorState tests')

  // RS1. init 메시지로 cache 초기화
  {
    const mock = createMockWsServer()
    const port = await mock.start()
    const rs = createMirrorState({ wsUrl: `ws://127.0.0.1:${port}` })

    await delay(100)
    assert(rs.get('turn') === 0, 'RS1: turn from init snapshot')
    assert(rs.get('turnState')?.tag === 'idle', 'RS1: turnState from init snapshot')

    rs.disconnect()
    await mock.close()
  }

  // RS2. state patch 메시지로 특정 경로 업데이트
  {
    const mock = createMockWsServer()
    const port = await mock.start()
    const changes = []
    const rs = createMirrorState({ wsUrl: `ws://127.0.0.1:${port}` })
    rs.hooks.on('turn', (change) => changes.push(change.nextValue))

    await delay(100)

    // 서버에서 patch 전송
    const ws = mock.connections[0]
    ws.send(JSON.stringify({ type: 'state', path: 'turn', value: 5 }))
    await delay(50)

    assert(rs.get('turn') === 5, 'RS2: turn updated via patch')
    assert(changes.includes(5), 'RS2: hook fired on patch')

    rs.disconnect()
    await mock.close()
  }

  // RS3. disconnect() — 재연결 없음
  // (이전 버그: close 핸들러가 stopped 확인 없이 항상 재연결 예약)
  {
    const mock = createMockWsServer()
    const port = await mock.start()
    const rs = createMirrorState({ wsUrl: `ws://127.0.0.1:${port}` })

    await delay(100)
    const connsBefore = mock.connections.length
    assert(connsBefore === 1, 'RS3 setup: 1 connection established')

    rs.disconnect()
    await delay(600)  // 재연결 backoff(500ms) 지나도록 대기

    // disconnect 후 새 연결이 생기지 않아야 함
    assert(mock.connections.length === connsBefore, 'RS3: no reconnect after disconnect()')

    await mock.close()
  }

  // RS4. 서버 끊김 시 자동 재연결
  {
    const mock = createMockWsServer()
    const port = await mock.start()
    const rs = createMirrorState({ wsUrl: `ws://127.0.0.1:${port}` })

    await delay(100)
    assert(mock.connections.length === 1, 'RS4 setup: connected')

    // 서버 측에서 강제 종료
    mock.connections[0].terminate()
    await delay(700)  // 재연결 backoff(500ms) 대기

    // disconnect 호출 안 했으므로 재연결해야 함
    assert(mock.connections.length === 2, 'RS4: reconnected after server-side close')

    rs.disconnect()
    await mock.close()
  }

  // RS5. disconnect() 후 close 이벤트 발생해도 재연결 안 함
  {
    const mock = createMockWsServer()
    const port = await mock.start()
    const rs = createMirrorState({ wsUrl: `ws://127.0.0.1:${port}` })

    await delay(100)
    rs.disconnect()

    // disconnect 직후 서버가 소켓을 terminate해도 재연결 없어야 함
    if (mock.connections.length > 0) mock.connections[mock.connections.length - 1].terminate()
    await delay(700)

    assert(mock.connections.length <= 1, 'RS5: no reconnect when disconnect() precedes server close')

    await mock.close()
  }

  // RS6. set()은 no-op (에러 없음)
  {
    const mock = createMockWsServer()
    const port = await mock.start()
    const rs = createMirrorState({ wsUrl: `ws://127.0.0.1:${port}` })

    await delay(50)
    let threw = false
    try { rs.set('turn', 99) } catch (_) { threw = true }
    assert(!threw, 'RS6: set() does not throw')
    assert(rs.get('turn') === 0, 'RS6: set() does not change cached value')

    rs.disconnect()
    await mock.close()
  }

  // RS7. 4001 AUTH_FAILED — onAuthFailed가 true 반환 시 새 헤더로 재연결
  {
    const mock = createMockWsServer()
    const port = await mock.start()

    let token = 'initial-token'
    let refreshCalls = 0
    const rs = createMirrorState({
      wsUrl: `ws://127.0.0.1:${port}`,
      getHeaders: () => ({ 'Authorization': `Bearer ${token}` }),
      onAuthFailed: async () => {
        refreshCalls += 1
        token = 'refreshed-token'
        return true
      },
    })

    await delay(50)
    assert(mock.connections.length === 1, 'RS7 setup: first connection')
    assert(mock.authHeaders[0] === 'Bearer initial-token', 'RS7 setup: initial header')

    // 서버가 4001로 닫음
    mock.connections[0].close(WS_CLOSE.AUTH_FAILED)
    await delay(200)

    assert(refreshCalls === 1, 'RS7: onAuthFailed called once')
    assert(mock.connections.length === 2, 'RS7: reconnected after refresh')
    assert(mock.authHeaders[1] === 'Bearer refreshed-token', 'RS7: reconnect uses refreshed header')

    rs.disconnect()
    await mock.close()
  }

  // RS8. 4001 AUTH_FAILED — onAuthFailed가 false 반환 시 onUnrecoverable 호출 + 재연결 없음
  {
    const mock = createMockWsServer()
    const port = await mock.start()

    let unrecoverableCode = null
    const rs = createMirrorState({
      wsUrl: `ws://127.0.0.1:${port}`,
      getHeaders: () => ({ 'Authorization': 'Bearer stale' }),
      onAuthFailed: async () => false,
      onUnrecoverable: (code) => { unrecoverableCode = code },
    })

    await delay(50)
    mock.connections[0].close(WS_CLOSE.AUTH_FAILED)
    await delay(700)  // backoff 초과 대기

    assert(unrecoverableCode === WS_CLOSE.AUTH_FAILED, 'RS8: onUnrecoverable called with 4001')
    assert(mock.connections.length === 1, 'RS8: no reconnect after failed refresh')

    rs.disconnect()
    await mock.close()
  }

  // RS9. 4002 PASSWORD_CHANGE_REQUIRED / 4003 ORIGIN_NOT_ALLOWED — 즉시 onUnrecoverable, refresh 시도 없음
  {
    const mock = createMockWsServer()
    const port = await mock.start()

    let unrecoverableCode = null
    let refreshCalled = false
    const rs = createMirrorState({
      wsUrl: `ws://127.0.0.1:${port}`,
      onAuthFailed: async () => { refreshCalled = true; return true },
      onUnrecoverable: (code) => { unrecoverableCode = code },
    })

    await delay(50)
    mock.connections[0].close(WS_CLOSE.PASSWORD_CHANGE_REQUIRED)
    await delay(700)

    assert(unrecoverableCode === WS_CLOSE.PASSWORD_CHANGE_REQUIRED, 'RS9: onUnrecoverable called with 4002')
    assert(!refreshCalled, 'RS9: refresh NOT attempted on 4002 (recovery impossible)')
    assert(mock.connections.length === 1, 'RS9: no reconnect after 4002')

    rs.disconnect()
    await mock.close()
  }

  // RS10 (FP-23): 복구 가능한 close 후 재연결 중 `_reconnecting` 토글.
  //   - 초기: false
  //   - 서버 terminate → handleClose 가 setReconnecting(true) → publish
  //   - 재연결 성공 (open) → setReconnecting(false) → publish
  {
    const mock = createMockWsServer()
    const port = await mock.start()
    const rs = createMirrorState({ wsUrl: `ws://127.0.0.1:${port}` })

    await delay(100)
    assert(rs.get('_reconnecting') === false,
      'RS10: 초기 상태 _reconnecting=false')

    const events = []
    rs.hooks.on('_reconnecting', (change) => {
      events.push(change.nextValue)
    })

    // 서버 측 강제 종료 → handleClose → 지수 백오프 경로
    mock.connections[0].terminate()
    await delay(100)  // backoff 시작되기 전에 toggled true 확인
    assert(rs.get('_reconnecting') === true,
      'RS10: 서버 close 직후 _reconnecting=true')
    assert(events.length >= 1 && events[0] === true,
      'RS10: _reconnecting=true publish 이벤트 수신')

    // 재연결 완료 대기
    await delay(700)
    assert(mock.connections.length === 2,
      'RS10: 지수 백오프 재연결 성공')
    assert(rs.get('_reconnecting') === false,
      'RS10: 재연결 open 후 _reconnecting=false 복귀')
    assert(events[events.length - 1] === false,
      'RS10: 마지막 publish 는 false (복귀)')

    rs.disconnect()
    await mock.close()
  }

  // RS11 (FP-23): 4002 PASSWORD_CHANGE_REQUIRED 는 재연결 경로가 아니므로
  // _reconnecting 을 true 로 설정하지 않는다.
  {
    const mock = createMockWsServer()
    const port = await mock.start()
    const rs = createMirrorState({
      wsUrl: `ws://127.0.0.1:${port}`,
      onUnrecoverable: () => {},
    })

    await delay(50)
    assert(rs.get('_reconnecting') === false, 'RS11 setup: 초기 false')

    mock.connections[0].close(WS_CLOSE.PASSWORD_CHANGE_REQUIRED)
    await delay(200)

    assert(rs.get('_reconnecting') === false,
      'RS11: unrecoverable close 는 reconnecting 플래그 건드리지 않음')

    rs.disconnect()
    await mock.close()
  }

  // --- Phase 5: stateVersion + session_id 필터 + requestRefresh ---

  // SV-MS1. init 메시지의 stateVersion 이 lastStateVersion 에 기록됨
  {
    const server = http.createServer()
    const wss = new WebSocketServer({ server })
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'join') {
          ws.send(JSON.stringify({
            type: 'init', session_id: msg.session_id,
            state: { turn: 0, turnState: { tag: 'idle' } },
            stateVersion: 'v-100',
          }))
        }
      })
    })
    const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))
    const rs = createMirrorState({ wsUrl: `ws://127.0.0.1:${port}` })
    await delay(100)
    assert(rs.lastStateVersion === 'v-100', 'SV-MS1: init 의 stateVersion 기록')
    rs.disconnect()
    await new Promise(r => { for (const ws of wss.clients) ws.terminate(); server.close(r) })
  }

  // SV-MS2. state 메시지의 stateVersion 추적 + stale 패치 skip
  {
    const server = http.createServer()
    const wss = new WebSocketServer({ server })
    const conns = []
    wss.on('connection', (ws) => {
      conns.push(ws)
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'join') {
          ws.send(JSON.stringify({
            type: 'init', session_id: msg.session_id,
            state: { turn: 0 }, stateVersion: 'v-200',
          }))
        }
      })
    })
    const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))
    const rs = createMirrorState({ wsUrl: `ws://127.0.0.1:${port}` })
    await delay(100)

    const ws = conns[0]
    // 최신 stateVersion 전송 — apply
    ws.send(JSON.stringify({ type: 'state', session_id: 'user-default', path: 'turn', value: 1, stateVersion: 'v-300' }))
    await delay(30)
    assert(rs.get('turn') === 1, 'SV-MS2: 최신 stateVersion 은 apply')
    assert(rs.lastStateVersion === 'v-300', 'SV-MS2: lastStateVersion 갱신')

    // stale stateVersion 전송 (v-200 < v-300) — skip
    ws.send(JSON.stringify({ type: 'state', session_id: 'user-default', path: 'turn', value: 999, stateVersion: 'v-200' }))
    await delay(30)
    assert(rs.get('turn') === 1, 'SV-MS2: stale 패치 skip — turn 유지')
    assert(rs.lastStateVersion === 'v-300', 'SV-MS2: lastStateVersion 유지')

    rs.disconnect()
    await new Promise(r => { for (const c of wss.clients) c.terminate(); server.close(r) })
  }

  // SV-MS3. 다른 session_id 메시지는 skip
  {
    const server = http.createServer()
    const wss = new WebSocketServer({ server })
    const conns = []
    wss.on('connection', (ws) => {
      conns.push(ws)
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'join') {
          ws.send(JSON.stringify({
            type: 'init', session_id: msg.session_id,
            state: { turn: 0 }, stateVersion: 'v-1',
          }))
        }
      })
    })
    const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))
    const rs = createMirrorState({ wsUrl: `ws://127.0.0.1:${port}`, sessionId: 'my-session' })
    await delay(100)

    const ws = conns[0]
    ws.send(JSON.stringify({
      type: 'state', session_id: 'other-session', path: 'turn', value: 999, stateVersion: 'v-99',
    }))
    await delay(30)
    assert(rs.get('turn') === 0, 'SV-MS3: 다른 session_id 패치 skip')

    rs.disconnect()
    await new Promise(r => { for (const c of wss.clients) c.terminate(); server.close(r) })
  }

  // SV-MS4. session_id 없는 메시지는 통과 (backward-compat — 기존 테스트 픽스처 지원)
  {
    const mock = createMockWsServer()
    const port = await mock.start()
    const rs = createMirrorState({ wsUrl: `ws://127.0.0.1:${port}` })
    await delay(100)
    const ws = mock.connections[0]
    ws.send(JSON.stringify({ type: 'state', path: 'turn', value: 7 }))   // session_id 없음
    await delay(30)
    assert(rs.get('turn') === 7, 'SV-MS4: session_id 없으면 통과 (legacy)')
    rs.disconnect()
    await mock.close()
  }

  // SV-MS5. requestRefresh() 가 WS join 재전송 → 서버 init 재수신
  {
    const server = http.createServer()
    const wss = new WebSocketServer({ server })
    const joinMsgs = []
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'join') {
          joinMsgs.push(msg)
          ws.send(JSON.stringify({
            type: 'init', session_id: msg.session_id,
            state: { turn: joinMsgs.length - 1 },
            stateVersion: `v-${joinMsgs.length}`,
          }))
        }
      })
    })
    const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))
    const rs = createMirrorState({ wsUrl: `ws://127.0.0.1:${port}` })
    await delay(100)
    assert(joinMsgs.length === 1, 'SV-MS5 setup: 1 join')
    assert(rs.lastStateVersion === 'v-1', 'SV-MS5 setup: 첫 init 버전')

    const sent = rs.requestRefresh()
    await delay(100)
    assert(sent === true, 'SV-MS5: requestRefresh 성공 반환')
    assert(joinMsgs.length === 2, 'SV-MS5: join 재전송 1회 추가')
    assert(rs.lastStateVersion === 'v-2', 'SV-MS5: 재수신한 init 의 새 stateVersion 반영')

    rs.disconnect()
    await new Promise(r => { for (const c of wss.clients) c.terminate(); server.close(r) })
  }

  summary()
}

run()
