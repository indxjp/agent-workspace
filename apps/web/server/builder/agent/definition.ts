/**
 * The Builder, the one built-in agent (#1848; design §04): its prompt, model, limits, tools and
 * approval rules, as code.
 *
 * - The Builder's only tool is `aw-control`; a fitness test keeps it that way.
 * - The limits are per run (one chat turn) and come from contracts. There is no per-run time
 *   field, so the runner's run timeout applies.
 * - The prompt version is stored in the version summary ({@link BUILDER_SHIPPED_SUMMARY}), because
 *   an agent definition has no metadata field.
 * - A bare model string names a connection, so the pinned model is the `default` connection on
 *   `BUILDER_MODEL`.
 * - `name` must stay `'builder'`: `ensureBuilderAgent` relies on it.
 */
import { readFileSync } from 'node:fs';

import {
  AW_CONTROL_SERVER,
  BUILDER_MODEL,
  BUILDER_RUN_LIMITS,
  type BuilderToolName,
} from '@indx-workspace/contracts/builder';
import { ENGINE_CATALOGUE, mcpToolName } from '@indx-workspace/contracts/engines';
import { defineAgent, mcp, toAgentVersionBody } from '@indx-workspace/sdk/define';

/**
 * The tools whose every call waits for the person. `evals_run` waits too, since its cases are
 * written by the model and run with the agent's real tools (the Owner's Q-8 amendment of
 * 2026-10-26: one approval allows one call).
 */
const APPROVAL_TOOLS = [
  'draft_save',
  'evals_run',
  'trial_run',
] as const satisfies readonly BuilderToolName[];

const ENGINE = 'claude-agent-sdk';

export const BUILDER_APPROVAL_RULES: readonly string[] = APPROVAL_TOOLS.map((tool) =>
  mcpToolName(ENGINE_CATALOGUE[ENGINE].mcpToolName, AW_CONTROL_SERVER, tool),
);

export const builderAgent = defineAgent({
  name: 'builder',
  description: 'Builds agents with you in a chat. Saves drafts only.',
  model: { connection: 'default', id: BUILDER_MODEL },
  instructions: readFileSync(new URL('./prompt.md', import.meta.url), 'utf8'),
  tools: [mcp(AW_CONTROL_SERVER)],
  limits: BUILDER_RUN_LIMITS,
  engine: { id: ENGINE, requireApproval: BUILDER_APPROVAL_RULES },
});

/** The portable body the platform ships as the Builder. */
export const builderShippedBody = () => toAgentVersionBody(builderAgent);
