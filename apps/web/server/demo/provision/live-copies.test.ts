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
 *
 * The verification workspace holds every seeded entry at once (`verification.ts`), so the second
 * group fills one and checks that each entry's copy there has what its visitor's copy has, the same
 * writes waiting for a person included: a stand-in there may carry a longer name than the template's
 * connector (`<connector>-<entry>`, ADR-0171 D3), and a gate left on the template's name would match
 * none of its tools.
 */
import {
  AGENT_PERMISSION_KEYS,
  CLAUDE_PERMISSION_TOOL_DENIALS,
  needsApproval,
} from '@indx-workspace/contracts/agents';
import { connectorServerKey } from '@indx-workspace/contracts/tool-connectors';
import { describe, expect, it } from 'vitest';

import { isTool } from '../../../../../examples/store/catalog/recording.ts';
import { buildSeed, liveEntries, seededEntries } from '../../../../../tests/store/seed/build.ts';
import type { AgentRecord } from '../../agents';
import { rulesWithRunConnectorKeys } from '../../compose/run-request-tool-connectors';
import type { AnyConnectorResource } from '../../integrations';
import { fakeSendServerCommand } from './fake-send-server';
import { UnmappedApprovalGateError, unmappedApprovalGates } from './policy-remap';
import type { DemoTemplatesWorld } from './templates.contract';
import { createMemoryTemplatesWorld } from './templates.world.test-support';
import { createDemoVerification } from './verification';

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
  const key = runKeyOf(connector);
  const fakeSendSource = fakeSendServerCommand([]).args[1];
  const names =
    source === fakeSendSource
      ? rest
      : (() => {
          const carried = JSON.parse(rest.join('')) as {
            readonly reads: Readonly<Record<string, unknown>>;
            readonly writes: readonly string[];
            // A public-source read answers from its snapshot (ADR-0170 D4), not from records.
            readonly snapshots?: Readonly<Record<string, unknown>>;
          };
          return [
            ...Object.keys(carried.reads),
            ...carried.writes,
            ...Object.keys(carried.snapshots ?? {}),
          ];
        })();
  return names.map((name) => `mcp__${key}__${name}`);
}

/** The run key of `connector`, as compose gives it when nothing else in the run takes its name. */
const runKeyOf = (connector: AnyConnectorResource): string =>
  connectorServerKey(connector.name, connector.id, new Set());

/** The stand-ins assigned to the copy `agent` in `workspaceId`. */
async function assignedConnectors(
  world: DemoTemplatesWorld,
  workspaceId: string,
  agent: AgentRecord,
): Promise<readonly AnyConnectorResource[]> {
  const assigned = await world.assignments(workspaceId, agent.id);
  return (await world.connectors(workspaceId)).filter((connector) =>
    assigned?.connectorIds.includes(connector.id),
  );
}

/**
 * The approval gates of the copy `agent` as compose hands them to the engine: a gate on a stand-in's
 * id is given the stand-in's run key (`rulesWithRunConnectorKeys`).
 */
async function runGates(
  world: DemoTemplatesWorld,
  workspaceId: string,
  agent: AgentRecord,
): Promise<readonly string[]> {
  const policy = agent.policy;
  const gates = policy !== null && 'tools' in policy ? (policy.requireApproval ?? []) : [];
  const keys = Object.fromEntries(
    (await assignedConnectors(world, workspaceId, agent)).map((c) => [c.id, runKeyOf(c)] as const),
  );
  return rulesWithRunConnectorKeys(gates, keys);
}

/**
 * The tools of the copy `agent` that wait for a person, each stand-in's tool named after the
 * template's connector (its `-<entry>` suffix dropped), so two workspaces can be compared.
 */
async function waitingTools(
  world: DemoTemplatesWorld,
  workspaceId: string,
  agent: AgentRecord,
  entry: string,
): Promise<readonly string[]> {
  const gates = await runGates(world, workspaceId, agent);
  const suffix = `-${entry}__`;
  // A platform tool is gated by its engine name, `mcp__agent-workspace__<tool>`.
  const engineName = (tool: string): string =>
    Object.hasOwn(PLATFORM_TOOLS, tool) ? `mcp__agent-workspace__${tool}` : tool;
  return (await offeredTools(world, workspaceId, agent))
    .map(engineName)
    .filter((tool) => needsApproval(gates, tool))
    .map((tool) => tool.replace(suffix, '__'))
    .sort();
}

