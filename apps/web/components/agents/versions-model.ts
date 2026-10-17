/**
 * The Versions tab's logic (issue #617, 80-10), kept free of React so each rule runs in a plain
 * test: the line diff of instructions, the field table of everything else, the plan text `aw
 * promote` prints, and the promotion gate's verdict read from a problem's `details`.
 */
import type { AgentPolicy } from '@indx-workspace/contracts/agents';
import type {
  AgentPointerMoveResponse,
  AgentVersionBody,
  AgentVersionEvaluation,
  AgentVersionPointer,
} from '@indx-workspace/contracts/agent-versions';
import { connectorServerKey, describeToolRule } from '@indx-workspace/contracts/tool-connectors';
import { ApiProblemError } from '@indx-workspace/sdk';

export interface DiffLine {
  readonly kind: 'same' | 'add' | 'del';
  readonly text: string;
}

/**
 * The most table cells the line diff builds. Past it the answer is "every old line removed, every
 * new line added", which stays correct and costs nothing; instructions of a few hundred lines are
 * far below it.
 */
const DIFF_CELL_LIMIT = 4_000_000;

const linesOf = (text: string): string[] => (text === '' ? [] : text.split('\n'));

// ponytail: O(n·m) longest-common-subsequence table; swap for the `diff` package if instructions
// ever grow to thousands of lines.
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  const removed = (text: string): DiffLine => ({ kind: 'del', text });
  const added = (text: string): DiffLine => ({ kind: 'add', text });
  const width = b.length + 1;
  if ((a.length + 1) * width > DIFF_CELL_LIMIT) return [...a.map(removed), ...b.map(added)];

  const common = new Uint32Array((a.length + 1) * width);
  const at = (i: number, j: number): number => common[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      common[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (x !== undefined && x === y) {
      lines.push({ kind: 'same', text: x });
      i += 1;
      j += 1;
    } else if (x !== undefined && (y === undefined || at(i + 1, j) >= at(i, j + 1))) {
      lines.push(removed(x));
      i += 1;
    } else if (y !== undefined) {
      lines.push(added(y));
      j += 1;
    }
  }
  return lines;
}

export interface FieldChange {
  readonly path: string;
  /** `undefined` when the field does not exist in the older version. */
  readonly before: string | undefined;
  /** `undefined` when the field does not exist in the newer version. */
  readonly after: string | undefined;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isLeaf = (value: unknown): boolean =>
  !isRecord(value) && !(Array.isArray(value) && value.some((item) => typeof item === 'object'));

/** Every leaf of `value` as `dotted.path` → JSON text; lists of plain values are one leaf. */
function flatten(value: unknown, path: string, into: Map<string, string>): void {
  if (isLeaf(value)) {
    into.set(path, JSON.stringify(value));
  } else if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => {
      flatten(item, `${path}[${String(index)}]`, into);
    });
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      flatten(item, path === '' ? key : `${path}.${key}`, into);
    }
  }
}

/** The current keys of connectors, keyed by `connector-<id>`; see {@link describeToolRule}. */
export type ConnectorNames = Readonly<Record<string, string>>;

/**
 * `connector-<id>` → key ({@link connectorServerKey}) for each connector, so a stored rule reads
 * with the name the model sees, such as `file-finder`. A connector whose key falls back to
 * `connector-<id>` is left out, since its label would only repeat the id. The run's tool connector
 * keys are unknown here, so none is taken.
 */
export function connectorKeyNames(
  connectors: readonly Readonly<{ id: string; name: string }>[],
): ConnectorNames {
  return Object.fromEntries(
    connectors.flatMap(({ id, name }) => {
      const server = `connector-${id}`;
      const key = connectorServerKey(name, id, new Set());
      return key === server ? [] : [[server, key]];
    }),
  );
}

/** `policy` with each tool rule stored by connector id followed by its connector's key. */
function describedPolicy(policy: AgentPolicy, names: ConnectorNames): AgentPolicy {
  if (!('tools' in policy)) return policy;
  const describe = (rules: readonly string[]): string[] =>
    rules.map((rule) => describeToolRule(rule, names));
  const { tools } = policy;
  return {
    ...policy,
    tools: {
      ...tools,
      base: tools.base === 'claude_code_preset' ? tools.base : describe(tools.base),
      autoApprove: describe(tools.autoApprove),
      deny: describe(tools.deny),
    },
  };
}

function fieldsOf(body: AgentVersionBody, names: ConnectorNames): Map<string, string> {
  const fields = new Map<string, string>();
  const { definition } = body;
  flatten({ ...definition, policy: describedPolicy(definition.policy, names) }, '', fields);
  fields.delete('agent.instructions');
  flatten(body.surfaces, 'surfaces', fields);
  return fields;
}

/**
 * The fields, other than the instructions, whose value differs between two versions' bodies. A
 * rule stored as `mcp__connector-<id>__<tool>` is shown with its connector's name from `names`,
 * which only changes how it reads, never whether it differs.
 */
export function fieldChanges(
  before: AgentVersionBody,
  after: AgentVersionBody,
  names: ConnectorNames = {},
): FieldChange[] {
  const old = fieldsOf(before, names);
  const current = fieldsOf(after, names);
  return [...new Set([...old.keys(), ...current.keys()])]
    .sort()
    .map((path) => ({ path, before: old.get(path), after: current.get(path) }))
    .filter((change) => change.before !== change.after);
}

