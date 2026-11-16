/**
 * What every {@link DemoTemplates} must do, written against the port and run against a world built
 * on memory stores and against one built on PostgreSQL (`templates.test.ts`). A world is the
 * template workspaces and the visitors' demo workspaces behind the port, with the readers a test
 * needs to look at what a copy made.
 */
import { DEMO_SEND_RESULT, type DemoEntrySlug } from '@indx-workspace/contracts/demo';
import type { DemoSampleRecords } from '@indx-workspace/contracts/demo-operator';
import type { AgentResourceAssignments } from '@indx-workspace/contracts/agents';
import { describe, expect, it } from 'vitest';

import type { AgentRecord } from '../../agents';
import type { DirectoryRoot } from '../../identity';
import type { AnyConnectorResource, WorkspaceModelsStore } from '../../integrations';
import type { RuntimeProfileRecord, RuntimeProfileStoreProvider } from '../../execution';
import { grantsFor } from '../../identity';
import type { DemoTemplateOperations } from '../operator';
import type { DemoRunLimits, DemoSandbox, DemoTemplates } from './ports';
import { DEMO_MODEL_CONNECTION_NAME, DEMO_RUNTIME_PROFILE_NAME } from './template-copy';

/** One connector a template agent is given. */
export type SeedConnector =
  | { readonly kind: 'mcp'; readonly name: string }
  | { readonly kind: 'openapi-read'; readonly name: string }
  | { readonly kind: 'openapi-write'; readonly name: string }
  | { readonly kind: 'postgres'; readonly name: string }
  /** What the deployment's seed stores (`template-connector.ts`): read and write tools declared. */
  | {
      readonly kind: 'declared';
      readonly name: string;
      readonly reads: readonly string[];
      readonly writes: readonly string[];
    };

export interface TemplateSpec {
  readonly agent: {
    readonly name: string;
    readonly instructions: string;
    readonly unrestrictedNetwork?: boolean;
    readonly maxTurns: number | null;
    readonly maxBudgetUsd: number | null;
  };
  /** The files in the template workspace, by path. */
  readonly files: readonly { readonly path: string; readonly text: string }[];
  /** What the template agent is assigned: a folder or a file path in the template. */
  readonly assign: readonly { readonly path: string; readonly access: 'read' | 'read-write' }[];
  /** The connectors the template agent is assigned. */
  readonly connectors?: readonly SeedConnector[];
  /** The entry's sample record sets, kept in the template's reserved folder. */
  readonly records?: readonly DemoSampleRecords[];
  /** Tool rules on the template agent, written by connector name (`mcp__<name>__<tool>`). */
  readonly rules?: {
    readonly autoApprove?: readonly string[];
    readonly deny?: readonly string[];
  };
  /**
   * The skills the template agent is assigned, made in the template: one with `files` (path to
   * text) from them, one without as a built-in from the platform's release.
   */
  readonly skills?: readonly {
    readonly name: string;
    readonly files?: Readonly<Record<string, string>>;
  }[];
  /** `compiled` leaves the template agent with no stored policy; by default it has one. */
  readonly policy?: 'stored' | 'compiled';
}

