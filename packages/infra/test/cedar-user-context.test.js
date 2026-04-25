// UserContext Cedar evaluator 통합 (UC-Y1/Y2) — Y' 인프라 phase 4b
// invariant: UserContext 는 evaluator 함수 인자 필수.

import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import http from 'http'
import { UserContext } from '@presence/infra/infra/user-context.js'
import { assert, summary } from '../../../test/lib/assert.js'
import { createMockEvaluator } from '../../../test/lib/cedar-mock.js'

// 최소 mock LLM (UserContext.create 가 LLMClient 만들 때 baseUrl 만 있으면 됨)
const startMockLLM = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => { res.statusCode = 200; res.end('{}') })
  server.listen(0, () => resolve({ server, port: server.address().port }))
})

const baseConfig = (llmPort, tmpDir) => ({
  llm: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: 't', apiKey: 'k', responseFormat: 'json_object', maxRetries: 0, timeoutMs: 5000 },
  embed: { provider: 'none', baseUrl: null, apiKey: null, model: null, dimensions: 256 },
  locale: 'ko', maxIterations: 5, mcp: [],
  scheduler: { enabled: false, pollIntervalMs: 60000, todoReview: { enabled: false, cron: '0 9 * * *' } },
  delegatePolling: { intervalMs: 60000 },
  prompt: { maxContextTokens: 8000, reservedOutputTokens: 1000, maxContextChars: null, reservedOutputChars: null },
})

const run = async () => {
  console.log('UserContext Cedar evaluator tests')

  const tmpDir = mkdtempSync(join(tmpdir(), 'cedar-uc-'))
  const llm = await startMockLLM()
  const origDir = process.env.PRESENCE_DIR
  process.env.PRESENCE_DIR = tmpDir

  try {
    // UC-Y1 — UserContext 가 evaluator 보유 → userContext.evaluator(...) 정상 동작
    {
      const config = baseConfig(llm.port, tmpDir)
      const captured = []
      const tracingEvaluator = (input) => {
        captured.push(input)
        return { decision: 'allow', matchedPolicies: ['stub'], errors: [] }
      }
      const userContext = await UserContext.create(config, { evaluator: tracingEvaluator })
      try {
        assert(typeof userContext.evaluator === 'function', 'UC-Y1: userContext.evaluator 함수 노출')
        const r = userContext.evaluator({
          principal: { type: 'LocalUser', id: 'admin' },
          action:    'create_agent',
          resource:  { type: 'User', id: 'admin' },
        })
        assert(r.decision === 'allow', 'UC-Y1: evaluator 호출 결과 전달')
        assert(captured.length === 1 && captured[0].action === 'create_agent', 'UC-Y1: 주입한 evaluator 함수가 그대로 호출됨')
      } finally {
        await userContext.shutdown().catch(() => {})
      }
    }

    // UC-Y2 — evaluator 미전달 → throw (invariant 검증, legacy fallback 없음)
    {
      const config = baseConfig(llm.port, tmpDir)

      let threw = false
      let err = null
      try { await UserContext.create(config, {}) } catch (e) { threw = true; err = e }
      assert(threw, 'UC-Y2: opts 에 evaluator 부재 → throw')
      assert(/evaluator.*필수/.test(err?.message || ''), `UC-Y2: error message 에 evaluator 필수 명시 (${err?.message})`)

      // opts 자체 부재 (= {}) 도 동일
      threw = false
      try { await UserContext.create(config) } catch (_) { threw = true }
      assert(threw, 'UC-Y2: opts 부재 → throw')

      // falsy evaluator
      threw = false
      try { await UserContext.create(config, { evaluator: null }) } catch (_) { threw = true }
      assert(threw, 'UC-Y2: evaluator=null → throw')

      threw = false
      try { await UserContext.create(config, { evaluator: 'not-a-function' }) } catch (_) { threw = true }
      assert(threw, 'UC-Y2: evaluator 비함수 → throw')
    }

    // UC-Y3 — createMockEvaluator 동치 (cedar-mock 헬퍼가 contract 충족)
    {
      const evaluator = createMockEvaluator()
      const r = evaluator({
        principal: { type: 'LocalUser', id: 'x' },
        action:    'create_agent',
        resource:  { type: 'User', id: 'x' },
      })
      assert(r.decision === 'allow', 'UC-Y3: mock 기본 allow')
      assert(Array.isArray(r.matchedPolicies), 'UC-Y3: matchedPolicies 배열')
      assert(Array.isArray(r.errors), 'UC-Y3: errors 배열')
    }
  } finally {
    llm.server.close()
    if (origDir) process.env.PRESENCE_DIR = origDir
    else delete process.env.PRESENCE_DIR
    rmSync(tmpDir, { recursive: true, force: true })
  }

  summary()
}

run().catch(e => { console.error(e); process.exit(1) })
