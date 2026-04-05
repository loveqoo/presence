// =============================================================================
// Plan JSON Schema: LLM의 plan 응답 형식 정의 (OpenAI json_schema mode).
// 깊은 중첩을 피하려 sub-schema로 분해.
// =============================================================================

// Op별 인자 객체
const opArgsSchema = {
  type: 'object',
  description: 'Op별 인자',
  properties: {
    query:       { type: 'string' },
    prompt:      { type: 'string' },
    ctx:         { type: 'array', items: { type: 'integer' } },
    tool:        { type: 'string' },
    tool_args:   { type: 'object' },
    ref:         { type: 'integer' },
    description: { type: 'string' },
    target:      { type: 'string' },
    task:        { type: 'string' },
    message:     { type: 'string' },
  },
}

// 단일 plan step
const stepSchema = {
  type: 'object',
  required: ['op'],
  properties: {
    op: {
      type: 'string',
      enum: ['LOOKUP_MEMORY', 'ASK_LLM', 'EXEC', 'RESPOND', 'APPROVE', 'DELEGATE'],
    },
    args: opArgsSchema,
  },
}

// 최상위 planSchema
const planSchema = {
  name: 'agent_plan',
  strict: true,
  schema: {
    type: 'object',
    required: ['type'],
    properties: {
      type: {
        type: 'string',
        enum: ['plan', 'direct_response'],
        description: '계획 실행이 필요하면 plan, 단순 대화면 direct_response',
      },
      message: {
        type: 'string',
        description: 'direct_response일 때의 응답 메시지',
      },
      steps: {
        type: 'array',
        description: 'plan일 때의 실행 단계들',
        items: stepSchema,
      },
    },
  },
}

export { planSchema, stepSchema, opArgsSchema }