export interface DemoTemplatesWorld {
  readonly templates: DemoTemplates;
  /** What the deployment's operator step calls to fill the templates (`seed.ts`). */
  readonly operations: DemoTemplateOperations;
  /** The id of the workspace with the entry's template slug, or `null`. */
  templateId(entry: DemoEntrySlug): Promise<string | null>;
  /** The directory the visitors' demo workspaces are bound in. */
  readonly directory: DirectoryRoot;
  /** An entry slug no other test in this database uses. */
  entry(local: string): DemoEntrySlug;
  /**
   * Fill the entry's template workspace. `madeBy` is who created the workspace: the deployment
   * (a template-owner account) or a person (an ordinary address, as `POST /api/workspaces` would).
   */
  seedTemplate(
    entry: DemoEntrySlug,
    spec: TemplateSpec,
    madeBy?: 'deployment' | 'person',
  ): Promise<void>;
  /** Make the agent's per-run limits as wide as a copy that stopped before its caps left them. */
  uncap(workspaceId: string, agentId: string): Promise<void>;
  /** A new demo workspace with its guest, made by the email-link binder. */
  newGuest(): Promise<{
    readonly workspaceId: string;
    readonly userId: string;
    principalId: string;
  }>;
  /** A new ordinary workspace a person made, with that person as its one Owner. */
  newWorkspace(): Promise<{
    readonly workspaceId: string;
    readonly userId: string;
    readonly principalId: string;
  }>;
  agents(workspaceId: string): Promise<readonly AgentRecord[]>;
  assignments(workspaceId: string, agentId: string): Promise<AgentResourceAssignments | null>;
  /** The text of the file at `path`, or `null` when the workspace has none. */
  fileText(workspaceId: string, path: string): Promise<string | null>;
  /** The paths of every ready file and folder row of the workspace. */
  paths(workspaceId: string): Promise<readonly string[]>;
  /** The path of the row with `fileId` in the workspace, or `null`. */
  pathOf(workspaceId: string, fileId: string): Promise<string | null>;
  connectors(workspaceId: string): Promise<readonly AnyConnectorResource[]>;
  /** The workspace's model connections store, as the models domain hands it out. */
  models(workspaceId: string): WorkspaceModelsStore;
  /** The workspace's runtime profiles. */
  profiles(workspaceId: string): Promise<readonly RuntimeProfileRecord[]>;
  /** The workspace's runtime profile store, to change a profile as a person with access might. */
  profileStore(workspaceId: string): ReturnType<RuntimeProfileStoreProvider['forWorkspace']>;
  /** Take the agent's runtime profile away, as a first copy that stopped early leaves it. */
  detachProfile(workspaceId: string, agentId: string): Promise<void>;
  /** The principals granted to run the agent. */
  granted(workspaceId: string, agentId: string): Promise<readonly string[] | null>;
  /** The workspace's skills, as the skills domain lists them. */
  skills(workspaceId: string): Promise<readonly { readonly id: string; readonly name: string }[]>;
  /** The text of each file of the skill `name`, by path, or `null` when there is no such skill. */
  skillFiles(workspaceId: string, name: string): Promise<Readonly<Record<string, string>> | null>;
}

const SPEC: TemplateSpec = {
  agent: {
    name: 'sales-helper',
    instructions: 'You help a visitor with the sample deals.',
    maxTurns: 12,
    maxBudgetUsd: 0.6,
  },
  files: [
    { path: 'deals/q1.csv', text: 'id,amount\n1,100\n' },
    { path: 'deals/notes/a.txt', text: 'sample note' },
    { path: 'private/secrets.txt', text: 'not for the demo' },
  ],
  assign: [{ path: 'deals', access: 'read' }],
};

/** The demo key a world gives its provisioner unless a test says otherwise. */
export const TEST_DEMO_API_KEY = 'sk-ant-demo-key-for-tests-0123456789abcdef';

const NO_LIMITS: DemoRunLimits = { maxTurns: null, maxBudgetUsd: null };
const NOW = new Date('2026-11-16T09:00:00.000Z');

