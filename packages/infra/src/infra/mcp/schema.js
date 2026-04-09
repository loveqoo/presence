import fp from '@presence/core/lib/fun-fp.js'

const { Either } = fp

// schema 검증 (Either)

const validateSchema = (inputSchema) =>
  (inputSchema && typeof inputSchema === 'object' && inputSchema.type === 'object')
    ? Either.Right(inputSchema)
    : Either.Left(inputSchema)

const ensureObjectSchema = (inputSchema) =>
  Either.fold(
    _ => ({ type: 'object', properties: {}, required: [] }),
    schema => schema,
    validateSchema(inputSchema),
  )

export { validateSchema, ensureObjectSchema }
