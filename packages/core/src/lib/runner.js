import fp from './fun-fp.js'

const { Free } = fp

const runFreeWithStateT = (interpret, ST) => program => initialState =>
  new Promise((resolve, reject) => {
    const step = (state, free) => {
      if (Free.isPure(free)) return resolve([free.value, state])
      if (Free.isImpure(free)) {
        try {
          interpret(free.functor)
            .run(state)
            .fork(reject, ([nextFree, newState]) => step(newState, nextFree))
        } catch (err) { reject(err) }
      } else {
        reject(new Error('runFreeWithStateT: unexpected Free node'))
      }
    }
    step(initialState, program)
  })

export { runFreeWithStateT }
