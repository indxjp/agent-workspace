/* global Buffer */ // The root ESLint config declares no environment globals.
// The approval token that lets the task tracker accept a write.
//
// A run cannot pause for a person to approve (probe `run-approval`), so the confirm step happens
// between two runs, in your backend. The token makes that step enforceable rather than a request in
// the instructions: the backend signs each item the person approved with a secret the model never
// sees, and the tracker refuses `create_task` unless the token matches the exact title, assignee,
// due date and meeting. A draft run has no tokens, so it cannot register anything, whatever it is
// told; an approved item cannot be edited on the way in, because the token would no longer match.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The fields an approval covers, in a fixed order. */
const signedFields = (item) => [item.sourceMeeting, item.title, item.assignee, item.due];

/** Sign one approved item with `secret`: 32 hex characters the model copies into `create_task`. */
export function approvalToken(secret, item) {
  return createHmac('sha256', secret)
    .update(JSON.stringify(signedFields(item)))
    .digest('hex')
    .slice(0, 32);
}

/** True when `token` is the approval for exactly this item. */
export function verifyApproval(secret, item, token) {
  if (typeof token !== 'string') return false;
  const expected = Buffer.from(approvalToken(secret, item));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
