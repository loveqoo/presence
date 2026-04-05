const createToolRegistry = () => {
  const tools = new Map()

  const register = (tool) => {
    tools.set(tool.name, tool)
  }

  const get = (name) => tools.get(name) || null

  const list = () => [...tools.values()]

  const schema = () => [...tools.keys()]

  return { register, get, list, schema }
}

export { createToolRegistry }
