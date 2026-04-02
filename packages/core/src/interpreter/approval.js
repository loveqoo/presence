import fp from '../lib/fun-fp.js'
import { Interpreter } from './compose.js'

const { Task, Reader } = fp

// onApprove가 없으면 자동 승인.
const approvalInterpreterR = Reader.asks(({ ST, onApprove }) =>
  new Interpreter(['Approve'], (f) => onApprove
    ? ST.lift(Task.fromPromise(() => onApprove(f.description))()).map(approved => f.next(approved))
    : ST.of(f.next(true))))

export { approvalInterpreterR }
