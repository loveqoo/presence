/**
 * INV-I18N-PARITY 정적 검사 (KG-22).
 *
 * `packages/infra/src/i18n/{ko,en}.json` 의 키 집합이 동일해야 한다. 누락 시
 * locale=en 사용자가 동적 humanize 경로에서 raw key 그대로 보거나 한국어
 * 잔재를 받게 된다 (i18next fallback 미작동: en namespace 자체가 없으면
 * key 반환).
 *
 * 회귀 시나리오: 새 ko.json 키 추가 시 en.json 미갱신 → 사용자 가시 깨짐.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, summary } from '../lib/assert.js'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

const flatKeys = (obj, prefix = '') => {
  const out = []
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatKeys(v, path))
    else out.push(path)
  }
  return out
}

console.log('INV-I18N-PARITY ko/en key parity (KG-22)')

const ko = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/infra/src/i18n/ko.json'), 'utf8'))
const en = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/infra/src/i18n/en.json'), 'utf8'))

const koKeys = new Set(flatKeys(ko))
const enKeys = new Set(flatKeys(en))

const missingInEn = [...koKeys].filter(k => !enKeys.has(k))
const missingInKo = [...enKeys].filter(k => !koKeys.has(k))

assert(missingInEn.length === 0, `EN 누락 키 0 (got ${missingInEn.length}${missingInEn.length ? ': ' + missingInEn.slice(0, 5).join(', ') + (missingInEn.length > 5 ? ', ...' : '') : ''})`)
assert(missingInKo.length === 0, `KO 누락 키 0 (got ${missingInKo.length}${missingInKo.length ? ': ' + missingInKo.slice(0, 5).join(', ') + (missingInKo.length > 5 ? ', ...' : '') : ''})`)
assert(koKeys.size === enKeys.size, `KO/EN 키 개수 동일 (KO=${koKeys.size}, EN=${enKeys.size})`)

summary()
