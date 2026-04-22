import { writeFileSync, mkdirSync, renameSync, chmodSync } from 'fs'
import { dirname } from 'path'
import { randomBytes } from 'crypto'

// =============================================================================
// 파일 원자성 유틸 — tmp 에 쓰고 rename. 중간 crash 시 orphan tmp 만 남음.
// admin-bootstrap, user-migration, agent-governance 세 모듈에서 공용.
// =============================================================================

const tmpSuffix = () => `.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`

const atomicWriteJson = (filePath, data, opts) => {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}${tmpSuffix()}`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  if (opts?.mode !== undefined) chmodSync(tmp, opts.mode)
  renameSync(tmp, filePath)
}

const atomicWriteText = (filePath, text, opts) => {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}${tmpSuffix()}`
  writeFileSync(tmp, text, 'utf-8')
  if (opts?.mode !== undefined) chmodSync(tmp, opts.mode)
  renameSync(tmp, filePath)
}

export { atomicWriteJson, atomicWriteText }
