// CLI 공통 유틸 — flag 검증 + 인터랙티브 입력 (password / line) + http 헬퍼.
// cli.js / cli-admin.js / cli-policy.js 가 import.

import { createInterface } from 'node:readline'

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