/** `production: 6 -> 7`, the line `aw promote` and `aw rollback` print for a move. */
export function planText(move: AgentPointerMoveResponse): string {
  const from = move.from === null ? 'none' : String(move.from);
  return `${move.environment}: ${from} -> ${String(move.to)}`;
}

/** The environments whose pointer is at version `number`, for its badges. */
export function badgesFor(
  number: number,
  pointers: readonly AgentVersionPointer[],
): AgentVersionPointer['environment'][] {
  return pointers
    .filter((pointer) => pointer.number === number)
    .map((pointer) => pointer.environment);
}

/** A bar, as the CLI prints it: two places. */
export const barText = (bar: number): string => bar.toFixed(2);

/**
 * A score rounded down to two places, so a refused score never prints at or above the bar (0.8999
 * is `0.89`, not `0.90`); first snapped to its stored four places so `0.57` stays `0.57`.
 */
export const scoreText = (score: number): string =>
  (Math.floor(Math.round(score * 10_000) / 100) / 100).toFixed(2);

/** What a dry run of a move answered. */
export type MoveCheck =
  | { readonly kind: 'ready'; readonly move: AgentPointerMoveResponse }
  | { readonly kind: 'not_evaluated'; readonly version: number; readonly bar: number }
  | {
      readonly kind: 'gate_failed';
      readonly version: number;
      readonly score: number;
      readonly bar: number;
      readonly cases: readonly string[];
    }
  | { readonly kind: 'refused'; readonly code: string };

export const readyCheck = (move: AgentPointerMoveResponse): MoveCheck => ({ kind: 'ready', move });

/** The version a promote check is about, or `null` when it was refused before picking one. */
export function promoteTarget(check: MoveCheck): number | null {
  switch (check.kind) {
    case 'ready':
      return check.move.to;
    case 'not_evaluated':
    case 'gate_failed':
      return check.version;
    case 'refused':
      return null;
  }
}

/** The newest evaluation of `version`, or `undefined` when it has none. */
export const evaluationOf = (
  version: number,
  evaluations: readonly AgentVersionEvaluation[],
): AgentVersionEvaluation | undefined =>
  evaluations.find((evaluation) => evaluation.version === version);

/**
 * Whether a fresh dry run still describes the move the dialog showed: both ready, and the same
 * environment, from and to. Anything else means history changed since the dialog opened.
 */
export const samePlan = (shown: MoveCheck, fresh: MoveCheck): boolean =>
  shown.kind === 'ready' &&
  fresh.kind === 'ready' &&
  shown.move.environment === fresh.move.environment &&
  shown.move.from === fresh.move.from &&
  shown.move.to === fresh.move.to;

/**
 * Why Confirm must not roll back after re-checking: the fresh refusal itself (so a dropped
 * connection reads as such, not as a changed plan), `'plan_changed'` when it is ready but differs
 * from what the dialog showed, or `null` when the rollback may proceed.
 */
export function rollbackRefusal(
  shown: MoveCheck,
  fresh: MoveCheck,
): Exclude<MoveCheck, { kind: 'ready' }> | 'plan_changed' | null {
  if (fresh.kind !== 'ready') return fresh;
  return samePlan(shown, fresh) ? null : 'plan_changed';
}

/**
 * The promote request Confirm sends, pinned to the version the dry run showed: without it the server
 * promotes whatever `local` names when Confirm lands, which a save made since would have moved.
 */
export const promoteRequest = (check: MoveCheck): { readonly version?: number } =>
  check.kind === 'ready' ? { version: check.move.to } : {};

/**
 * A failed move or dry run as a {@link MoveCheck}: the promotion gate's two refusals are read from
 * the problem's `details` (`version:`, `score:`, `bar:`, `case:`, issue #619), as `aw promote` reads
 * them. Any other problem carries its code only, never the server's English message, so the screen
 * words it itself; anything that is not a problem (a dropped connection) is code `unavailable`.
 */
export function failedCheck(error: unknown): MoveCheck {
  if (!(error instanceof ApiProblemError)) return { kind: 'refused', code: 'unavailable' };
  const valuesOf = (prefix: string): string[] =>
    error.details.filter((detail) => detail.startsWith(prefix)).map((d) => d.slice(prefix.length));
  const version = Number(valuesOf('version:')[0]);
  const bar = Number(valuesOf('bar:')[0]);
  const score = Number(valuesOf('score:')[0]);
  if (
    error.code === 'promotion_not_evaluated' &&
    Number.isFinite(version) &&
    Number.isFinite(bar)
  ) {
    return { kind: 'not_evaluated', version, bar };
  }
  if (
    error.code === 'promotion_gate_failed' &&
    Number.isFinite(version) &&
    Number.isFinite(bar) &&
    Number.isFinite(score)
  ) {
    return { kind: 'gate_failed', version, score, bar, cases: valuesOf('case:') };
  }
  return { kind: 'refused', code: error.code };
}

/** The failing cases a gate refusal names before it elides the rest with `…`. */
const FAILING_CASES_SHOWN = 3;

export function casesText(cases: readonly string[]): string {
  const shown = cases.slice(0, FAILING_CASES_SHOWN).map((name) => JSON.stringify(name));
  if (cases.length > FAILING_CASES_SHOWN) shown.push('…');
  return shown.join(', ');
}
