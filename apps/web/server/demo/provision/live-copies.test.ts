/**
 * What the copy of every live entry offers its demo agent, made the way R1 and a visitor get it:
 * the deploy's seed (`tests/store/seed/build.ts`) seeded into a template (`seed.ts`), then copied
 * into a workspace (`template-copy.ts`). Each tool the entry's moment check names
 * (`demo.check.tools`, what the real-model harness `tests/store/live-verify/verify.ts` judges) is one
 * the copy offers, and the tool its check says waits for a person (`demo.check.approval`) waits.
 *
 * Static: the tools are read from the copy's permissions, assignments, policy and stand-ins, as the
 * Claude engine would be handed them. Whether the deployment's runtime can carry a platform tool
 * (`search_files` needs a control plane link on the runner) is not something a copy decides.
 */
import {
  AGENT_PERMISSION_KEYS,
  CLAUDE_PERMISSION_TOOL_DENIALS,
  needsApproval,
} from '@indx-workspace/contracts/agents';
import { connectorServerKey } from '@indx-workspace/contracts/tool-connectors';
import { describe, expect, it } from 'vitest';

import { isTool } from '../../../../../examples/store/catalog/recording.ts';
import { buildSeed, liveEntries } from '../../../../../tests/store/seed/build.ts';
import type { AgentRecord } from '../../agents';
import type { AnyConnectorResource } from '../../integrations';
import { fakeSendServerCommand } from './fake-send-server';
import { createMemoryTemplatesWorld } from './templates.world.test-support';

const NOW = new Date('2026-11-17T09:00:00.000Z');
const LIMITS = { maxTurns: 5, maxBudgetUsd: 0.2 };

/** The platform's own tools of a Claude run (ADR-0147, the skill script tool) and when they are offered. */
const PLATFORM_TOOLS = {
  search_files: (agent: AgentRecord, files: number) => agent.permissions.readFiles && files > 0,
  run_skill_script: (agent: AgentRecord, _files: number, skills: number) =>
    agent.permissions.runCommands && skills > 0,
} as const;

/** The Claude Code tools a permission set and the policy's denials leave. */
function claudeTools(agent: AgentRecord): readonly string[] {
  const policy = agent.policy;
  const denied = new Set(policy !== null && 'tools' in policy ? policy.tools.deny : []);
  return AGENT_PERMISSION_KEYS.filter((permission) => agent.permissions[permission])
    .flatMap((permission) => CLAUDE_PERMISSION_TOOL_DENIALS[permission])
    .filter((tool) => !denied.has(tool));
}

/** The tools a stand-in offers, from the arguments of its command, by its run key. */
function standInTools(connector: AnyConnectorResource): readonly string[] {
  if (connector.transport !== 'stdio') return [];
  const [, source, ...rest] = connector.args ?? [];
  const key = connectorServerKey(connector.name, connector.id, new Set());
  const fakeSendSource = fakeSendServerCommand([]).args[1];
  const names =
    source === fakeSendSource
      ? rest
      : (() => {
          const carried = JSON.parse(rest.join('')) as {
            readonly reads: Readonly<Record<string, unknown>>;
            readonly writes: readonly string[];
          };
          return [...Object.keys(carried.reads), ...carried.writes];
        })();
  return names.map((name) => `mcp__${key}__${name}`);
}

describe('the copy of every live entry offers the tools its moment needs', () => {
  it.each(liveEntries().map((entry) => [entry.slug, entry] as const))(
    '%s',
    async (_slug, entry) => {
      const check = entry.demo.check;
      if (check === undefined) throw new Error(`${entry.slug} states no moment to check`);
      const world = createMemoryTemplatesWorld();
      const slug = world.entry(entry.slug);
      await world.operations.seed({ entry: slug, seed: buildSeed(entry), now: NOW });
      const owner = await world.newWorkspace();
      await world.templates.copyIntoVerification({
        entry: slug,
        workspaceId: owner.workspaceId,
        ownerUserId: owner.userId,
        limits: LIMITS,
        now: NOW,
      });
      const [agent, ...others] = await world.agents(owner.workspaceId);
      if (agent === undefined) throw new Error(`${entry.slug}: nothing was copied`);
      expect(others).toEqual([]);
      const assigned = await world.assignments(owner.workspaceId, agent.id);
      const connectors = (await world.connectors(owner.workspaceId)).filter((connector) =>
        assigned?.connectorIds.includes(connector.id),
      );
      const files = assigned?.files.length ?? 0;
      const skills = assigned?.skillIds.length ?? 0;
      const offered = [
        ...Object.entries(PLATFORM_TOOLS)
          .filter(([, offers]) => offers(agent, files, skills))
          .map(([name]) => name),
        ...claudeTools(agent),
        ...connectors.flatMap(standInTools),
      ];
      for (const tool of check.tools) {
        expect(
          offered.some((name) => isTool(name, tool)),
          `${entry.slug}: ${tool} in ${offered.join(', ')}`,
        ).toBe(true);
      }
      const policy = agent.policy;
      const gates = policy !== null && 'tools' in policy ? (policy.requireApproval ?? []) : [];
      const approval = check.approval;
      if (approval !== null) {
        const tool = offered.find((name) => isTool(name, approval));
        expect(tool, `${entry.slug}: ${approval} is offered`).toBeDefined();
        expect(needsApproval(gates, tool ?? approval), `${entry.slug}: ${approval} waits`).toBe(
          true,
        );
      }
    },
  );
});
