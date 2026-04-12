import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatStatusR } from '../../src/core/format-status.js'

describe('formatStatusR', () => {
  const baseData = { status: 'idle', turn: 3, memoryCount: 12, lastTurnTag: undefined }

  // translate 없이 (서버 경로) — 영문 기본값
  it('translate 없으면 영문 기본값 반환', () => {
    const format = formatStatusR.run({ translate: null })
    const result = format(baseData)
    assert.equal(result, 'status: idle | turn: 3 | mem: 12 | last: none')
  })

  it('lastTurnTag=success 반영', () => {
    const format = formatStatusR.run({ translate: null })
    const result = format({ ...baseData, lastTurnTag: 'success' })
    assert.equal(result, 'status: idle | turn: 3 | mem: 12 | last: success')
  })

  it('lastTurnTag=failure 반영', () => {
    const format = formatStatusR.run({ translate: null })
    const result = format({ ...baseData, lastTurnTag: 'failure' })
    assert.equal(result, 'status: idle | turn: 3 | mem: 12 | last: failure')
  })

  // translate 있을 때 (TUI 경로)
  it('translate 있으면 i18n 키로 변환', () => {
    const translations = {
      'status_cmd.label': '상태: {{status}} | 턴: {{turn}} | 메모리: {{mem}} | 마지막 결과: {{last}}',
      'status_cmd.status_idle': '대기',
      'status_cmd.last_none': '없음',
    }
    const mockTranslate = (key, vars) => {
      const template = translations[key]
      if (!template) return translations[key] || key
      return template.replace(/\{\{(\w+)\}\}/g, (_, name) => vars[name] ?? '')
    }
    const format = formatStatusR.run({ translate: mockTranslate })
    const result = format(baseData)
    assert.equal(result, '상태: 대기 | 턴: 3 | 메모리: 12 | 마지막 결과: 없음')
  })

  it('translate 경로에서 status_working 반영', () => {
    const translations = {
      'status_cmd.label': '{{status}} | {{turn}} | {{mem}} | {{last}}',
      'status_cmd.status_working': '작업 중',
      'status_cmd.last_success': '성공',
    }
    const mockTranslate = (key, vars) => {
      const template = translations[key]
      if (!template) return translations[key] || key
      return template.replace(/\{\{(\w+)\}\}/g, (_, name) => vars[name] ?? '')
    }
    const format = formatStatusR.run({ translate: mockTranslate })
    const result = format({ ...baseData, status: 'working', lastTurnTag: 'success' })
    assert.equal(result, '작업 중 | 3 | 12 | 성공')
  })
})
