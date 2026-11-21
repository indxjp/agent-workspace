/**
 * Template seeding (`seed.ts`), run against memory stores always and against a real PostgreSQL
 * whenever `TEST_DATABASE_URL` names one: what the deployment's operator step leaves in a template
 * workspace, and what a visitor's copy then gets from it.
 */
import { DEMO_SEND_RESULT, type DemoEntrySlug } from '@indx-workspace/contracts/demo';
import {
  DemoTemplateReportsSchema,
  DemoTemplateSeedSchema,
  type DemoTemplateSeed,
} from '@indx-workspace/contracts/demo-operator';
import { needsApproval } from '@indx-workspace/contracts/agents';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildSeed, liveEntries } from '../../../../../tests/store/seed/build.ts';
import { approvalGatesForRun } from '../../compose/run-request-approval-gates';
import { checkSeed, DemoSeedRefusal, templateOwnerEmail } from './seed';
import type { DemoSandbox } from './ports';
import type { DemoTemplatesWorld } from './templates.contract';
import {
  createMemoryTemplatesWorld,
  openPostgresTemplatesWorld,
} from './templates.world.test-support';
import { isTemplateOwnerEmail } from './template-owner';
import { readRecordsServerState } from './records-server';

const NOW = new Date('2026-11-16T09:00:00.000Z');
const encode = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/** A valid seed: a definition (K-1 shape), one declared connector, one sample file, two record sets. */
function seedOf(overrides: { instructions?: string; files?: Record<string, string> } = {}) {
  const files = overrides.files ?? { 'deals/q1.csv': 'id,amount\n1,100\n' };
  return DemoTemplateSeedSchema.parse({
    definition: {
      apiVersion: 'agentworkspace.dev/v1',
      kind: 'AgentDefinition',
      agent: {
        name: 'sales-assistant',
        instructions: overrides.instructions ?? 'Work with the sample deals.',
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: true,
        },
        model: null,
        modelConnectionName: null,
        runtimeProfileName: null,
      },
      policy: {
        engine: 'claude-agent-sdk',
        tools: {
          base: 'claude_code_preset',
          permissionMode: 'default',
          autoApprove: ['mcp__crm__contact_list'],
          deny: ['mcp__crm__contact_delete'],
        },
        skills: { mode: 'allowlist', names: [] },
        limits: { maxTurns: 12, maxBudgetUsd: 0.6 },
      },
      policySource: 'stored',
      resources: {
        files: [{ path: 'deals', access: 'read' }],
        skills: [],
        connectors: ['crm'],
      },
    },
    connectors: [
      {
        name: 'crm',
        reads: ['contact_list', 'contact_get'],
        writes: ['contact_update'],
      },
    ],
    skills: [],
    files: Object.entries(files).map(([path, text]) => ({ path, base64: encode(text) })),
    records: [
      {
        connector: 'crm',
        resource: 'contact',
        lang: 'en',
        tools: ['contact_list', 'contact_get'],
        data: [{ id: 'c1', name: 'Misaki Sato' }],
      },
      {
        connector: 'crm',
        resource: 'contact',
        lang: 'ja',
        tools: ['contact_list', 'contact_get'],
        data: [{ id: 'c1', name: '佐藤 美咲' }],
      },
    ],
  });
}

/** The files of the seed's `cost-model` skill, its instruction `body`. */
function costModelFiles(body: string): Record<string, string> {
  return {
    'SKILL.md': `---\nname: cost-model\ndescription: Prices a part.\n---\n\n${body}\n`,
    'scripts/estimate.mjs': 'export const estimate = () => 1;\n',
  };
}

/** `value` with its agent given the carried skill `cost-model` and the built-in `office-reader`. */
function withSkills(value: DemoTemplateSeed, body: string): DemoTemplateSeed {
  return {
    ...value,
    definition: {
      ...value.definition,
      policy: {
        ...value.definition.policy,
        skills: { mode: 'allowlist', names: ['cost-model', 'office-reader'] },
      },
      resources: { ...value.definition.resources, skills: ['cost-model', 'office-reader'] },
    },
    skills: [
      {
        name: 'cost-model',
        files: Object.entries(costModelFiles(body)).map(([path, text]) => ({
          path,
          base64: encode(text),
        })),
      },
    ],
  };
}