export function describeDemoTemplatesConformance(
  label: string,
  make: (sandbox?: Partial<DemoSandbox>) => Promise<DemoTemplatesWorld>,
): void {
  describe(`DemoTemplates: ${label}`, () => {
    async function copy(
      world: DemoTemplatesWorld,
      entry: DemoEntrySlug,
      guest: { workspaceId: string; userId: string },
      limits: DemoRunLimits = NO_LIMITS,
    ): Promise<void> {
      await world.templates.copyInto({
        entry,
        workspaceId: guest.workspaceId,
        guestUserId: guest.userId,
        limits,
        now: NOW,
      });
    }

    it('says an entry has a template only once its workspace holds an agent', async () => {
      const world = await make();
      const entry = world.entry('exists');
      expect(await world.templates.exists(entry)).toBe(false);
      await world.seedTemplate(entry, SPEC);
      expect(await world.templates.exists(entry)).toBe(true);
      expect(await world.templates.exists(world.entry('other'))).toBe(false);
    });

    it('copies the agent into the visitor workspace and grants the guest, and only the guest', async () => {
      const world = await make();
      const entry = world.entry('agent');
      await world.seedTemplate(entry, SPEC);
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      const [agent, ...rest] = await world.agents(guest.workspaceId);
      expect(rest).toEqual([]);
      expect(agent).toMatchObject({
        name: SPEC.agent.name,
        instructions: SPEC.agent.instructions,
        workspaceId: guest.workspaceId,
        modelConnectionId: null,
      });
      expect(await world.granted(guest.workspaceId, agent?.id ?? '')).toEqual([guest.principalId]);
    });

    it('copies the sample files the agent reads, at the same paths, and nothing else', async () => {
      const world = await make();
      const entry = world.entry('files');
      await world.seedTemplate(entry, SPEC);
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      expect(await world.fileText(guest.workspaceId, 'deals/q1.csv')).toBe('id,amount\n1,100\n');
      expect(await world.fileText(guest.workspaceId, 'deals/notes/a.txt')).toBe('sample note');
      expect(await world.fileText(guest.workspaceId, 'private/secrets.txt')).toBeNull();
      const agent = (await world.agents(guest.workspaceId))[0];
      const assigned = await world.assignments(guest.workspaceId, agent?.id ?? '');
      const paths = await Promise.all(
        (assigned?.files ?? []).map((grant) => world.pathOf(guest.workspaceId, grant.fileId)),
      );
      expect(paths).toEqual(['deals']);
      expect(assigned?.files.map((grant) => grant.access)).toEqual(['read']);
    });

    it("copies the template agent's skills into the visitor workspace and assigns them to the copy", async () => {
      const world = await make();
      const entry = world.entry('skills');
      const costModel = {
        'SKILL.md': '---\nname: cost-model\ndescription: Prices a part.\n---\n\nPrice it.\n',
        'scripts/estimate.mjs': 'export const estimate = () => 1;\n',
      };
      await world.seedTemplate(entry, {
        ...SPEC,
        skills: [{ name: 'cost-model', files: costModel }, { name: 'office-reader' }],
      });
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      const visitorSkills = await world.skills(guest.workspaceId);
      expect(visitorSkills.map((skill) => skill.name).sort()).toEqual([
        'cost-model',
        'office-reader',
      ]);
      expect(await world.skillFiles(guest.workspaceId, 'cost-model')).toEqual(costModel);
      // The built-in is the platform's own release, the same files the template holds.
      expect(await world.skillFiles(guest.workspaceId, 'office-reader')).toEqual(
        await world.skillFiles((await world.templateId(entry)) ?? '', 'office-reader'),
      );
      const [agent] = await world.agents(guest.workspaceId);
      const assigned = await world.assignments(guest.workspaceId, agent?.id ?? '');
      const idOf = (name: string) => visitorSkills.find((skill) => skill.name === name)?.id;
      // The definition resolves each skill to the visitor's own row, never the template's.
      expect([...(assigned?.skillIds ?? [])].sort()).toEqual(
        [idOf('cost-model'), idOf('office-reader')].sort(),
      );
      const policy = agent?.policy;
      if (policy === undefined || policy === null) throw new Error('the copy has no policy');
      expect(policy.skills).toEqual({ mode: 'allowlist', names: ['cost-model', 'office-reader'] });
      // A second copy finds the skills and makes none again.
      await copy(world, entry, guest);
      expect(await world.skills(guest.workspaceId)).toEqual(visitorSkills);
    });

    it('allows the skills of a template agent whose policy is compiled, as a run of it would', async () => {
      const world = await make();
      const entry = world.entry('skills-compiled');
      await world.seedTemplate(entry, {
        ...SPEC,
        policy: 'compiled',
        skills: [{ name: 'keigo-reply', files: { 'SKILL.md': '---\nname: keigo-reply\n---\n' } }],
      });
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      const [agent] = await world.agents(guest.workspaceId);
      expect(agent?.policy?.skills).toEqual({ mode: 'allowlist', names: ['keigo-reply'] });
    });

    it('leaves a copy of a template without skills as it was: no skill made, none assigned', async () => {
      const world = await make();
      const entry = world.entry('no-skills');
      await world.seedTemplate(entry, SPEC);
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      expect(await world.skills(guest.workspaceId)).toEqual([]);
      const [agent] = await world.agents(guest.workspaceId);
      expect((await world.assignments(guest.workspaceId, agent?.id ?? ''))?.skillIds).toEqual([]);
      expect(agent?.policy?.skills).toEqual({ mode: 'allowlist', names: [] });
    });

    it('never gives the copy internet: unrestrictedNetwork is off whatever the template had', async () => {
      const world = await make();
      const entry = world.entry('net');
      await world.seedTemplate(entry, {
        ...SPEC,
        agent: { ...SPEC.agent, unrestrictedNetwork: true },
      });
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      const agent = (await world.agents(guest.workspaceId))[0];
      expect(agent?.permissions.unrestrictedNetwork).toBe(false);
    });

    it.each([
      { template: [12, 0.6], limit: [5, 0.2], copied: [5, 0.2] },
      { template: [12, 0.6], limit: [30, 3], copied: [12, 0.6] },
      { template: [12, 0.6], limit: [null, null], copied: [12, 0.6] },
      { template: [null, null], limit: [8, 0.5], copied: [8, 0.5] },
      { template: [null, null], limit: [null, null], copied: [null, null] },
    ] as const)(
      "clamps the copy's per-run limits $template by $limit to $copied",
      async ({ template, limit, copied }) => {
        const world = await make();
        const entry = world.entry('limits');
        await world.seedTemplate(entry, {
          ...SPEC,
          agent: { ...SPEC.agent, maxTurns: template[0], maxBudgetUsd: template[1] },
        });
        const guest = await world.newGuest();
        await copy(world, entry, guest, { maxTurns: limit[0], maxBudgetUsd: limit[1] });
        const agent = (await world.agents(guest.workspaceId))[0];
        expect(agent?.policy?.limits).toEqual({ maxTurns: copied[0], maxBudgetUsd: copied[1] });
      },
    );

    it('copies once: a second copy of the entry changes nothing', async () => {
      const world = await make();
      const entry = world.entry('twice');
      await world.seedTemplate(entry, { ...SPEC, connectors: [{ kind: 'mcp', name: 'mailer' }] });
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      const before = await world.agents(guest.workspaceId);
      const pathsBefore = await world.paths(guest.workspaceId);
      const connectorsBefore = await world.connectors(guest.workspaceId);
      await copy(world, entry, guest);
      expect((await world.agents(guest.workspaceId)).map((a) => a.id)).toEqual(
        before.map((a) => a.id),
      );
      expect(await world.paths(guest.workspaceId)).toEqual(pathsBefore);
      expect((await world.connectors(guest.workspaceId)).map((c) => c.id)).toEqual(
        connectorsBefore.map((c) => c.id),
      );
    });

    it('adds a second entry to the same workspace and keeps the first', async () => {
      const world = await make();
      const first = world.entry('first');
      const second = world.entry('second');
      await world.seedTemplate(first, SPEC);
      await world.seedTemplate(second, {
        ...SPEC,
        agent: { ...SPEC.agent, name: 'ops-helper' },
        files: [{ path: 'tickets/t1.txt', text: 'sample ticket' }],
        assign: [{ path: 'tickets', access: 'read' }],
      });
      const guest = await world.newGuest();
      await copy(world, first, guest);
      await copy(world, second, guest);
      const names = (await world.agents(guest.workspaceId)).map((agent) => agent.name).sort();
      expect(names).toEqual(['ops-helper', 'sales-helper']);
      expect(await world.fileText(guest.workspaceId, 'deals/q1.csv')).not.toBeNull();
      expect(await world.fileText(guest.workspaceId, 'tickets/t1.txt')).toBe('sample ticket');
      for (const agent of await world.agents(guest.workspaceId)) {
        expect(await world.granted(guest.workspaceId, agent.id)).toEqual([guest.principalId]);
      }
    });

    it('adds the files of a second entry that shares a folder beside the first, keeping the first on a clash', async () => {
      const world = await make();
      const first = world.entry('shared-one');
      const second = world.entry('shared-two');
      const folder = { path: 'manuals', access: 'read' } as const;
      await world.seedTemplate(first, {
        ...SPEC,
        files: [
          { path: 'manuals/a.md', text: 'first a' },
          { path: 'manuals/same.md', text: 'first same' },
        ],
        assign: [folder],
      });
      await world.seedTemplate(second, {
        ...SPEC,
        agent: { ...SPEC.agent, name: 'ops-helper' },
        files: [
          { path: 'manuals/b.md', text: 'second b' },
          { path: 'manuals/same.md', text: 'second same' },
        ],
        assign: [folder],
      });
      const guest = await world.newGuest();
      await copy(world, first, guest);
      await copy(world, second, guest);
      expect(await world.fileText(guest.workspaceId, 'manuals/a.md')).toBe('first a');
      expect(await world.fileText(guest.workspaceId, 'manuals/b.md')).toBe('second b');
      expect(await world.fileText(guest.workspaceId, 'manuals/same.md')).toBe('first same');
    });

    it("keeps one visitor's copy apart from another's and from the template", async () => {
      const world = await make();
      const entry = world.entry('apart');
      await world.seedTemplate(entry, SPEC);
      const one = await world.newGuest();
      const other = await world.newGuest();
      await copy(world, entry, one);
      expect(await world.agents(other.workspaceId)).toEqual([]);
      expect(await world.paths(other.workspaceId)).toEqual([]);
    });

    it('replaces a tool that could send or write with a stand-in under the same name', async () => {
      const world = await make();
      const entry = world.entry('fakes');
      await world.seedTemplate(entry, {
        ...SPEC,
        connectors: [
          { kind: 'mcp', name: 'mailer' },
          { kind: 'openapi-write', name: 'tracker' },
        ],
      });
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      const copied = await world.connectors(guest.workspaceId);
      expect(copied.map((connector) => connector.name).sort()).toEqual(['mailer', 'tracker']);
      for (const connector of copied) {
        // A stand-in is a local process: no address, no secret, no connector row of the template.
        expect(connector).toMatchObject({
          transport: 'stdio',
          command: 'node',
          url: null,
          authType: 'none',
          hasCredential: false,
        });
        expect(connector.kind).toBeUndefined();
        expect((connector as { args: readonly string[] }).args.join(' ')).toContain(
          DEMO_SEND_RESULT.en,
        );
      }
      const tracker = copied.find((connector) => connector.name === 'tracker');
      // The openapi tool's write operation is the stand-in's tool; its read is not carried.
      expect((tracker as { args: readonly string[] }).args.slice(2)).toEqual(['createPet']);
      const agent = (await world.agents(guest.workspaceId))[0];
      const assigned = await world.assignments(guest.workspaceId, agent?.id ?? '');
      expect([...(assigned?.connectorIds ?? [])].sort()).toEqual(copied.map((c) => c.id).sort());
    });

    it("points the template's tool rules at the stand-in, so its approval and deny rules still apply", async () => {
      const world = await make();
      const entry = world.entry('rules');
      await world.seedTemplate(entry, {
        ...SPEC,
        connectors: [{ kind: 'mcp', name: 'mailer' }],
        rules: { autoApprove: ['mcp__mailer__draft'], deny: ['mcp__mailer__delete_all'] },
      });
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      const standIn = (await world.connectors(guest.workspaceId)).find((c) => c.name === 'mailer');
      if (standIn === undefined || standIn.transport !== 'stdio') throw new Error('no stand-in');
      // The stand-in offers the tools the rules name, so they match a tool that exists.
      expect([...(standIn.args ?? []).slice(2)].sort()).toEqual(['delete_all', 'draft']);
      const policy = (await world.agents(guest.workspaceId))[0]?.policy;
      if (policy === undefined || policy === null || !('tools' in policy)) {
        throw new Error('the copy has no tool policy');
      }
      expect(policy.tools.autoApprove).toContain(`mcp__connector-${standIn.id}__draft`);
      expect(policy.tools.deny).toContain(`mcp__connector-${standIn.id}__delete_all`);
      // Every rule on a connector names one of this visitor's own connectors.
      const ownIds = new Set((await world.connectors(guest.workspaceId)).map((c) => c.id));
      for (const rule of [...policy.tools.autoApprove, ...policy.tools.deny]) {
        const id = /^mcp__connector-(.+?)__/u.exec(rule)?.[1];
        if (id !== undefined) expect(ownIds.has(id)).toBe(true);
      }
    });

    it("leaves out a connector that only reads, and carries none of the template's connectors", async () => {
      const world = await make();
      const entry = world.entry('readers');
      await world.seedTemplate(entry, {
        ...SPEC,
        connectors: [
          { kind: 'openapi-read', name: 'catalogue' },
          { kind: 'postgres', name: 'warehouse' },
        ],
      });
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      expect(await world.connectors(guest.workspaceId)).toEqual([]);
      const agent = (await world.agents(guest.workspaceId))[0];
      expect((await world.assignments(guest.workspaceId, agent?.id ?? ''))?.connectorIds).toEqual(
        [],
      );
    });

    it("serves no template a person created: a workspace with the slug is not the deployment's", async () => {
      const world = await make();
      const entry = world.entry('squat');
      await world.seedTemplate(entry, SPEC, 'person');
      expect(await world.templates.exists(entry)).toBe(false);
      const guest = await world.newGuest();
      await expect(copy(world, entry, guest)).rejects.toThrow(/no demo template/u);
      expect(await world.agents(guest.workspaceId)).toEqual([]);
      expect(await world.paths(guest.workspaceId)).toEqual([]);
    });

    it('caps an agent an earlier copy left uncapped, and changes nothing else', async () => {
      const world = await make();
      const entry = world.entry('recap');
      await world.seedTemplate(entry, SPEC);
      const guest = await world.newGuest();
      await copy(world, entry, guest, { maxTurns: 5, maxBudgetUsd: 0.2 });
      const [agent] = await world.agents(guest.workspaceId);
      await world.uncap(guest.workspaceId, agent?.id ?? '');
      expect((await world.agents(guest.workspaceId))[0]?.policy?.limits).toEqual({
        maxTurns: null,
        maxBudgetUsd: null,
      });
      await copy(world, entry, guest, { maxTurns: 5, maxBudgetUsd: 0.2 });
      const agents = await world.agents(guest.workspaceId);
      expect(agents.map((a) => a.id)).toEqual([agent?.id]);
      expect(agents[0]?.policy?.limits).toEqual({ maxTurns: 5, maxBudgetUsd: 0.2 });
    });

    it('fails, and copies nothing, for an entry with no template', async () => {
      const world = await make();
      const guest = await world.newGuest();
      await expect(copy(world, world.entry('missing'), guest)).rejects.toThrow(/no demo template/u);
      expect(await world.agents(guest.workspaceId)).toEqual([]);
    });

    describe('a copy into the verification workspace', () => {
      const verify = (
        world: DemoTemplatesWorld,
        entry: DemoEntrySlug,
        owner: { workspaceId: string; userId: string },
        limits: DemoRunLimits = NO_LIMITS,
      ) =>
        world.templates.copyIntoVerification({
          entry,
          workspaceId: owner.workspaceId,
          ownerUserId: owner.userId,
          limits,
          now: NOW,
        });

      it("is a visitor's copy made for the Owner: stand-ins, no-internet sandbox, the demo key, the caps", async () => {
        const world = await make();
        const entry = world.entry('verify');
        await world.seedTemplate(entry, {
          ...SPEC,
          connectors: [{ kind: 'declared', name: 'erp', reads: [], writes: ['createQuote'] }],
        });
        const owner = await world.newWorkspace();
        await verify(world, entry, owner, { maxTurns: 5, maxBudgetUsd: 0.2 });
        const [agent, ...rest] = await world.agents(owner.workspaceId);
        expect(rest).toEqual([]);
        expect(agent).toMatchObject({ name: SPEC.agent.name, modelConnectionId: null });
        expect(agent?.policy?.limits).toEqual({ maxTurns: 5, maxBudgetUsd: 0.2 });
        expect(await world.granted(owner.workspaceId, agent?.id ?? '')).toEqual([
          owner.principalId,
        ]);
        const [profile, ...otherProfiles] = await world.profiles(owner.workspaceId);
        expect(otherProfiles).toEqual([]);
        expect(profile).toMatchObject({ name: DEMO_RUNTIME_PROFILE_NAME, networkPolicy: 'none' });
        expect(agent?.runtimeProfileId).toBe(profile?.id);
        const [connection] = await world.models(owner.workspaceId).list();
        expect(connection).toMatchObject({
          name: DEMO_MODEL_CONNECTION_NAME,
          provider: 'anthropic',
        });
        const [erp] = await world.connectors(owner.workspaceId);
        expect(erp).toMatchObject({ name: 'erp', transport: 'stdio', url: null });
        expect(await world.fileText(owner.workspaceId, 'deals/q1.csv')).toBe('id,amount\n1,100\n');
        expect(await world.fileText(owner.workspaceId, 'private/secrets.txt')).toBeNull();
      });

      it('is made only for an Owner: a guest, or a member who is not one, gets nothing', async () => {
        const world = await make();
        const entry = world.entry('verify-guest');
        await world.seedTemplate(entry, SPEC);
        const guest = await world.newGuest();
        await expect(verify(world, entry, guest)).rejects.toThrow(/no owner membership/u);
        expect(await world.agents(guest.workspaceId)).toEqual([]);
      });
    });

    describe('the sandbox and the model of a copy', () => {
      it('gives the workspace ONE sandbox profile with no network, and the agent runs in it', async () => {
        const world = await make();
        const entry = world.entry('sandbox');
        await world.seedTemplate(entry, SPEC);
        const guest = await world.newGuest();
        await copy(world, entry, guest);
        const profiles = await world.profiles(guest.workspaceId);
        expect(profiles).toHaveLength(1);
        expect(profiles[0]).toMatchObject({
          name: DEMO_RUNTIME_PROFILE_NAME,
          driver: 'docker',
          networkPolicy: 'none',
          allowedDomains: null,
          runtimeConnectionId: null,
        });
        const [agent] = await world.agents(guest.workspaceId);
        expect(agent?.runtimeProfileId).toBe(profiles[0]?.id);
      });

      it('makes the profile once however often the workspace is copied into, across entries too', async () => {
        const world = await make();
        const first = world.entry('profile-one');
        const second = world.entry('profile-two');
        await world.seedTemplate(first, SPEC);
        await world.seedTemplate(second, {
          ...SPEC,
          agent: { ...SPEC.agent, name: 'ops-helper' },
        });
        const guest = await world.newGuest();
        await copy(world, first, guest);
        await copy(world, first, guest);
        await copy(world, second, guest);
        const profiles = await world.profiles(guest.workspaceId);
        expect(profiles).toHaveLength(1);
        for (const agent of await world.agents(guest.workspaceId)) {
          expect(agent.runtimeProfileId).toBe(profiles[0]?.id);
        }
      });

      it('sets a profile that is not closed back to none, and attaches it to an agent a first copy left bare', async () => {
        const world = await make();
        const entry = world.entry('reset');
        await world.seedTemplate(entry, SPEC);
        const guest = await world.newGuest();
        await copy(world, entry, guest);
        const [profile] = await world.profiles(guest.workspaceId);
        await world.profileStore(guest.workspaceId).update(profile?.id ?? '', {
          networkPolicy: 'open',
          allowedDomains: ['example.test'],
        });
        const [agent] = await world.agents(guest.workspaceId);
        await world.detachProfile(guest.workspaceId, agent?.id ?? '');
        await copy(world, entry, guest);
        const [after] = await world.profiles(guest.workspaceId);
        expect(after).toMatchObject({ networkPolicy: 'none', allowedDomains: null });
        expect((await world.agents(guest.workspaceId))[0]?.runtimeProfileId).toBe(after?.id);
      });

      it('has no profile when the deployment names no runtime driver, so a run cannot start', async () => {
        const world = await make({ runtimeDriver: null });
        const entry = world.entry('no-driver');
        await world.seedTemplate(entry, SPEC);
        const guest = await world.newGuest();
        await copy(world, entry, guest);
        expect(await world.profiles(guest.workspaceId)).toEqual([]);
        expect((await world.agents(guest.workspaceId))[0]?.runtimeProfileId).toBeNull();
      });

      it('gives the workspace a default Anthropic connection holding the deployment key, once', async () => {
        const world = await make();
        const entry = world.entry('model');
        await world.seedTemplate(entry, SPEC);
        const guest = await world.newGuest();
        await copy(world, entry, guest);
        await copy(world, entry, guest);
        const store = world.models(guest.workspaceId);
        const connections = await store.list();
        expect(connections).toHaveLength(1);
        expect(connections[0]).toMatchObject({
          name: DEMO_MODEL_CONNECTION_NAME,
          provider: 'anthropic',
        });
        // The key is stored (a run resolves it on the server), and is the deployment's.
        expect((await store.resolve(connections[0]?.id ?? ''))?.credential).toBe(TEST_DEMO_API_KEY);
        // The agent names no connection: it runs on the workspace's `default`.
        expect((await world.agents(guest.workspaceId))[0]?.modelConnectionId).toBeNull();
      });

      it('shows the key nowhere a guest can read: not in the connection, the agent, the connectors or the profile', async () => {
        const world = await make();
        const entry = world.entry('hidden');
        await world.seedTemplate(entry, {
          ...SPEC,
          connectors: [{ kind: 'mcp', name: 'mailer' }],
        });
        const guest = await world.newGuest();
        await copy(world, entry, guest);
        const everything = JSON.stringify([
          await world.models(guest.workspaceId).list(),
          await world.agents(guest.workspaceId),
          await world.connectors(guest.workspaceId),
          await world.profiles(guest.workspaceId),
        ]);
        expect(everything).not.toContain(TEST_DEMO_API_KEY);
        expect(everything).not.toContain('sk-ant');
      });

      it.each(['model-connections', 'secrets', 'runtime-profiles', 'runtimes'] as const)(
        'gives the guest role no grant on %s, so it cannot read the connection, the secret or the profile',
        (resource) => {
          expect(grantsFor('guest', resource)).toEqual({
            read: 'none',
            write: 'none',
            run: 'none',
          });
        },
      );

      it('makes no connection when the deployment has no key, and still the sandbox', async () => {
        const world = await make({ anthropicApiKey: null });
        const entry = world.entry('no-key');
        await world.seedTemplate(entry, SPEC);
        const guest = await world.newGuest();
        await copy(world, entry, guest);
        expect(await world.models(guest.workspaceId).list()).toEqual([]);
        expect(await world.profiles(guest.workspaceId)).toHaveLength(1);
      });

      it('makes nothing of the sandbox or the model for an entry that has no template', async () => {
        const world = await make();
        const guest = await world.newGuest();
        await expect(copy(world, world.entry('absent'), guest)).rejects.toThrow(
          /no demo template/u,
        );
        expect(await world.profiles(guest.workspaceId)).toEqual([]);
        expect(await world.models(guest.workspaceId).list()).toEqual([]);
      });
    });

    describe('the records of a declared connector', () => {
      const RECORDS: readonly DemoSampleRecords[] = [
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
      ];
      const CRM = {
        kind: 'declared',
        name: 'crm',
        reads: ['contact_list', 'contact_get'],
        writes: ['contact_update'],
      } as const;

      it('becomes a records stand-in: its read tools answer from the records, its write tool is demo-only', async () => {
        const world = await make();
        const entry = world.entry('records');
        await world.seedTemplate(entry, { ...SPEC, connectors: [CRM], records: RECORDS });
        const guest = await world.newGuest();
        await copy(world, entry, guest);
        const [crm, ...rest] = await world.connectors(guest.workspaceId);
        expect(rest).toEqual([]);
        if (crm === undefined || crm.transport !== 'stdio') throw new Error('no records stand-in');
        expect(crm).toMatchObject({
          name: 'crm',
          command: 'node',
          url: null,
          hasCredential: false,
        });
        const source = crm.args?.[1] ?? '';
        expect(source).toContain('demo-records');
        // The records ride in the arguments after the source: both languages.
        const carried = (crm.args ?? []).slice(2).join('');
        expect(carried).toContain('Misaki Sato');
        expect(carried).toContain('佐藤 美咲');
        expect(JSON.parse(carried)).toMatchObject({
          reads: { contact_list: [{ lang: 'en' }, { lang: 'ja' }], contact_get: [{}, {}] },
          writes: ['contact_update'],
        });
      });

      it("carries nothing of the template's reserved folder: no records file, no digest, as a sample file", async () => {
        const world = await make();
        const entry = world.entry('reserved');
        await world.seedTemplate(entry, { ...SPEC, connectors: [CRM], records: RECORDS });
        const guest = await world.newGuest();
        await copy(world, entry, guest);
        const paths = await world.paths(guest.workspaceId);
        expect(paths.filter((path) => path.startsWith('demo-template'))).toEqual([]);
      });

      it('leaves out the reads when the seed has no records for them, keeping the writes demo-only', async () => {
        const world = await make();
        const entry = world.entry('no-records');
        await world.seedTemplate(entry, { ...SPEC, connectors: [CRM] });
        const guest = await world.newGuest();
        await copy(world, entry, guest);
        const [crm] = await world.connectors(guest.workspaceId);
        if (crm === undefined || crm.transport !== 'stdio') throw new Error('no stand-in');
        expect(crm.args?.slice(2)).toEqual(['contact_update']);
      });

      it('leaves out a declared connector that only reads when it has no records', async () => {
        const world = await make();
        const entry = world.entry('reader-only');
        await world.seedTemplate(entry, {
          ...SPEC,
          connectors: [{ kind: 'declared', name: 'qms', reads: ['defect_list'], writes: [] }],
        });
        const guest = await world.newGuest();
        await copy(world, entry, guest);
        expect(await world.connectors(guest.workspaceId)).toEqual([]);
      });

      it('answers a read tool that has records only from them: a tool with no set is not offered as a read', async () => {
        const world = await make();
        const entry = world.entry('partial');
        await world.seedTemplate(entry, {
          ...SPEC,
          connectors: [{ ...CRM, reads: ['contact_list', 'deal_list'] }],
          records: RECORDS,
        });
        const guest = await world.newGuest();
        await copy(world, entry, guest);
        const [crm] = await world.connectors(guest.workspaceId);
        if (crm === undefined || crm.transport !== 'stdio') throw new Error('no stand-in');
        const carried = JSON.parse((crm.args ?? []).slice(2).join('')) as {
          reads: Record<string, unknown>;
        };
        expect(Object.keys(carried.reads)).toEqual(['contact_list']);
      });
    });
  });
}
