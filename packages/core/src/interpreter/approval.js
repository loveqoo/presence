import fp from '../lib/fun-fp.js'
import { Interpreter } from './compose.js'

const { Task } = fp

// --- ApprovalInterpreter ---
// Approve — 외부 I/O (사용자 승인 채널).
// onApprove가 없으면 자동 승인.

/**
 * Create an interpreter for the `Approve` op.
 * If `onApprove` is provided, delegates to it; otherwise auto-approves with `true`.
 * @param {{ ST: object, onApprove?: (description: string) => Promise<boolean> }} deps
 * @returns {Interpreter}
 */

const createApprovalInterpreter = ({ ST, onApprove }) =>
  new Interpreter(['Approve'], (f) => onApprove
    ? ST.lift(Task.fromPromise(() => onApprove(f.description))()).map(approved => f.next(approved))
    : ST.of(f.next(true)))

export { createApprovalInterpreter }
