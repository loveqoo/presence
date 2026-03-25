// --- Path utilities ---
// 중립 레이어: core, infra, interpreter 모두에서 사용.

const parsePath = path => path.split('.')

const getByPath = (obj, path) =>
  parsePath(path).reduce(
    (cur, key) => (cur != null && typeof cur === 'object') ? cur[key] : undefined,
    obj,
  )

const setByPathPure = (obj, path, value) => {
  const keys = parsePath(path)
  const go = (o, i) => {
    const cur = o ?? {}
    if (i === keys.length - 1) return { ...cur, [keys[i]]: value }
    return { ...cur, [keys[i]]: go(cur[keys[i]], i + 1) }
  }
  return go(obj, 0)
}

export { parsePath, getByPath, setByPathPure }