function describeSeeding(
  label: string,
  make: (sandbox?: Partial<DemoSandbox>) => Promise<DemoTemplatesWorld>,
): void {
  describe(`template seeding: ${label}`, () => {
    const seed = async (world: DemoTemplatesWorld, entry: DemoEntrySlug, value: DemoTemplateSeed) =>
      world.operations.seed({ entry, seed: value, now: NOW });

    it('makes the template with its own template-owner account as the only member, and hasEntry is then true', async () => {
      const world = await make();
      const entry = world.entry('made');
      expect(await world.templates.exists(entry)).toBe(false);
      expect(await seed(world, entry, seedOf())).toEqual({ changed: true });
      const id = await world.templateId(entry);
      expect(id).not.toBeNull();
      const members = await world.directory.forWorkspace(id ?? '').listMemberships();
      expect(members).toHaveLength(1);
      expect(members[0]?.email).toBe(templateOwnerEmail(entry));
      expect(isTemplateOwnerEmail(members[0]?.email ?? '')).toBe(true);
      expect(await world.templates.exists(entry)).toBe(true);
    });

    it('creates the agent the definition describes, with its files, its declared connector and its stored policy', async () => {
      const world = await make();
      const entry = world.entry('agent');
      await seed(world, entry, seedOf());
      const id = (await world.templateId(entry)) ?? '';
      const [agent, ...rest] = await world.agents(id);
      expect(rest).toEqual([]);
      expect(agent).toMatchObject({
        name: 'sales-assistant',
        instructions: 'Work with the sample deals.',
        modelConnectionId: null,
        runtimeProfileId: null,
      });
      const assigned = await world.assignments(id, agent?.id ?? '');
      const paths = await Promise.all(
        (assigned?.files ?? []).map((grant) => world.pathOf(id, grant.fileId)),
      );
      expect(paths).toEqual(['deals']);
      const [crm, ...others] = await world.connectors(id);
      expect(others).toEqual([]);
      expect(crm).toMatchObject({
        name: 'crm',
        transport: 'stdio',
        url: null,
        hasCredential: false,
      });
      expect(assigned?.connectorIds).toEqual([crm?.id]);
      expect(await world.fileText(id, 'deals/q1.csv')).toBe('id,amount\n1,100\n');
      const policy = agent?.policy;
      if (policy === undefined || policy === null || !('tools' in policy))
        throw new Error('no policy');
      // Rules written by connector name are stored by the connector's id.
      expect(policy.tools.autoApprove).toEqual([`mcp__connector-${crm?.id}__contact_list`]);
      expect(policy.tools.deny).toContain(`mcp__connector-${crm?.id}__contact_delete`);
      expect(policy.limits).toEqual({ maxTurns: 12, maxBudgetUsd: 0.6 });
    });

    it('stores an approval gate by the connector id, so a rename after seeding keeps the write waiting (#2439)', async () => {
      const world = await make();
      const entry = world.entry('agent');
      const base = seedOf();
      const policy = base.definition.policy;
      if (!('tools' in policy)) throw new Error('the seed policy is not on the Claude arm');
      await seed(world, entry, {
        ...base,
        definition: {
          ...base.definition,
          policy: { ...policy, requireApproval: ['mcp__crm__contact_update'] },
        },
      });
      const id = (await world.templateId(entry)) ?? '';
      const [agent] = await world.agents(id);
      const [crm] = await world.connectors(id);
      const stored = agent?.policy;
      if (stored === undefined || stored === null || !('tools' in stored))
        throw new Error('no policy');
      expect(stored.requireApproval).toEqual([`mcp__connector-${crm?.id}__contact_update`]);
      // The template's connector renamed after seeding: a run keys it by its new name.
      const renamed = 'crm-renamed';
      const gates = approvalGatesForRun(stored.requireApproval ?? [], {
        mcpServers: { [renamed]: { type: 'http', url: 'https://crm.example.test/mcp' } },
        connectorNames: { [renamed]: renamed },
        connectorKeys: { [crm?.id ?? '']: renamed },
      });
      expect(needsApproval(gates, `mcp__${renamed}__contact_update`)).toBe(true);
    });

    it('makes a folder the agent is granted that no sample file is under, empty, and a copy gets it too', async () => {
      const world = await make();
      const entry = world.entry('scratch');
      const value = seedOf();
      const withScratch = {
        ...value,
        definition: {
          ...value.definition,
          resources: {
            ...value.definition.resources,
            files: [
              ...value.definition.resources.files,
              { path: 'drafts', access: 'read-write' as const },
            ],
          },
        },
      };
      await seed(world, entry, withScratch);
      const id = (await world.templateId(entry)) ?? '';
      expect(await world.paths(id)).toContain('drafts');
      const [agent] = await world.agents(id);
      const granted = await Promise.all(
        ((await world.assignments(id, agent?.id ?? ''))?.files ?? []).map((grant) =>
          world.pathOf(id, grant.fileId),
        ),
      );
      expect(granted.sort()).toEqual(['deals', 'drafts']);
      const guest = await world.newGuest();
      await world.templates.copyInto({
        entry,
        workspaceId: guest.workspaceId,
        guestUserId: guest.userId,
        limits: { maxTurns: null, maxBudgetUsd: null },
        now: NOW,
      });
      expect(await world.paths(guest.workspaceId)).toContain('drafts');
    });

    it('does nothing the second time the same seed is sent', async () => {
      const world = await make();
      const entry = world.entry('twice');
      await seed(world, entry, seedOf());
      const id = (await world.templateId(entry)) ?? '';
      const before = JSON.stringify([
        (await world.agents(id)).map((agent) => agent.id),
        (await world.connectors(id)).map((connector) => connector.id),
        await world.paths(id),
      ]);
      expect(await seed(world, entry, seedOf())).toEqual({ changed: false });
      expect(
        JSON.stringify([
          (await world.agents(id)).map((agent) => agent.id),
          (await world.connectors(id)).map((connector) => connector.id),
          await world.paths(id),
        ]),
      ).toBe(before);
    });

    it('replaces the agent, the files and the connectors when the seed changes, leaving one of each', async () => {
      const world = await make();
      const entry = world.entry('changed');
      await seed(world, entry, seedOf());
      const id = (await world.templateId(entry)) ?? '';
      const changed = seedOf({
        instructions: 'A new instruction.',
        files: { 'deals/q2.csv': 'id,amount\n2,200\n' },
      });
      expect(await seed(world, entry, changed)).toEqual({ changed: true });
      const agents = await world.agents(id);
      expect(agents.map((agent) => agent.instructions)).toEqual(['A new instruction.']);
      expect(await world.fileText(id, 'deals/q1.csv')).toBeNull();
      expect(await world.fileText(id, 'deals/q2.csv')).toBe('id,amount\n2,200\n');
      expect(await world.connectors(id)).toHaveLength(1);
      // And once more the same: no change.
      expect(await seed(world, entry, changed)).toEqual({ changed: false });
    });

    it('serves a copy made from the seeded template: the files, the sandbox, and a records stand-in', async () => {
      const world = await make();
      const entry = world.entry('copy');
      await seed(world, entry, seedOf());
      const guest = await world.newGuest();
      await world.templates.copyInto({
        entry,
        workspaceId: guest.workspaceId,
        guestUserId: guest.userId,
        limits: { maxTurns: 5, maxBudgetUsd: 0.2 },
        now: NOW,
      });
      const [agent] = await world.agents(guest.workspaceId);
      expect(agent).toMatchObject({ name: 'sales-assistant' });
      // The template said unrestricted network; the copy never has it.
      expect(agent?.permissions.unrestrictedNetwork).toBe(false);
      expect(agent?.runtimeProfileId).not.toBeNull();
      expect(await world.fileText(guest.workspaceId, 'deals/q1.csv')).toBe('id,amount\n1,100\n');
      expect(
        (await world.paths(guest.workspaceId)).filter((path) => path.startsWith('demo-template')),
      ).toEqual([]);
      const [crm] = await world.connectors(guest.workspaceId);
      if (crm === undefined || crm.transport !== 'stdio') throw new Error('no stand-in');
      const carried = JSON.parse((crm.args ?? []).slice(2).join('')) as {
        reads: Record<string, { lang: string; name: string }[]>;
        writes: string[];
      };
      expect(carried.writes).toEqual(['contact_update']);
      expect(carried.reads['contact_list']?.map((record) => [record.lang, record.name])).toEqual([
        ['en', 'Misaki Sato'],
        ['ja', '佐藤 美咲'],
      ]);
      // The write is demo-only, as in every copy.
      expect(JSON.stringify(crm.args)).toContain(DEMO_SEND_RESULT.en);
    });

    it('carries the writes a seed records into the copy: a records stand-in that keeps them (ADR-0169)', async () => {
      const world = await make();
      const entry = world.entry('recorded');
      const base = seedOf();
      await seed(world, entry, {
        ...base,
        connectors: [
          {
            name: 'crm',
            reads: ['contact_list', 'contact_get', 'task_list'],
            writes: ['contact_update', 'task_create'],
            recorded: [{ write: 'task_create', kind: 'task', read: 'task_list' }],
          },
        ],
      });
      const guest = await world.newGuest();
      await world.templates.copyInto({
        entry,
        workspaceId: guest.workspaceId,
        guestUserId: guest.userId,
        limits: { maxTurns: 5, maxBudgetUsd: 0.2 },
        now: NOW,
      });
      const [crm] = await world.connectors(guest.workspaceId);
      if (crm === undefined || crm.transport !== 'stdio') throw new Error('no stand-in');
      const state = readRecordsServerState(crm);
      expect(state?.recorded).toEqual([{ write: 'task_create', kind: 'task', read: 'task_list' }]);
      expect(state?.writes).toEqual(['contact_update', 'task_create']);
      // The read the write answers with is offered with no sample record of its own.
      expect(state?.reads['task_list']).toEqual([]);
      expect(state?.written).toEqual([]);
    });

    it('makes each skill the definition names, assigns them to the agent, and a copy gets them', async () => {
      const world = await make();
      const entry = world.entry('skills');
      await seed(world, entry, withSkills(seedOf(), 'Price it.'));
      const id = (await world.templateId(entry)) ?? '';
      const skills = await world.skills(id);
      expect(skills.map((skill) => skill.name).sort()).toEqual(['cost-model', 'office-reader']);
      expect(await world.skillFiles(id, 'cost-model')).toEqual(costModelFiles('Price it.'));
      const [agent] = await world.agents(id);
      const idOf = (name: string) => skills.find((skill) => skill.name === name)?.id;
      const assigned = (await world.assignments(id, agent?.id ?? ''))?.skillIds ?? [];
      expect([...assigned].sort()).toEqual([idOf('cost-model'), idOf('office-reader')].sort());
      const guest = await world.newGuest();
      await world.templates.copyInto({
        entry,
        workspaceId: guest.workspaceId,
        guestUserId: guest.userId,
        limits: { maxTurns: null, maxBudgetUsd: null },
        now: NOW,
      });
      expect(await world.skillFiles(guest.workspaceId, 'cost-model')).toEqual(
        costModelFiles('Price it.'),
      );
      const [copied] = await world.agents(guest.workspaceId);
      expect(copied?.policy?.skills).toEqual({
        mode: 'allowlist',
        names: ['cost-model', 'office-reader'],
      });
    });

    it('replaces the skills when the seed changes, and removes them when it names none', async () => {
      const world = await make();
      const entry = world.entry('skills-changed');
      await seed(world, entry, withSkills(seedOf(), 'Price it.'));
      const id = (await world.templateId(entry)) ?? '';
      expect(await seed(world, entry, withSkills(seedOf(), 'Price it again.'))).toEqual({
        changed: true,
      });
      expect(await world.skillFiles(id, 'cost-model')).toEqual(costModelFiles('Price it again.'));
      expect(await seed(world, entry, seedOf())).toEqual({ changed: true });
      expect(await world.skills(id)).toEqual([]);
    });

    it('reports every template with its agent, its sample files and its record sets', async () => {
      const world = await make();
      const one = world.entry('report-one');
      const two = world.entry('report-two');
      await seed(world, one, seedOf());
      await seed(world, two, seedOf({ files: { 'deals/a.csv': 'a', 'deals/b.csv': 'b' } }));
      const reports = DemoTemplateReportsSchema.parse(await world.operations.report());
      const byEntry = new Map(reports.templates.map((report) => [report.entry, report]));
      expect(byEntry.get(one)).toEqual({
        entry: one,
        agent: 'sales-assistant',
        files: 1,
        recordSets: 2,
      });
      expect(byEntry.get(two)).toEqual({
        entry: two,
        agent: 'sales-assistant',
        files: 2,
        recordSets: 2,
      });
    });

    it("reports no agent for a template whose seed was never completed, and skips a workspace that is not the deployment's", async () => {
      const world = await make();
      const mine = world.entry('half');
      const squat = world.entry('squat-report');
      await world.seedTemplate(mine, {
        agent: { name: 'x', instructions: 'x', maxTurns: null, maxBudgetUsd: null },
        files: [],
        assign: [],
      });
      await world.seedTemplate(
        squat,
        {
          agent: { name: 'x', instructions: 'x', maxTurns: null, maxBudgetUsd: null },
          files: [],
          assign: [],
        },
        'person',
      );
      const entries = (await world.operations.report()).templates.map((report) => report.entry);
      expect(entries).toContain(mine);
      expect(entries).not.toContain(squat);
    });

    it("refuses a workspace that has the slug and is not the deployment's, and writes nothing in it", async () => {
      const world = await make();
      const entry = world.entry('squat');
      await world.seedTemplate(
        entry,
        {
          agent: { name: 'x', instructions: 'x', maxTurns: null, maxBudgetUsd: null },
          files: [],
          assign: [],
        },
        'person',
      );
      await expect(seed(world, entry, seedOf())).rejects.toMatchObject({
        code: 'demo_template_not_deployment_owned',
      });
      const id = (await world.templateId(entry)) ?? '';
      expect((await world.agents(id)).map((agent) => agent.name)).toEqual(['x']);
      expect(await world.paths(id)).toEqual([]);
    });

    describe('refuses a seed that does not hold together, before it writes anything', () => {
      const cases: readonly [string, (seed: DemoTemplateSeed) => DemoTemplateSeed][] = [
        [
          'names a skill it does not carry',
          (value) => ({ ...withSkills(value, 'Price it.'), skills: [] }),
        ],
        [
          'carries a skill the definition does not name',
          (value) => ({ ...value, skills: withSkills(value, 'Price it.').skills }),
        ],
        [
          'pins a skill revision',
          (value) => {
            const skilled = withSkills(value, 'Price it.');
            return {
              ...skilled,
              definition: {
                ...skilled.definition,
                resources: { ...skilled.definition.resources, skillRevisions: { 'cost-model': 1 } },
              },
            };
          },
        ],
        ['names a connector the seed does not declare', (value) => ({ ...value, connectors: [] })],
        [
          'has a record set for a connector it does not declare',
          (value) => ({
            ...value,
            records: value.records.map((set) => ({ ...set, connector: 'other' })),
          }),
        ],
        [
          'has a record set for a tool the connector does not read',
          (value) => ({
            ...value,
            records: value.records.map((set) => ({ ...set, tools: ['contact_update'] })),
          }),
        ],
        [
          'has more records for a connector than one stand-in can carry',
          (value) => ({
            ...value,
            records: value.records.map((set) => ({
              ...set,
              data: [{ text: 'x'.repeat(200_000) }],
            })),
          }),
        ],
        [
          'lists a sample file twice',
          (value) => ({ ...value, files: [...value.files, ...value.files] }),
        ],
        [
          'declares a connector twice',
          (value) => ({ ...value, connectors: [...value.connectors, ...value.connectors] }),
        ],
      ];
      it.each(cases)('a seed that %s', async (_name, change) => {
        const world = await make();
        const entry = world.entry('invalid');
        await expect(seed(world, entry, change(seedOf()))).rejects.toThrow(DemoSeedRefusal);
        await expect(seed(world, entry, change(seedOf()))).rejects.toMatchObject({
          code: 'demo_seed_invalid',
        });
        expect(await world.templateId(entry)).toBeNull();
      });
    });
  });
}

describeSeeding('the memory world', (sandbox) =>
  Promise.resolve(createMemoryTemplatesWorld(sandbox)),
);

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('template seeding over a real PostgreSQL', () => {
  let opened: Awaited<ReturnType<typeof openPostgresTemplatesWorld>>;
  beforeAll(async () => {
    opened = await openPostgresTemplatesWorld();
  }, 180_000);
  afterAll(async () => {
    await opened.close();
  });
  describeSeeding('the PostgreSQL world', (sandbox) => opened.world(sandbox));
});

describe('the seed the deploy sends for every live entry', () => {
  it.each(liveEntries().map((entry) => [entry.slug, entry] as const))(
    '%s: meets the platform rules (the files cover the grants, the connectors are declared, the records fit one stand-in)',
    (_slug, entry) => {
      expect(() => checkSeed(buildSeed(entry))).not.toThrow();
    },
  );
});
