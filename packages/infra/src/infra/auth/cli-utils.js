// CLI 공통 유틸 — flag 검증 + 인터랙티브 입력 (password / line) + http 헬퍼.
// cli.js / cli-admin.js / cli-policy.js 가 import.

import { createInterface } from 'node:readline'
import {
  API_PREFIX, AUTH_API_PATHS, ADMIN_API_PATHS,
} from '@presence/core/core/policies.js'

// admin/policy CLI 가 서버에 도달할 base URL — env override 가능. 기본은 dev 단일 호스트.
export const resolveBaseUrl = () => process.env.PRESENCE_SERVER_URL || 'http://localhost:3000'

// client 측 full paths — API_PREFIX + 라우터 path 로 derive (단일 진실 소스: policies.js).
export const AUTH_PATHS = Object.freeze({
  LOGIN:   API_PREFIX + AUTH_API_PATHS.LOGIN,
  LOGOUT:  API_PREFIX + AUTH_API_PATHS.LOGOUT,
  REFRESH: API_PREFIX + AUTH_API_PATHS.REFRESH,
})

export const ADMIN_PATHS = Object.freeze({
  POLICY_RELOAD:  API_PREFIX + ADMIN_API_PATHS.POLICY_RELOAD,
  POLICY_VERSION: API_PREFIX + ADMIN_API_PATHS.POLICY_VERSION,
})

export const requireFlag = (flags, name) => {
  if (!flags[name]) {
    console.error(`--${name} is required`)
    process.exit(1)
  }
  return flags[name]
}

export const promptPassword = (prompt = 'Password: ') => new Promise((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const origWrite = rl._writeToOutput
  rl._writeToOutput = (s) => {
    if (s.includes(prompt)) origWrite.call(rl, s)
    else origWrite.call(rl, '*')
  }
  rl.question(prompt, (answer) => {
    rl._writeToOutput = origWrite
    rl.close()
    console.log()
    resolve(answer)
  })
})

export const promptLine = (prompt) => new Promise((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()) })
})

// fetch 실패 분류 — caller 가 도메인 에러로 변환하는 단일 진입점.
// kind: 'unreachable' (네트워크 도달 실패) | 'parse' (JSON 파싱 실패).
export class HttpFetchError extends Error {
  constructor({ kind, status, message }) {
    super(message)
    this.name = 'HttpFetchError'
    this.kind = kind
    this.status = status
  }
}

// fetch + JSON parse 를 한 단계로 묶음. 정상 응답 → { status, ok, body } 반환.
// 네트워크 도달 실패 / JSON 파싱 실패는 HttpFetchError 로 통일.
export const httpJson = async (url, opts = {}) => {
  let response
  try {
    response = await fetch(url, opts)
  } catch (err) {
    throw new HttpFetchError({ kind: 'unreachable', message: err.message })
  }
  let body
  try {
    body = await response.json()
  } catch (err) {
    throw new HttpFetchError({ kind: 'parse', status: response.status, message: err.message })
  }
  return { status: response.status, ok: response.ok, body }
}

// HttpFetchError → 도메인 CliError 로 매핑. caller 가 prefix ('policy', 'admin login') 와 자기 에러 클래스 전달.
export const mapHttpFetchError = (err, CliErrorClass, prefix) => {
  if (!(err instanceof HttpFetchError)) return err
  if (err.kind === 'unreachable') {
    return new CliErrorClass([
      `${prefix}: 서버 도달 실패 — ${err.message}`,
      '  서버 가동 상태 확인 후 재시도 — npm start',
    ].join('\n'))
  }
  if (err.kind === 'parse') {
    return new CliErrorClass(`${prefix}: 응답 파싱 실패 (HTTP ${err.status}).`)
  }
  return err
}

// 모든 CLI 핸들러가 throw 하는 도메인 에러의 베이스. 서브타입 (CliPolicyError /
// CliAdminError / CliAgentError) 은 자기 모듈에서 정의 — 베이스는 dispatch wrapper 가
// 'CliError 인지' 만 일관 검사.
export class CliError extends Error {
  constructor(stderrMessage, name = 'CliError') {
    super(stderrMessage)
    this.name = name
  }

  // stderr + process.exit(1). dispatch wrapper 가 단일 진입점에서 호출.
  display() {
    console.error(this.message)
    process.exit(1)
  }
}

// dispatch* 의 try/catch 통일 — CliError 면 자기 display() 호출, 그 외는 위로 throw.
// 각 dispatch 가 동일한 boilerplate 를 반복하지 않게.
export const dispatchWithCliErrorHandling = async (fn) => {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof CliError) err.display()
    else throw err
  }
}