/** The tools the copy `agent` in `workspaceId` is offered, as the Claude engine would name them. */
async function offeredTools(
  world: DemoTemplatesWorld,
  workspaceId: string,
  agent: AgentRecord,
): Promise<readonly string[]> {
  const assigned = await world.assignments(workspaceId, agent.id);
  const connectors = await assignedConnectors(world, workspaceId, agent);
  const files = assigned?.files.length ?? 0;
  const skills = assigned?.skillIds.length ?? 0;
  return [
    ...Object.entries(PLATFORM_TOOLS)
      .filter(([, offers]) => offers(agent, files, skills))
      .map(([name]) => name),
    ...claudeTools(agent),
    ...connectors.flatMap(standInTools),
  ];
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
      const offered = await offeredTools(world, owner.workspaceId, agent);
      for (const tool of check.tools) {
        expect(
          offered.some((name) => isTool(name, tool)),
          `${entry.slug}: ${tool} in ${offered.join(', ')}`,
        ).toBe(true);
      }
      const gates = await runGates(world, owner.workspaceId, agent);
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

/** One file grant of a copy: the granted path, its access, and the text of each file under it. */
async function grantOf(
  world: DemoTemplatesWorld,
  workspaceId: string,
  grant: { readonly fileId: string; readonly access: 'read' | 'read-write' },
) {
  const path = (await world.pathOf(workspaceId, grant.fileId)) ?? '';
  const under = (await world.paths(workspaceId)).filter(
    (candidate) => candidate === path || candidate.startsWith(`${path}/`),
  );
  const texts = await Promise.all(under.map((file) => world.fileText(workspaceId, file)));
  return {
    path,
    access: grant.access,
    files: Object.fromEntries(under.map((file, at) => [file, texts[at]])),
  };
}

/**
 * What one copy of an agent is made of, every id read back as a path, a name or a command. Its
 * approval gates name stand-ins by id, so they are compared as the tools that wait
 * ({@link waitingTools}).
 */
async function copyOf(world: DemoTemplatesWorld, workspaceId: string, agent: AgentRecord) {
  const assigned = await world.assignments(workspaceId, agent.id);
  const skillNames = new Map(
    (await world.skills(workspaceId)).map((skill) => [skill.id, skill.name]),
  );
  const skills = await Promise.all(
    (assigned?.skillIds ?? []).map(async (id) => {
      const name = skillNames.get(id) ?? '';
      return { name, files: await world.skillFiles(workspaceId, name) };
    }),
  );
  const connectors = (await world.connectors(workspaceId)).filter((connector) =>
    assigned?.connectorIds.includes(connector.id),
  );
  const [profile] = await world.profiles(workspaceId);
  const policy = agent.policy;
  const grants = await Promise.all(
    (assigned?.files ?? []).map((grant) => grantOf(world, workspaceId, grant)),
  );
  // Assignments carry no order of their own (they are listed by id), so each list is sorted.
  return {
    instructions: agent.instructions,
    permissions: agent.permissions,
    limits: policy?.limits,
    sandbox: agent.runtimeProfileId === profile?.id ? profile?.networkPolicy : null,
    grants: grants.sort((a, b) => a.path.localeCompare(b.path)),
    skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
    // What a stand-in runs is its command and arguments: its tools and its records.
    standIns: connectors
      .map((connector) => JSON.stringify({ command: connector.command, args: connector.args }))
      .sort(),
  };
}

describe('the verification workspace holds every seeded entry as its visitor copy has it', () => {
  it("fills one workspace with every entry, each copy as complete as a visitor's", async () => {
    const world = createMemoryTemplatesWorld();
    const entries = seededEntries('staging').map((entry) => ({
      entry,
      slug: world.entry(entry.slug),
    }));
    for (const { entry, slug } of entries) {
      await world.operations.seed({ entry: slug, seed: buildSeed(entry), now: NOW });
    }
    const owner = await world.newWorkspace();
    const verification = createDemoVerification({
      templates: world.templates,
      templateEntries: () => Promise.resolve(entries.map(({ slug }) => slug)),
      directory: world.directory,
      limits: LIMITS,
      markVerificationWorkspace: () => Promise.resolve(),
    });
    expect(await verification.fill({ workspaceId: owner.workspaceId, now: NOW })).toEqual({
      kind: 'filled',
      entries: entries.map(({ slug }) => slug),
    });
    const copies = new Map(
      (await world.agents(owner.workspaceId)).map((agent) => [agent.name, agent]),
    );
    for (const { entry, slug } of entries) {
      const guest = await world.newGuest();
      await world.templates.copyInto({
        entry: slug,
        workspaceId: guest.workspaceId,
        guestUserId: guest.userId,
        limits: LIMITS,
        now: NOW,
      });
      const [visitorAgent] = await world.agents(guest.workspaceId);
      const verified = copies.get(entry.demo.agent);
      if (visitorAgent === undefined || verified === undefined) {
        throw new Error(`${entry.slug}: no copy of ${entry.demo.agent}`);
      }
      const visitor = await copyOf(world, guest.workspaceId, visitorAgent);
      const { grants, ...shared } = await copyOf(world, owner.workspaceId, verified);
      const { grants: visitorGrants, ...visitorRest } = visitor;
      expect(shared, entry.slug).toEqual(visitorRest);
      // A folder two entries are granted holds both entries' files: each file of the visitor's copy
      // is there with the same text.
      expect(
        grants.map(({ path, access }) => ({ path, access })),
        entry.slug,
      ).toEqual(visitorGrants.map(({ path, access }) => ({ path, access })));
      for (const [at, grant] of visitorGrants.entries()) {
        expect(grants[at]?.files, `${entry.slug}: ${grant.path}`).toMatchObject(grant.files);
      }
      const waiting = await waitingTools(world, owner.workspaceId, verified, slug);
      expect(waiting, entry.slug).toEqual(
        await waitingTools(world, guest.workspaceId, visitorAgent, slug),
      );
      // Two empty lists are equal too: an entry whose moment is an approval has its write waiting.
      const approval = entry.demo.check?.approval ?? null;
      if (approval !== null) {
        expect(
          waiting.some((tool) => isTool(tool, approval)),
          `${entry.slug}: ${approval} waits in ${waiting.join(', ')}`,
        ).toBe(true);
      }
      const offered = await offeredTools(world, owner.workspaceId, verified);
      for (const tool of entry.demo.check?.tools ?? []) {
        expect(
          offered.some((name) => isTool(name, tool)),
          `${entry.slug}: ${tool}`,
        ).toBe(true);
      }
    }
  });
});

describe("a write waits for a person whatever name the entry's stand-in has", () => {
  // Staging's verification workspace was filled before the incident entry existed, so the meeting
  // minutes copy holds `tracker` and the incident copy gets `tracker-incident` (R1 run 44891928173).
  it.each([
    ['meeting-minutes', 'incident'],
    ['incident', 'meeting-minutes'],
  ] as const)('copied %s first, then %s', async (first, second) => {
    const world = createMemoryTemplatesWorld();
    const owner = await world.newWorkspace();
    const bySlug = new Map(seededEntries('staging').map((entry) => [entry.slug, entry] as const));
    const bySeeded = new Map<string, string>();
    for (const slug of [first, second]) {
      const entry = bySlug.get(slug);
      if (entry === undefined) throw new Error(`${slug} is not seeded`);
      const seeded = world.entry(slug);
      bySeeded.set(slug, seeded);
      await world.operations.seed({ entry: seeded, seed: buildSeed(entry), now: NOW });
      await world.templates.copyIntoVerification({
        entry: seeded,
        workspaceId: owner.workspaceId,
        ownerUserId: owner.userId,
        limits: LIMITS,
        now: NOW,
      });
    }
    const names = (await world.connectors(owner.workspaceId)).map((c) => c.name);
    expect(names, JSON.stringify(names)).toContain(`tracker-${bySeeded.get(second) ?? ''}`);
    const agents = new Map((await world.agents(owner.workspaceId)).map((a) => [a.name, a]));
    const writes = { incident: 'create_task', 'meeting-minutes': 'createTask' } as const;
    for (const slug of [first, second]) {
      const agent = agents.get(bySlug.get(slug)?.demo.agent ?? '');
      if (agent === undefined) throw new Error(`${slug}: nothing was copied`);
      const gates = await runGates(world, owner.workspaceId, agent);
      const write = (await offeredTools(world, owner.workspaceId, agent)).find((tool) =>
        isTool(tool, writes[slug]),
      );
      expect(write, `${slug}: ${writes[slug]} is offered`).toBeDefined();
      expect(needsApproval(gates, write ?? ''), `${slug}: ${write ?? ''} waits`).toBe(true);
    }
  });
});

describe('a copy never keeps an approval gate on a connector no stand-in replaced', () => {
  it('fails the copy, typed, rather than leave the write unguarded', async () => {
    const incident = seededEntries('staging').find((entry) => entry.slug === 'incident');
    if (incident === undefined) throw new Error('incident is not seeded');
    const seed = buildSeed(incident);
    // A tracker that only reads, with no records: the copy leaves it out, so no stand-in takes the
    // `create_task` gate.
    const readerOnly = {
      ...seed,
      connectors: seed.connectors.map((connector) => ({
        name: connector.name,
        reads: connector.reads,
        writes: [],
      })),
    };
    const world = createMemoryTemplatesWorld();
    const slug = world.entry('incident');
    await world.operations.seed({ entry: slug, seed: readerOnly, now: NOW });
    const owner = await world.newWorkspace();
    await expect(
      world.templates.copyIntoVerification({
        entry: slug,
        workspaceId: owner.workspaceId,
        ownerUserId: owner.userId,
        limits: LIMITS,
        now: NOW,
      }),
    ).rejects.toThrow(UnmappedApprovalGateError);
  });

  it('lists only gates still on a template connector, by its name or its id', () => {
    const names = new Map([['tpl-1', 'tracker']]);
    const policy = {
      engine: 'claude-agent-sdk' as const,
      tools: {
        base: 'claude_code_preset' as const,
        autoApprove: [],
        deny: [],
        permissionMode: 'default' as const,
        allowDangerouslySkipPermissions: false,
      },
      requireApproval: [
        'mcp__tracker__create_task',
        'mcp__connector-tpl-1__delete_task',
        'mcp__connector-stand-in-1__create_task',
        'mcp__agent-workspace__run_skill_script',
        'Write',
      ],
      skills: { mode: 'all' as const },
      limits: { maxTurns: null, maxBudgetUsd: null },
    };
    expect(unmappedApprovalGates(policy, names)).toEqual([
      'mcp__tracker__create_task',
      'mcp__connector-tpl-1__delete_task',
    ]);
  });
});
