/**
 * A repeat copy of a template that has changed since (issue #2407), and two entries that name the
 * same connector in one workspace: what the verification fill relies on to run every entry's
 * current demo in one workspace.
 */
import { canonicalCall } from '@indx-workspace/contracts/agents';
import type { DemoEntrySlug } from '@indx-workspace/contracts/demo';
import {
  DEMO_RECORD_SAMPLES,
  DemoTemplateSeedSchema,
  type DemoRecordedWrite,
  type DemoTemplateSeed,
} from '@indx-workspace/contracts/demo-operator';
import { describe, expect, it, vi } from 'vitest';

import type { AnyConnectorResource } from '../../integrations';
import { createDemoApprovedWrites } from '../records/approved-writes';
import { readRecordsServerState } from './records-server';
import {
  NO_LIMITS,
  NOW,
  copy,
  type DemoTemplatesWorld,
  type MakeDemoTemplatesWorld,
} from './templates.contract-world';

const encode = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/** What one version of a test template holds. */
export interface RefreshSeedSpec {
  readonly agent: string;
  readonly instructions: string;
  readonly skillBody: string;
  readonly files: Readonly<Record<string, string>>;
  readonly connector: {
    readonly name: string;
    readonly reads: readonly string[];
    readonly writes: readonly string[];
    readonly recorded?: readonly DemoRecordedWrite[];
  };
  /** The records each read tool answers with, one set per tool. */
  readonly records: Readonly<Record<string, readonly Record<string, string>[]>>;
}

/** A seed as the deployment's operator step sends it (K-1 definition, one skill, one connector). */
export function refreshSeed(spec: RefreshSeedSpec): DemoTemplateSeed {
  const { connector } = spec;
  return DemoTemplateSeedSchema.parse({
    definition: {
      apiVersion: 'agentworkspace.dev/v1',
      kind: 'AgentDefinition',
      agent: {
        name: spec.agent,
        instructions: spec.instructions,
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
        model: null,
        modelConnectionName: null,
        runtimeProfileName: null,
      },
      policy: {
        engine: 'claude-agent-sdk',
        tools: { base: 'claude_code_preset', permissionMode: 'default', autoApprove: [], deny: [] },
        skills: { mode: 'allowlist', names: ['guide'] },
        limits: { maxTurns: 12, maxBudgetUsd: 0.6 },
      },
      policySource: 'stored',
      resources: {
        files: [{ path: 'samples', access: 'read' }],
        skills: ['guide'],
        connectors: [connector.name],
      },
    },
    connectors: [
      {
        name: connector.name,
        reads: connector.reads,
        writes: connector.writes,
        ...(connector.recorded === undefined ? {} : { recorded: connector.recorded }),
      },
    ],
    skills: [
      {
        name: 'guide',
        files: [
          {
            path: 'SKILL.md',
            base64: encode(
              `---\nname: guide\ndescription: How to answer.\n---\n\n${spec.skillBody}\n`,
            ),
          },
        ],
      },
    ],
    files: Object.entries(spec.files).map(([path, text]) => ({ path, base64: encode(text) })),
    records: Object.entries(spec.records).map(([tool, data]) => ({
      connector: connector.name,
      resource: tool,
      lang: 'en',
      tools: [tool],
      data,
    })),
  });
}

export const FIRST: RefreshSeedSpec = {
  agent: 'refresh-agent',
  instructions: 'Answer from the samples.',
  skillBody: 'Be brief.',
  files: { 'samples/faq.md': 'Returns within 14 days.' },
  connector: { name: 'crm', reads: ['contact_list'], writes: ['send'] },
  records: { contact_list: [{ id: 'c1', name: 'Misaki Sato' }] },
};

/** The same template after a deploy changed every part of it. */
export const CHANGED: RefreshSeedSpec = {
  ...FIRST,
  instructions: 'Answer from the samples, and cite the file.',
  skillBody: 'Be brief and cite.',
  files: { 'samples/faq.md': 'Returns within 30 days.', 'samples/shipping.md': 'Ships in 2 days.' },
  connector: { name: 'crm', reads: ['contact_list', 'ticket_list'], writes: ['ticket_update'] },
  records: {
    contact_list: [{ id: 'c2', name: 'Ren Ito' }],
    ticket_list: [{ id: 't1', title: 'Late parcel' }],
  },
};

/** The read tools a stand-in answers and the write tools it offers, from its arguments. */
function standInToolsOf(connector: AnyConnectorResource | undefined) {
  const state = connector === undefined ? null : readRecordsServerState(connector);
  return state === null
    ? null
    : { reads: Object.keys(state.reads).sort(), writes: [...state.writes].sort(), state };
}

