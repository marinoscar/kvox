// =============================================================================
// describeThrown (issue #125, epic #109)
// =============================================================================
//
// One helper, shared by every `catch` on the dispatch path, because that path
// has a rule the rest of the codebase does not: NOTHING IT CATCHES MAY ESCAPE,
// and some of what it catches is PERSISTED and read by an operator later.
//
// This app inlines `err instanceof Error ? err.message : String(err)`
// elsewhere, and that is fine where the result only reaches a log. Here there
// are half a dozen catch sites whose output lands in one database column, and
// they must agree — on the redaction rule below, and on what a non-`Error`
// throw looks like — or the column is a mixture of formats nobody can query.
// =============================================================================

/**
 * A thrown value, rendered for a log line or a `NotificationDelivery.error`.
 *
 * MESSAGE ONLY, NEVER THE STACK. Two reasons, both specific to this path:
 *
 *   * The result is PERSISTED. A stack in `notification_deliveries.error`
 *     bloats a table that grows with every notification sent, and tells an
 *     operator triaging "why did this bounce?" nothing they wanted.
 *   * A stack frame's source line can quote local values, and the locals on
 *     this path include a rendered message body. #125's rule is that bodies
 *     and secrets are never logged; a stack is a side door into doing exactly
 *     that.
 *
 * `catch` binds `unknown` and a non-`Error` throw is not hypothetical here —
 * a rejected promise carrying a string, a Prisma error object, a library that
 * throws a plain object.
 */
export function describeThrown(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;

  // Not `String(err)`: a thrown plain object stringifies to `[object Object]`,
  // which is indistinguishable from every other thrown plain object and so is
  // worthless in a delivery record. Naming the type at least says what
  // happened.
  return `Non-Error value thrown (${typeof err}).`;
}
