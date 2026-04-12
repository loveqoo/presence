/**
 * Debug Report Builder
 *
 * /report 커맨드에서 호출. state 데이터를 읽어
 * 사람과 LLM 모두 이해할 수 있는 마크다운 리포트를 생성한다.
 * 섹션 렌더링은 report-sections.js에 위임.
 */
import {
  buildTurnSection, buildIterationsSection,
  buildAssemblySection, buildPromptSection, buildResponseSection,
  buildMemoriesSection, buildStateSection, buildConfigSection,
} from './report-sections.js'
import { buildTimelineSection } from './report-timeline.js'

const buildReport = (params) => {
  const { debug, opTrace, iterationHistory, lastPrompt, lastResponse, state, config } = params
  const lines = []
  const add = (line = '') => lines.push(line)
  const now = new Date()

  add('# Presence Debug Report')
  add(`**Generated:** ${now.toISOString()}`)
  add()

  buildTurnSection(add, debug);           add()
  buildTimelineSection(add, opTrace);     add()
  buildIterationsSection(add, iterationHistory); add()
  buildAssemblySection(add, debug?.assembly); add()
  buildPromptSection(add, lastPrompt);    add()
  buildResponseSection(add, lastResponse); add()
  buildMemoriesSection(add, debug?.memories || []); add()
  buildStateSection(add, state);          add()
  buildConfigSection(add, config);        add()

  // 시스템 정보 — 고정 섹션
  add('## System')
  add(`- **Node:** ${process.version}`)
  add(`- **Platform:** ${process.platform} ${process.arch}`)
  add(`- **Generated:** ${now.toISOString()}`)

  return lines.join('\n')
}

export { buildReport }
