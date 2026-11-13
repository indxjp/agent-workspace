import type { RunApprovalCall } from '@indx-workspace/contracts/runs';

/**
 * How the approval prompt shows the call a run paused on (#2091 follow-up).
 *
 * - `command`: a shell call whose only arguments are the command and the agent's own description of
 *   it, and whose command draws as it is written (no hidden or control characters). The prompt shows the command alone; the full call, description included, stays one click
 *   away. The description is the agent's words about the command, not the command, so it is never
 *   the thing a person approves at a glance.
 * - `json`: any other call, pretty-printed. Every argument is shown; nothing is folded away.
 * - `raw`: the canonical text as it arrived, when it cannot be read as `{"input":…,"name":…}` for
 *   this tool. Shown exactly, never guessed at.
 */
export type ApprovalCallView =
  | { readonly kind: 'command'; readonly command: string }
  | { readonly kind: 'json'; readonly text: string }
  | { readonly kind: 'raw'; readonly text: string };

/** The shell tools whose `command` argument is the whole of what runs. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash']);

/**
 * Arguments a shell call may carry and still be shown as its command alone. Anything else, such as a
 * timeout, a background flag or a sandbox override, changes what approving means, so a call carrying
 * it is shown in full.
 */
const COMMAND_ONLY_KEYS: ReadonlySet<string> = new Set(['command', 'description']);

/**
 * Characters a page draws as nothing, or as something else: control characters other than a line
 * break or a tab (a carriage return, a backspace, a terminal escape) and format characters (a
 * right-to-left override, a zero-width space). The JSON form escapes the control characters, so a
 * command carrying any of these is shown as the full call, where they are spelled out or at least
 * not alone.
 */
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}]/u;
const SHOWN_CONTROLS = /[\n\t]/gu;

function drawsAsWritten(command: string): boolean {
  return !HIDDEN_CHARACTERS.test(command.replace(SHOWN_CONTROLS, ''));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function approvalCallView(call: RunApprovalCall): ApprovalCallView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.canonicalCall);
  } catch {
    return { kind: 'raw', text: call.canonicalCall };
  }
  if (
    !isPlainObject(parsed) ||
    Object.keys(parsed).length !== 2 ||
    !('input' in parsed) ||
    parsed['name'] !== call.toolName
  ) {
    return { kind: 'raw', text: call.canonicalCall };
  }
  const input = parsed['input'];
  if (
    SHELL_TOOLS.has(call.toolName) &&
    isPlainObject(input) &&
    Object.keys(input).every((key) => COMMAND_ONLY_KEYS.has(key)) &&
    typeof input['command'] === 'string' &&
    input['command'].trim() !== '' &&
    drawsAsWritten(input['command']) &&
    (input['description'] === undefined || typeof input['description'] === 'string')
  ) {
    return { kind: 'command', command: input['command'] };
  }
  return { kind: 'json', text: JSON.stringify(parsed, null, 2) };
}
