#!/usr/bin/env node
import { runScenarios } from './runner.js'
import sessionSwitch from './session-switch.scenario.js'
import approvePrompt from './approve-prompt.scenario.js'
import toolResultExpand from './tool-result-expand.scenario.js'
import streamingResponse from './streaming-response.scenario.js'
import sidePanel from './side-panel.scenario.js'
import slashTypo from './slash-typo.scenario.js'
import errorState from './error-state.scenario.js'

const ALL_SCENARIOS = [
  sessionSwitch,
  approvePrompt,
  toolResultExpand,
  streamingResponse,
  sidePanel,
  slashTypo,
  errorState,
]

const main = async () => {
  const filter = process.argv[2]
  const scenarios = filter
    ? ALL_SCENARIOS.filter(s => s.name === filter)
    : ALL_SCENARIOS

  if (scenarios.length === 0) {
    process.stderr.write(`no scenarios match: ${filter}\n`)
    process.exit(1)
  }

  const ok = await runScenarios(scenarios)
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`)
  process.exit(1)
})