export function describeCopyRefresh(make: MakeDemoTemplatesWorld): void {
  describe('a repeat copy of a template that changed since (#2407)', () => {
    const seed = (world: DemoTemplatesWorld, entry: DemoEntrySlug, spec: RefreshSeedSpec) =>
      world.operations.seed({ entry, seed: refreshSeed(spec), now: NOW });
    const verify = (
      world: DemoTemplatesWorld,
      entry: DemoEntrySlug,
      owner: { workspaceId: string; userId: string },
    ) =>
      world.templates.copyIntoVerification({
        entry,
        workspaceId: owner.workspaceId,
        ownerUserId: owner.userId,
        limits: NO_LIMITS,
        now: NOW,
      });

    it('brings the copy to the template: instructions, skill files, sample files, stand-in tools and records, the same ids', async () => {
      const world = await make();
      const entry = world.entry('refresh');
      await seed(world, entry, FIRST);
      const owner = await world.newWorkspace();
      await verify(world, entry, owner);
      const [before] = await world.agents(owner.workspaceId);
      const [standInBefore] = await world.connectors(owner.workspaceId);
      const skillsBefore = await world.skills(owner.workspaceId);

      await seed(world, entry, CHANGED);
      await verify(world, entry, owner);

      const [agent, ...others] = await world.agents(owner.workspaceId);
      expect(others).toEqual([]);
      expect(agent?.id).toBe(before?.id);
      expect(agent?.instructions).toBe(CHANGED.instructions);
      expect(await world.skills(owner.workspaceId)).toEqual(skillsBefore);
      expect((await world.skillFiles(owner.workspaceId, 'guide'))?.['SKILL.md']).toContain(
        CHANGED.skillBody,
      );
      expect(await world.fileText(owner.workspaceId, 'samples/faq.md')).toBe(
        CHANGED.files['samples/faq.md'],
      );
      expect(await world.fileText(owner.workspaceId, 'samples/shipping.md')).toBe(
        CHANGED.files['samples/shipping.md'],
      );
      const [standIn, ...otherConnectors] = await world.connectors(owner.workspaceId);
      expect(otherConnectors).toEqual([]);
      expect(standIn?.id).toBe(standInBefore?.id);
      const tools = standInToolsOf(standIn);
      expect(tools?.reads).toEqual(['contact_list', 'ticket_list']);
      expect(tools?.writes).toEqual(['ticket_update']);
      expect(tools?.state.reads['contact_list']?.map((record) => record['id'])).toEqual(['c2']);
      const assigned = await world.assignments(owner.workspaceId, agent?.id ?? '');
      expect(assigned?.connectorIds).toEqual([standIn?.id]);
      expect(assigned?.skillIds).toEqual(skillsBefore.map((skill) => skill.id));
    });

    it('fails the copy, rather than run a stale stand-in, when the stand-in cannot be refreshed', async () => {
      const world = await make();
      const entry = world.entry('refresh-refused');
      await seed(world, entry, FIRST);
      const owner = await world.newWorkspace();
      await verify(world, entry, owner);
      await seed(world, entry, CHANGED);
      const stores = world.connectorStores;
      const forWorkspace = stores.forWorkspace.bind(stores);
      const spy = vi.spyOn(stores, 'forWorkspace').mockImplementation((workspaceId) => {
        const store = forWorkspace(workspaceId);
        return workspaceId === owner.workspaceId
          ? { ...store, update: () => Promise.resolve({ kind: 'not-found' as const }) }
          : store;
      });
      try {
        await expect(verify(world, entry, owner)).rejects.toThrow(
          /the demo stand-in crm was not refreshed: not-found/u,
        );
      } finally {
        spy.mockRestore();
      }
    });

    it("keeps a sample file an earlier copy left in a visitor's demo, and resets it in the verification workspace", async () => {
      const world = await make();
      const entry = world.entry('refresh-files');
      await seed(world, entry, FIRST);
      const guest = await world.newGuest();
      const owner = await world.newWorkspace();
      await copy(world, entry, guest);
      await verify(world, entry, owner);

      await seed(world, entry, CHANGED);
      await copy(world, entry, guest);
      await verify(world, entry, owner);

      expect(await world.fileText(guest.workspaceId, 'samples/faq.md')).toBe(
        FIRST.files['samples/faq.md'],
      );
      expect(await world.fileText(owner.workspaceId, 'samples/faq.md')).toBe(
        CHANGED.files['samples/faq.md'],
      );
      // A file the template gained is copied into both.
      for (const workspace of [guest, owner]) {
        expect(await world.fileText(workspace.workspaceId, 'samples/shipping.md')).toBe(
          CHANGED.files['samples/shipping.md'],
        );
      }
      // The rest of the visitor's copy follows the template too.
      const [agent] = await world.agents(guest.workspaceId);
      expect(agent?.instructions).toBe(CHANGED.instructions);
    });

    /** A template whose records stand-in keeps an approved calendar write (ADR-0169). */
    const CALENDAR: RefreshSeedSpec = {
      ...FIRST,
      connector: {
        name: 'calendar',
        reads: ['event_list'],
        writes: ['event_create'],
        recorded: [{ write: 'event_create', kind: 'calendar', read: 'event_list' }],
      },
      records: {},
    };

    /** Approve one calendar write in `workspaceId`, as the run API's keeper does. */
    const approveWrite = (world: DemoTemplatesWorld, workspaceId: string) =>
      createDemoApprovedWrites({
        connectors: world.connectorStores,
        keepsDemoWrites: () => Promise.resolve(true),
      }).keep({
        workspaceId,
        calls: [
          {
            canonicalCall: canonicalCall(
              'mcp__calendar__event_create',
              DEMO_RECORD_SAMPLES.calendar.en,
            ),
          },
        ],
      });

    /** How many approved writes the workspace's one stand-in keeps. */
    const writtenIn = async (world: DemoTemplatesWorld, workspaceId: string) => {
      const [standIn] = await world.connectors(workspaceId);
      // A stand-in that is no records server (a fake send) keeps nothing.
      return standInToolsOf(standIn)?.state.written.length ?? 0;
    };

    it("carries a visitor's approved writes across a refresh while the stand-in still records their write", async () => {
      const world = await make();
      const entry = world.entry('refresh-writes');
      await seed(world, entry, CALENDAR);
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      await approveWrite(world, guest.workspaceId);
      expect(await writtenIn(world, guest.workspaceId)).toBe(1);

      await copy(world, entry, guest);
      expect(await writtenIn(world, guest.workspaceId)).toBe(1);

      await seed(world, entry, { ...CALENDAR, instructions: 'Book rooms.' });
      await copy(world, entry, guest);
      expect(await writtenIn(world, guest.workspaceId)).toBe(1);

      // The stand-in changes (a new write) and still records event_create: the write is carried.
      await seed(world, entry, {
        ...CALENDAR,
        connector: { ...CALENDAR.connector, writes: ['event_create', 'event_cancel'] },
      });
      await copy(world, entry, guest);
      expect(await writtenIn(world, guest.workspaceId)).toBe(1);
      const [changed] = await world.connectors(guest.workspaceId);
      expect(standInToolsOf(changed)?.writes).toEqual(['event_cancel', 'event_create']);

      // A template that no longer records event_create has nothing to answer the kept call with.
      await seed(world, entry, {
        ...CALENDAR,
        connector: { ...CALENDAR.connector, recorded: [] },
      });
      await copy(world, entry, guest);
      expect(await writtenIn(world, guest.workspaceId)).toBe(0);
    });

    it("keeps a visitor's approved writes when the stand-in's code changed in a deploy", async () => {
      const world = await make();
      const entry = world.entry('refresh-writes-source');
      await seed(world, entry, CALENDAR);
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      await approveWrite(world, guest.workspaceId);
      const [current] = await world.connectors(guest.workspaceId);
      const args = current?.args ?? [];
      // An earlier release's stand-in: another source, the same carried state.
      const store = world.connectorStores.forWorkspace(guest.workspaceId);
      const aged = await store.update(current?.id ?? '', {
        args: [args[0] ?? '', '/* an earlier release */', ...args.slice(2)],
      });
      expect(aged.kind).toBe('updated');

      await copy(world, entry, guest);
      const [refreshed] = await world.connectors(guest.workspaceId);
      expect(refreshed?.args).toEqual(args);
      expect(await writtenIn(world, guest.workspaceId)).toBe(1);
    });

    it('copies again with an unchanged template without touching anything: no skill revision, the same stand-in, its kept writes', async () => {
      const world = await make();
      const entry = world.entry('refresh-no-churn');
      await seed(world, entry, CALENDAR);
      const guest = await world.newGuest();
      const owner = await world.newWorkspace();
      await copy(world, entry, guest);
      await verify(world, entry, owner);
      await approveWrite(world, guest.workspaceId);
      const before = await Promise.all(
        [guest, owner].map(async ({ workspaceId }) => world.connectors(workspaceId)),
      );

      await copy(world, entry, guest);
      await verify(world, entry, owner);

      for (const [at, { workspaceId }] of [guest, owner].entries()) {
        const [standIn, ...others] = await world.connectors(workspaceId);
        expect(others).toEqual([]);
        expect(standIn).toMatchObject({
          id: before[at]?.[0]?.id,
          args: before[at]?.[0]?.args,
          updatedAt: before[at]?.[0]?.updatedAt,
        });
        expect(await world.skillRevisions(workspaceId, 'guide')).toBe(0);
      }
      expect(await writtenIn(world, guest.workspaceId)).toBe(1);
    });

    it('never overwrites a connector that is no stand-in, under the entry-scoped name either', async () => {
      const world = await make();
      const entry = world.entry('refresh-foreign');
      await seed(world, entry, FIRST);
      const owner = await world.newWorkspace();
      const store = world.connectorStores.forWorkspace(owner.workspaceId);
      const by = { principalId: owner.principalId, userId: owner.userId };
      for (const name of ['crm', `crm-${entry}`]) {
        const made = await store.create(
          {
            name,
            transport: 'http',
            command: null,
            args: null,
            url: 'https://crm.example.test/mcp',
            authType: 'none',
            credential: null,
          },
          by,
        );
        expect(made.kind).toBe('created');
      }
      await expect(verify(world, entry, owner)).rejects.toThrow(
        new RegExp(`the connector crm-${entry} is not a demo stand-in`, 'u'),
      );
      for (const connector of await world.connectors(owner.workspaceId)) {
        expect(connector).toMatchObject({ url: 'https://crm.example.test/mcp' });
      }
    });

    it('refuses to publish files for a skill the workspace does not have', async () => {
      const world = await make();
      const owner = await world.newWorkspace();
      const published = await world.skillsDomain.publish(
        owner.workspaceId,
        { principalId: owner.principalId, userId: owner.userId },
        { name: 'missing', files: [{ path: 'SKILL.md', bytes: new TextEncoder().encode('x') }] },
      );
      expect(published).toEqual({ kind: 'refused', code: 'skill_not_found' });
    });

    it('clears the approved writes on every verification refill, so each real-model run starts from the template', async () => {
      const world = await make();
      const entry = world.entry('refresh-writes-verify');
      await seed(world, entry, CALENDAR);
      const owner = await world.newWorkspace();
      await verify(world, entry, owner);
      const [standIn] = await world.connectors(owner.workspaceId);
      await approveWrite(world, owner.workspaceId);
      expect(await writtenIn(world, owner.workspaceId)).toBe(1);

      // The same template: the refill keeps the stand-in and clears what the run approved.
      await verify(world, entry, owner);
      expect(await writtenIn(world, owner.workspaceId)).toBe(0);
      const [refilled, ...others] = await world.connectors(owner.workspaceId);
      expect(others).toEqual([]);
      expect(refilled?.id).toBe(standIn?.id);
      expect(refilled?.args).toEqual(standIn?.args);

      // A write approved after the refill is kept until the next one.
      await approveWrite(world, owner.workspaceId);
      expect(await writtenIn(world, owner.workspaceId)).toBe(1);
      await verify(world, entry, owner);
      expect(await writtenIn(world, owner.workspaceId)).toBe(0);
    });

    it('gives each of two entries that name the same connector its own stand-in, kept on a refill', async () => {
      const world = await make();
      const sales = world.entry('refresh-sales');
      const inquiry = world.entry('refresh-inquiry');
      await seed(world, sales, { ...FIRST, agent: 'sales' });
      await seed(world, inquiry, {
        ...CHANGED,
        agent: 'inquiry',
        connector: { name: 'crm', reads: ['interaction_list'], writes: [] },
        records: { interaction_list: [{ id: 'i1', subject: 'Return request' }] },
      });
      const owner = await world.newWorkspace();
      const fill = async () => {
        await verify(world, sales, owner);
        await verify(world, inquiry, owner);
      };
      await fill();
      const connectors = async () =>
        [...(await world.connectors(owner.workspaceId))].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      const first = await connectors();
      expect(first.map((connector) => connector.name)).toEqual(['crm', `crm-${inquiry}`]);
      const byAgent = new Map(
        (await world.agents(owner.workspaceId)).map((agent) => [agent.name, agent.id]),
      );
      const assignedOf = async (name: string) =>
        (await world.assignments(owner.workspaceId, byAgent.get(name) ?? ''))?.connectorIds;
      expect(await assignedOf('sales')).toEqual([first[0]?.id]);
      expect(await assignedOf('inquiry')).toEqual([first[1]?.id]);
      expect(standInToolsOf(first[0])?.reads).toEqual(['contact_list']);
      expect(standInToolsOf(first[1])?.reads).toEqual(['interaction_list']);

      await fill();
      expect((await connectors()).map((connector) => connector.id)).toEqual(
        first.map((connector) => connector.id),
      );
    });
  });
}
