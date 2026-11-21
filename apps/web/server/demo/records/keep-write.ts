/**
 * The pure decision of ADR-0169 D3: what a records stand-in keeps for one approved call. No I/O;
 * `approved-writes.ts` reads the stand-in's row, calls these, and writes the row back.
 */
import {
  DEMO_RECORD_ISSUES_MAX,
  DEMO_RECORD_SCHEMAS,
  DEMO_RECORD_WRITES_MAX,
  type DemoRecordIssue,
} from '@indx-workspace/contracts/demo-operator';
import { z } from 'zod';

import { callKey, type KeptOutcome, type RecordsServerState } from '../provision/records-server';

/** The canonical text of an approved call (`canonicalCall`, ADR-0145 D2.1), as JSON. */
const ApprovedCallSchema = z.strictObject({ input: z.unknown(), name: z.string().min(1) });

/** An approved call's tool name and arguments, or `null` when its canonical text is not one. */
export function approvedCallOf(
  canonicalCall: string,
): { readonly toolName: string; readonly input: unknown } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalCall);
  } catch {
    return null;
  }
  const call = ApprovedCallSchema.safeParse(parsed);
  return call.success ? { toolName: call.data.name, input: call.data.input } : null;
}

const MCP_PREFIX = 'mcp__';
const SERVER_SEPARATOR = '__';

/**
 * The MCP server key and tool of an engine tool name (`mcp__<server>__<tool>`), or `null` for any
 * other tool. A server key never holds `_` (`connectorServerKey`), so the first `__` after the
 * prefix ends it.
 */
export function mcpToolOf(
  toolName: string,
): { readonly server: string; readonly tool: string } | null {
  if (!toolName.startsWith(MCP_PREFIX)) return null;
  const rest = toolName.slice(MCP_PREFIX.length);
  const at = rest.indexOf(SERVER_SEPARATOR);
  if (at <= 0) return null;
  const tool = rest.slice(at + SERVER_SEPARATOR.length);
  return tool === '' ? null : { server: rest.slice(0, at), tool };
}

/**
 * The issue codes whose zod message is built from the schema alone (a type name, a bound, a format,
 * the allowed options, or our own refinement), never from the visitor's input. Any other code (an
 * unrecognized key names the key the visitor sent) gets a fixed message instead.
 */
const SCHEMA_ONLY_MESSAGES: ReadonlySet<string> = new Set([
  'invalid_type',
  'too_big',
  'too_small',
  'invalid_format',
  'invalid_value',
  'custom',
]);
const FIXED_MESSAGE = 'is not part of a record of this kind';

/**
 * A zod issue as a refusal names it: the path (schema keys and indexes only, since unknown keys are
 * refused at their parent) and a message that never echoes what the visitor sent.
 */
function issueOf(issue: z.core.$ZodIssue): DemoRecordIssue {
  const path = issue.path.map(String).join('.');
  const message = SCHEMA_ONLY_MESSAGES.has(issue.code)
    ? issue.message.slice(0, 500)
    : FIXED_MESSAGE;
  return { path: path === '' ? '$' : path.slice(0, 200), message };
}

/**
 * The state after keeping the approved call of `write` with `input`: the record when the input is
 * a valid record of the write's kind (with an `id` and its `kind`), else the refusal with its
 * issues. `null` when nothing is kept: `write` is not a recorded write of this stand-in, or the
 * stand-in already keeps {@link DEMO_RECORD_WRITES_MAX} calls.
 */
export function keepApprovedWrite(
  state: RecordsServerState,
  write: string,
  input: unknown,
): RecordsServerState | null {
  const entry = state.recorded.find((candidate) => candidate.write === write);
  if (entry === undefined || state.written.length >= DEMO_RECORD_WRITES_MAX) return null;
  const parsed = DEMO_RECORD_SCHEMAS[entry.kind].safeParse(input);
  // Ids count per kind, so a stand-in with two recorded writes numbers each kind from 1.
  const kept = state.written.filter(
    (call) => call.outcome.recorded && call.outcome.record['kind'] === entry.kind,
  ).length;
  const outcome: KeptOutcome = parsed.success
    ? {
        recorded: true,
        record: { id: `${entry.kind}-${String(kept + 1)}`, kind: entry.kind, ...parsed.data },
      }
    : {
        recorded: false,
        code: 'demo_record_invalid',
        issues: parsed.error.issues.slice(0, DEMO_RECORD_ISSUES_MAX).map(issueOf),
      };
  // The arguments are kept as their key only: an invalid call cannot fill the stand-in's bound.
  return { ...state, written: [...state.written, { write, key: callKey(input), outcome }] };
}
