import fp from './fun-fp.js'

const { Task } = fp

const forkTask = (task) => new Promise((resolve, reject) => task.fork(reject, resolve))
const fireAndForget = (task) => task.fork(() => {}, () => {})

export { Task, forkTask, fireAndForget }
