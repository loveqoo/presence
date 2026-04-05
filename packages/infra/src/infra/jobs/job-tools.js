import { Cron } from 'croner'
import { withEventMeta } from '../events.js'
import { fireAndForget } from '@presence/core/lib/task.js'

// --- Cron 유틸리티 (jobs 도메인 공용) ---

// 다음 실행 시각 계산 (epoch ms). 잘못된 표현식은 null 반환.
const calcNextRun = (cronExpr) => {
  try {
    const job = new Cron(cronExpr, { paused: true })
    const next = job.nextRun()
    return next ? next.getTime() : null
  } catch (_) {
    return null
  }
}

// cron 표현식 유효성 검사.
const validateCron = (expr) => {
  try {
    new Cron(expr, { paused: true })
    return true
  } catch (_) {
    return false
  }
}

// --- Job 관리 에이전트 툴 ---
// toolRegistry.register()로 등록. store + eventActor 클로저로 캡처.

const createJobTools = ({ store, eventActor }) => {
  const fmtJob = (job) => {
    const next = job.nextRun ? new Date(job.nextRun).toLocaleString() : '미예약'
    const tools = job.allowedTools?.length ? ` | allowedTools: [${job.allowedTools.join(', ')}]` : ''
    return `[${job.id}] ${job.name} | cron: ${job.cron} | enabled: ${job.enabled} | next: ${next}${tools}`
  }

  const fmtRun = (run) => {
    const dur = run.finishedAt ? `${run.finishedAt - run.startedAt}ms` : '진행중'
    const ts = new Date(run.startedAt).toLocaleString()
    return `${ts} | ${run.status} | attempt: ${run.attempt} | ${dur}${run.error ? ` | error: ${run.error}` : ''}`
  }

  return [
    {
      name: 'schedule_job',
      description: '새 반복 Job을 생성합니다. cron 표현식으로 실행 주기를 설정합니다. 예: "0 9 * * 1-5" (평일 오전 9시), "*/30 * * * *" (30분마다)',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Job 이름 (고유하지 않아도 됨)' },
          cron: { type: 'string', description: 'Cron 표현식 (초 필드 선택적)' },
          prompt: { type: 'string', description: '에이전트에게 전달할 작업 지시' },
          max_retries: { type: 'number', description: '최대 재시도 횟수 (기본 3)' },
          allowed_tools: { type: 'array', items: { type: 'string' }, description: '허용할 툴 이름 정규식 패턴 목록. 비어있으면 모든 툴 허용. 예: ["read_file", "^search"]' },
        },
        required: ['name', 'cron', 'prompt'],
      },
      handler: ({ name, cron, prompt, max_retries = 3, allowed_tools = [] }) => {
        if (!validateCron(cron)) return `오류: 유효하지 않은 cron 표현식: "${cron}"`
        const nextRun = calcNextRun(cron)
        const job = store.createJob({ name, prompt, cron, maxRetries: max_retries, allowedTools: allowed_tools, nextRun })
        return `Job 생성됨:\n${fmtJob(job)}`
      },
    },

    {
      name: 'list_jobs',
      description: '등록된 Job 목록과 다음 실행 예정 시각을 표시합니다.',
      parameters: { type: 'object', properties: {} },
      handler: () => {
        const jobs = store.listJobs()
        if (jobs.length === 0) return '등록된 Job이 없습니다.'
        return jobs.map(fmtJob).join('\n')
      },
    },

    {
      name: 'update_job',
      description: 'Job 설정(이름, cron, prompt, 활성화 여부, 허용 툴 목록)을 변경합니다.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job ID' },
          name: { type: 'string' },
          cron: { type: 'string', description: '새 cron 표현식' },
          prompt: { type: 'string' },
          enabled: { type: 'boolean', description: 'true=활성, false=비활성' },
          max_retries: { type: 'number' },
          allowed_tools: { type: 'array', items: { type: 'string' }, description: '허용할 툴 이름 정규식 패턴 목록. 비어있으면 모든 툴 허용.' },
        },
        required: ['id'],
      },
      handler: ({ id, name, cron, prompt, enabled, max_retries, allowed_tools }) => {
        if (!store.getJob(id)) return `오류: Job을 찾을 수 없음: ${id}`
        if (cron !== undefined && !validateCron(cron)) return `오류: 유효하지 않은 cron 표현식: "${cron}"`

        const fields = {}
        if (name !== undefined) fields.name = name
        if (cron !== undefined) { fields.cron = cron; fields.next_run = calcNextRun(cron) }
        if (prompt !== undefined) fields.prompt = prompt
        if (enabled !== undefined) fields.enabled = enabled ? 1 : 0
        if (max_retries !== undefined) fields.max_retries = max_retries
        if (allowed_tools !== undefined) fields.allowed_tools = JSON.stringify(allowed_tools)

        const job = store.updateJob(id, fields)
        return `Job 업데이트됨:\n${fmtJob(job)}`
      },
    },

    {
      name: 'delete_job',
      description: 'Job을 삭제합니다. 실행 이력도 함께 삭제됩니다.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Job ID' } },
        required: ['id'],
      },
      handler: ({ id }) => {
        const job = store.getJob(id)
        if (!job) return `오류: Job을 찾을 수 없음: ${id}`
        store.deleteJob(id)
        return `Job 삭제됨: ${job.name} (${id})`
      },
    },

    {
      name: 'job_history',
      description: '특정 Job의 최근 실행 이력을 조회합니다.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job ID' },
          limit: { type: 'number', description: '조회 개수 (기본 10, 최대 50)' },
        },
        required: ['id'],
      },
      handler: ({ id, limit = 10 }) => {
        if (!store.getJob(id)) return `오류: Job을 찾을 수 없음: ${id}`
        const runs = store.getRunHistory(id, Math.min(limit, 50))
        if (runs.length === 0) return '실행 이력이 없습니다.'
        return runs.map(fmtRun).join('\n')
      },
    },

    {
      name: 'run_job_now',
      description: 'Job을 즉시 실행합니다. 다음 예약 시각은 변경되지 않습니다.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Job ID' } },
        required: ['id'],
      },
      handler: ({ id }) => {
        const job = store.getJob(id)
        if (!job) return `오류: Job을 찾을 수 없음: ${id}`
        const runId = store.startRun(job.id, 1)
        const event = withEventMeta({
          id: runId,
          type: 'scheduled_job',
          jobId: job.id,
          jobName: job.name,
          prompt: job.prompt,
          runId,
          attempt: 1,
          allowedTools: job.allowedTools || [],
        })
        fireAndForget(eventActor.enqueue(event))
        return `Job 즉시 실행 요청됨: ${job.name} (runId: ${runId})`
      },
    },
  ]
}

export { createJobTools, calcNextRun, validateCron }
