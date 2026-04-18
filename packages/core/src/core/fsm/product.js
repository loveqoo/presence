// =============================================================================
// Product — 직교 FSM 합성
//
// product({ key: fsm }) — 독립 축들의 AND 합성
// parallel(a, b)        — product 의 2항 alias
//
// 설계: docs/design/fsm.md §D4 (event 순서 = key 순서 고정), §D7 (free function)
// =============================================================================

function product(fsmMap) {
  if (fsmMap === null || typeof fsmMap !== 'object') {
    throw new Error('product: requires an object map')
  }
  const keys = Object.keys(fsmMap)
  const initial = {}
  for (const k of keys) initial[k] = fsmMap[k].initial
  const id = 'product(' + keys.join(',') + ')'
  return { kind: 'product', id, initial, children: fsmMap, keys }
}

function parallel(a, b) {
  return product({ left: a, right: b })
}

export { product, parallel }
