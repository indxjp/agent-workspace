import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';
import {
  BUILDER_TOOLS,
  type BUILDER_DEFAULT_LIMITS,
  type BuilderToolName,
} from '@indx-workspace/contracts/builder';
import type { MembershipRoleName } from '@indx-workspace/contracts/team';

import { isDraftTool } from './call';

/** The limits as numbers; `BUILDER_DEFAULT_LIMITS` is `as const`, so its own type admits no override. */
type BuilderLimits = { readonly [K in keyof typeof BUILDER_DEFAULT_LIMITS]: number };

/** Everything `decide()` may know. The shell gathers it from the ports; the core reads no I/O. */
export type Facts = {
  readonly enabled: boolean;
  readonly caller:
    { readonly kind: 'person'; readonly role: MembershipRoleName } | { readonly kind: 'none' };
  /** The authorization port's answer for this tool's kind on this agent. */
  readonly access: 'allowed' | 'not_permitted' | 'not_owner';
  /** Whether the person approved this exact call; `not_needed` for a tool that never asks. */
  readonly approval: 'granted' | 'missing' | 'not_needed';
  /** The version `local` points at for the agent a `draft_save` names; `null` for none or a new agent. */
  readonly local: { readonly version: number | null };
  readonly run: { readonly toolCalls: number; readonly failedChecksInARow: number };
  readonly limits: BuilderLimits;
  /**
   * Who is building. `builder` is the Builder run for a person: the agent-creator rules have nothing
   * to check. `agent` is an agent building another agent, with the body it runs on, whether it may
   * build at all, and whether an agent made it. `external` is an outside MCP client, which may only
   * read. There is no "unknown": the adapter resolves every caller to one of these, or refuses, so
   * the rules cannot be skipped by a missing answer.
   */
  readonly creator:
    | { readonly kind: 'builder' }
    | { readonly kind: 'external' }
    | {
        readonly kind: 'agent';
        readonly body: AgentVersionBody;
        readonly allowedToBuild: boolean;
        readonly madeByAgent: boolean;
      };
  /** Agents the workspace has created today, for the daily creation quota. */
  readonly creationsToday: number;
  /**
   * The version a `trial_run` or `evals_run` names, only looked up for an agent creator. `null`
   * when nothing was looked up, or when the agent or version cannot be resolved.
   */
  readonly target: { readonly body: AgentVersionBody } | null;
};

/** Midnight UTC of `now`'s day, where the daily creation quota starts counting. */
export const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** One journal row of the run so far. */
export type JournalRow = {
  /** `null` for a call to a tool that does not exist. */
  readonly tool: BuilderToolName | null;
  readonly outcome: 'ok' | 'refused' | 'check_failed' | 'error';
};

/**
 * The run counts from the journal rows, oldest first. A draft check that passed resets the streak;
 * a refused or errored call neither extends nor resets it, so retrying after a refusal cannot
 * escape the limit.
 */
export function tallyRun(history: readonly JournalRow[]): Facts['run'] {
  let failedChecksInARow = 0;
  for (const row of history) {
    if (row.tool === null || !isDraftTool(row.tool)) continue;
    switch (row.outcome) {
      case 'check_failed':
        failedChecksInARow += 1;
        break;
      case 'ok':
        failedChecksInARow = 0;
        break;
      case 'refused':
      case 'error':
        break;
      default: {
        const unhandled: never = row.outcome;
        return unhandled;
      }
    }
  }
  return { toolCalls: history.length, failedChecksInARow };
}

/**
 * What a retry of a journaled call gets back: the stored result of a write that succeeded, else
 * nothing. A repeat of the id by another tool is a new call, never a replay.
 */
export function replayOf(
  row: JournalRow & { readonly result: unknown },
  tool: BuilderToolName,
): { readonly result: unknown } | null {
  return row.outcome === 'ok' && row.tool === tool && BUILDER_TOOLS[tool].kind !== 'read'
    ? { result: row.result }
    : null;
}
