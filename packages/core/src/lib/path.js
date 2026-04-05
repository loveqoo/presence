import fp from './fun-fp.js'

const { Lens, composeLens, view, set: setLens, over } = fp

// --- Path utilities ---
// 문자열 path로 지정된 focus에 대한 불변 읽기/쓰기 계층.
// Van Laarhoven Lens 위에 재정의 — getByPath/setByPathPure는 lens의 thin wrapper.
// 중립 레이어: core, infra, interpreter 모두에서 사용.

const parsePath = path => path.split('.')

// --- Primitive lens: 단일 key focus ---
// setter는 null/undefined 상위에 대해 새 객체 생성 (setByPathPure의 기존 계약 유지)
const propLens = key => Lens(
  obj => obj?.[key],
  (value, obj) => ({ ...(obj ?? {}), [key]: value }),
)

// --- path 문자열 → Lens (캐시) ---
const lensCache = new Map()
const lensFromPath = path => {
  let cached = lensCache.get(path)
  if (!cached) {
    cached = composeLens(...parsePath(path).map(propLens))
    lensCache.set(path, cached)
  }
  return cached
}

// --- 기존 API: lens wrapper ---
const getByPath = (obj, path) => view(lensFromPath(path), obj)
const setByPathPure = (obj, path, value) => setLens(lensFromPath(path), value, obj)

// --- 신규: focus 변환 (get → 계산 → set 축약) ---
const overPath = (obj, path, f) => over(lensFromPath(path), f, obj)

export { parsePath, getByPath, setByPathPure, overPath, propLens, lensFromPath }
