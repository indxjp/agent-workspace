/**
 * The run tree as the console's run views show it (ADR-0104 acceptance, spec 04 §5.12 "Run
 * trees", issue #1517). Pure: no React, no request.
 *
 * `GET /api/runs/:id` answers a run with `children` (the runs whose `parentRunId` is it, oldest
 * first, at most 16) and `treeCost` (the read-time sum of the root's and the children's cost). The
 * depth is at most 1, so a run is a root with children, a root without, or a child, never both.
 */
import {
  AGENT_TEAM_MEMBER_TOOL_PREFIX,
  isAgentTeamMemberName,
} from '@indx-workspace/contracts/agent-teams';
import { RUN_CHILDREN_MAX, type RunTreeCost } from '@indx-workspace/contracts/runs';
import type { RunBadge } from '@indx-workspace/react/run-model';

import {
  MalformedRunError,
  badgeForRunStatus,
  formatCostDisplay,
  formatSettledAmount,
  parseRunResource,
  type RunListItem,
} from './history';
import type { RunFigureWords } from './runs-messages';

/** A run's tree as the detail read answers it: empty, with no tree cost, for a run without one. */
export interface RunTree {
  readonly children: readonly RunListItem[];
  readonly treeCost: RunTreeCost | null;
}

export const EMPTY_RUN_TREE: RunTree = { children: [], treeCost: null };

/** The Claude engine's spelling of a member tool: the platform's `agent` MCP server key. */
const ENGINE_MEMBER_TOOL_PREFIX = `mcp__${AGENT_TEAM_MEMBER_TOOL_PREFIX}`;

/** The console's link to one run: the run detail panel on `/runs` (there is no `/runs/<id>` page). */
export function runHref(runId: string): string {
  return `/runs?run=${encodeURIComponent(runId)}`;
}

/**
 * The member a tool call names: `x` for the neutral `agent__x` and for the engine's
 * `mcp__agent__x`, and `null` for every other tool, including a malformed member name.
 */
export function memberNameOfTool(toolName: string): string | null {
  const prefix = toolName.startsWith(ENGINE_MEMBER_TOOL_PREFIX)
    ? ENGINE_MEMBER_TOOL_PREFIX
    : toolName.startsWith(AGENT_TEAM_MEMBER_TOOL_PREFIX)
      ? AGENT_TEAM_MEMBER_TOOL_PREFIX
      : null;
  if (prefix === null) return null;
  const name = toolName.slice(prefix.length);
  return isAgentTeamMemberName(name) ? name : null;
}

function parseTreeCost(value: unknown, where: string): RunTreeCost {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MalformedRunError(`${where} must be a JSON object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'amount' || keys[1] !== 'currency') {
    throw new MalformedRunError(`${where} must contain exactly: amount, currency`);
  }
  const { amount, currency } = record;
  if (typeof amount !== 'string' || typeof currency !== 'string') {
    throw new MalformedRunError(`${where}: "amount" and "currency" must be strings`);
  }
  // Refuses anything but a non-negative six-place USD decimal, as a run's own cost is refused.
  formatSettledAmount(amount, currency);
  return { amount, currency };
}

/**
 * Parse the tree out of a `GET /api/runs/:id` body whose run part `root` has already been parsed.
 * Absent fields are an empty tree (a control plane that predates trees). A child that does not
 * name `root` as its parent, a child of a child, or more than {@link RUN_CHILDREN_MAX} children is
 * refused, never shown as a tree it is not.
 */
export function parseRunTree(
  detail: Readonly<Record<string, unknown>>,
  root: RunListItem,
): RunTree {
  const rawChildren = detail['children'];
  const rawTreeCost = detail['treeCost'];
  if (rawChildren === undefined && rawTreeCost === undefined) return EMPTY_RUN_TREE;
  if (!Array.isArray(rawChildren) || rawChildren.length > RUN_CHILDREN_MAX) {
    throw new MalformedRunError(
      `run.children must be an array of at most ${String(RUN_CHILDREN_MAX)} runs`,
    );
  }
  const children = rawChildren.map((child: unknown, index) =>
    parseRunResource(child, `run.children[${String(index)}]`),
  );
  if (children.length > 0 && root.parentRunId !== null) {
    throw new MalformedRunError('run.children: a child run has no children (depth 1)');
  }
  if (children.some((child) => child.parentRunId !== root.id)) {
    throw new MalformedRunError('run.children: every child must name this run as its parent');
  }
  return { children, treeCost: parseTreeCost(rawTreeCost, 'run.treeCost') };
}

/** One collapsible row of the Team card. */
export interface TeamRow {
  readonly id: string;
  readonly agentId: string;
  readonly status: string;
  readonly badge: RunBadge;
  readonly cost: string;
  readonly durationMs: number | null;
  readonly href: string;
}

/** The Team card's rows: oldest child first (by `createdAt`, then id, so the order is total). */
export function teamRows(tree: RunTree, words?: RunFigureWords): readonly TeamRow[] {
  return [...tree.children]
    .sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : Date.parse(a.createdAt) - Date.parse(b.createdAt),
    )
    .map((child) => ({
      id: child.id,
      agentId: child.agentId,
      status: child.status,
      badge: badgeForRunStatus(child.status),
      cost: formatCostDisplay(child, words),
      durationMs: child.durationMs,
      href: runHref(child.id),
    }));
}

/** The tree cost as the detail shows it, and whether every run of the tree is priced. */
export interface TreeCostDisplay {
  readonly amount: string;
  readonly settled: boolean;
}

/** `null` when there is nothing to sum: a run without children shows its own cost only. */
export function treeCostDisplay(root: RunListItem, tree: RunTree): TreeCostDisplay | null {
  if (tree.children.length === 0 || tree.treeCost === null) return null;
  return {
    amount: formatSettledAmount(tree.treeCost.amount, tree.treeCost.currency),
    settled: [root, ...tree.children].every((run) => run.accountingState === 'complete'),
  };
}

/** A child run the run view can link a member call to, with its agent's name when known. */
export interface ChildRunLink {
  readonly id: string;
  readonly agentName: string | null;
}

/** One `agent__<name>` call of the run view, in call order. */
export interface MemberCall {
  readonly stepId: string;
  readonly toolName: string;
}

/**
 * Which child run each member call started: per call in order, the first unused child whose agent
 * name is the member name, else the first unused child (the platform starts one child per call,
 * oldest first). A call with no child left is not linked.
 *
 * shortcut: a member whose `toolName` differs from its agent's name is matched by position, because
 * a child run does not carry the member name it was called as; upgrade when the run resource or
 * its tool event names the child run id.
 */
export function matchMemberCalls(
  calls: readonly MemberCall[],
  children: readonly ChildRunLink[],
): ReadonlyMap<string, ChildRunLink> {
  const unused = [...children];
  const matched = new Map<string, ChildRunLink>();
  for (const call of calls) {
    const member = memberNameOfTool(call.toolName);
    if (member === null) continue;
    const byName = unused.findIndex((child) => child.agentName === member);
    const index = byName === -1 ? 0 : byName;
    const child = unused[index];
    if (child === undefined) continue;
    unused.splice(index, 1);
    matched.set(call.stepId, child);
  }
  return matched;
}
