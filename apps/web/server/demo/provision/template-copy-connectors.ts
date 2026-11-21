/**
 * The connectors of a template agent's copy, by {@link planDemoConnector}: a reader is left out, a
 * tool that could send or write outside is a stand-in (`fake-send-server.ts`, or `records-server.ts`
 * where the seed declared the connector and the template holds sample records for its reads).
 *
 * A stand-in an earlier copy made is found by name and brought to what the template makes now: its
 * command and arguments are replaced when they differ. In a visitor's demo the approved writes it
 * keeps (ADR-0169) are carried over while the stand-in still records their write; in the
 * verification workspace every repeat copy clears them, so each real-model run starts from the
 * template's records (ADR-0171 D1). A stand-in belongs to one entry: when the name is held by a
 * stand-in another entry's agent is assigned, or by a connector that is no stand-in, this entry's
 * is named `<name>-<entry>`, so two entries that name the same connector each get their own tools
 * and records in one workspace.
 */
import type { AgentPolicy } from '@indx-workspace/contracts/agents';
import type { DemoEntrySlug } from '@indx-workspace/contracts/demo';
import {
  DemoSampleRecordsSchema,
  type DemoSampleRecords,
} from '@indx-workspace/contracts/demo-operator';

import type { ConnectorsStoreProvider } from '../../integrations';
import type { StorageService } from '../../storage-and-sharing';
import { fakeSendServerCommand } from './fake-send-server';
import { type DemoConnectorPlan, planDemoConnector } from './outside-tools';
import { toolsNamedOn } from './policy-remap';
import {
  readKeptWrites,
  readRecordsServerState,
  recordsServerArgs,
  recordsServerCommand,
} from './records-server';
import { recordsFolderOf } from './template-layout';
import type { TemplateSource, Visitor } from './template-copy-types';

export interface ConnectorCopyDependencies {
  readonly connectors: Pick<ConnectorsStoreProvider, 'forWorkspace'>;
  readonly storage: Pick<StorageService, 'open'>;
}

/** What the stand-ins of one template agent are made from. */
export interface StandInRequest {
  readonly entry: DemoEntrySlug;
  readonly assignedIds: readonly string[];
  readonly template: TemplateSource;
  readonly policy: AgentPolicy;
  /** The names of the entry's agents: a stand-in only they are assigned is this entry's. */
  readonly entryAgentNames: ReadonlySet<string>;
  /** Whether a stand-in that differs only by its kept approved writes keeps them (a visitor's demo). */
  readonly keepsApprovedWrites: boolean;
  /** For each connector id of the visitor's workspace, the names of the agents assigned it. */
  readonly assignedTo: ReadonlyMap<string, ReadonlySet<string>>;
}

type ConnectorStore = ReturnType<ConnectorsStoreProvider['forWorkspace']>;
type PresentConnector = Awaited<ReturnType<ConnectorStore['list']>>[number];
type StandInPlan = Exclude<DemoConnectorPlan, { readonly kind: 'omit' }>;
type StandInCommand = ReturnType<typeof fakeSendServerCommand>;

/** What making stand-ins needs, read once per agent. */
interface StandInContext {
  readonly deps: ConnectorCopyDependencies;
  readonly request: StandInRequest;
  readonly visitor: Visitor;
  readonly source: ConnectorStore;
  readonly target: ConnectorStore;
  readonly present: readonly PresentConnector[];
}

/** The record sets the template keeps for `connector`, as the seed stored them. */
async function recordSetsOf(
  deps: ConnectorCopyDependencies,
  template: TemplateSource,
  connector: string,
): Promise<readonly DemoSampleRecords[]> {
  const folder = `${recordsFolderOf(connector)}/`;
  const sets: DemoSampleRecords[] = [];
  for (const row of template.rows) {
    if (row.kind !== 'file' || !row.path.startsWith(folder)) continue;
    const opened = await deps.storage.open({ workspaceId: template.workspaceId }, row);
    if (opened === null) continue;
    const parsed = DemoSampleRecordsSchema.safeParse(
      JSON.parse(await new Response(opened.body).text()),
    );
    if (!parsed.success) throw new Error(`the demo template's record set ${row.path} is not valid`);
    sets.push(parsed.data);
  }
  return sets;
}

/**
 * The stand-in server's command: a records server when reads have records or a write is recorded
 * (ADR-0169), else a fake send.
 */
function standInCommand(
  plan: StandInPlan,
  reads: readonly string[],
  sets: readonly DemoSampleRecords[],
  templateTools: readonly string[],
): StandInCommand {
  if (reads.length > 0 || plan.recorded.length > 0) {
    return recordsServerCommand({ reads, writes: plan.tools, sets, recorded: plan.recorded });
  }
  return fakeSendServerCommand(plan.tools.length > 0 ? plan.tools : templateTools);
}

/**
 * What the stand-in for template connector `id` runs, or `null` when a connector the seed declared
 * that only reads has no records to read.
 */
async function plannedCommand(
  ctx: StandInContext,
  id: string,
  plan: StandInPlan,
): Promise<StandInCommand | null> {
  // The reads of a declared connector answer from its records; with none they are left out.
  const sets =
    plan.reads.length > 0 ? await recordSetsOf(ctx.deps, ctx.request.template, plan.name) : [];
  const reads = plan.reads.filter((tool) => sets.some((set) => set.tools.includes(tool)));
  const readsOnlyWithoutRecords =
    reads.length === 0 && plan.reads.length > 0 && plan.tools.length === 0;
  if (readsOnlyWithoutRecords) return null;
  return standInCommand(plan, reads, sets, toolsNamedOn(ctx.request.policy, id));
}

/** Whether a connector row is shaped as a stand-in the copy makes: a local process, no address. */
const isStandInRow = (connector: PresentConnector): boolean =>
  connector.transport === 'stdio' &&
  connector.command === 'node' &&
  connector.args?.[0] === '-e' &&
  connector.url === null &&
  !connector.hasCredential;

/** Whether the stand-in `present` runs exactly `command`: the same command and arguments. */
function runs(present: PresentConnector, command: StandInCommand): boolean {
  const args = present.args ?? [];
  return (
    present.command === command.command &&
    args.length === command.args.length &&
    args.every((arg, at) => arg === command.args[at])
  );
}

/**
 * `planned`, carrying the approved calls `present` keeps (ADR-0169 D3) whose write the planned
 * records stand-in still records. They are read from `present` whatever release's source it runs,
 * so neither a template change that keeps the write nor a change to the stand-in's code drops them.
 */
function withKeptWrites(present: PresentConnector, planned: StandInCommand): StandInCommand {
  const fresh = readRecordsServerState(planned);
  if (fresh === null) return planned;
  const recorded = new Set(fresh.recorded.map((entry) => entry.write));
  const written = readKeptWrites(present).filter((kept) => recorded.has(kept.write));
  return written.length === 0 ? planned : recordsServerArgs({ ...fresh, written });
}

/**
 * The name this entry's stand-in for `name` has in the visitor's workspace: the connector's own,
 * unless that name is held by a connector that is no stand-in or by a stand-in another entry's
 * agent is assigned.
 */
function standInName(ctx: StandInContext, name: string): string {
  const holder = ctx.present.find((candidate) => candidate.name === name);
  if (holder === undefined) return name;
  const assigned = [...(ctx.request.assignedTo.get(holder.id) ?? [])];
  const heldByAnother = assigned.some((agent) => !ctx.request.entryAgentNames.has(agent));
  return isStandInRow(holder) && !heldByAnother ? name : `${name}-${ctx.request.entry}`;
}

/** Make the stand-in `name` running `planned`; its id. */
async function createStandIn(
  ctx: StandInContext,
  name: string,
  planned: StandInCommand,
): Promise<string> {
  const made = await ctx.target.create(
    {
      name,
      transport: 'stdio',
      command: planned.command,
      args: planned.args,
      url: null,
      authType: 'none',
      credential: null,
    },
    { principalId: ctx.visitor.principalId, userId: ctx.visitor.userId },
  );
  if (made.kind === 'created') return made.server.id;
  // A name taken by a copy running at the same time is that copy's stand-in.
  const raced = (await ctx.target.list()).find((candidate) => candidate.name === name);
  if (raced === undefined) {
    throw new Error(`the demo stand-in for ${name} was not made: ${made.kind}`);
  }
  return raced.id;
}

/**
 * Bring an earlier copy's stand-in to `planned` when it runs something else; its id. A visitor's
 * keeps its approved writes; the verification workspace's starts again from the template's records.
 * A connector with the name that is no stand-in is never overwritten.
 */
async function refreshStandIn(
  ctx: StandInContext,
  present: PresentConnector,
  planned: StandInCommand,
): Promise<string> {
  if (!isStandInRow(present)) {
    throw new Error(`the connector ${present.name} is not a demo stand-in and is left as it is`);
  }
  const target = ctx.request.keepsApprovedWrites ? withKeptWrites(present, planned) : planned;
  if (runs(present, target)) return present.id;
  const updated = await ctx.target.update(present.id, {
    command: target.command,
    args: target.args,
  });
  if (updated.kind !== 'updated') {
    throw new Error(`the demo stand-in ${present.name} was not refreshed: ${updated.kind}`);
  }
  return present.id;
}

/** The visitor's stand-in for template connector `id`, or `null` when it has none. */
async function standInFor(ctx: StandInContext, id: string): Promise<string | null> {
  const connector = await ctx.source.get(id);
  if (connector === null) return null;
  const plan = planDemoConnector(connector);
  if (plan.kind === 'omit') return null;
  const planned = await plannedCommand(ctx, id, plan);
  if (planned === null) return null;
  const name = standInName(ctx, plan.name);
  const present = ctx.present.find((candidate) => candidate.name === name);
  return present === undefined
    ? createStandIn(ctx, name, planned)
    : refreshStandIn(ctx, present, planned);
}

/**
 * The visitor workspace's connectors for the template agent's, by {@link planDemoConnector}: each
 * template connector id that has a stand-in, mapped to the stand-in's id, in assignment order.
 */
export async function standInConnectors(
  deps: ConnectorCopyDependencies,
  request: StandInRequest,
  visitor: Visitor,
): Promise<ReadonlyMap<string, string>> {
  const target = deps.connectors.forWorkspace(visitor.workspaceId);
  const ctx: StandInContext = {
    deps,
    request,
    visitor,
    source: deps.connectors.forWorkspace(request.template.workspaceId),
    target,
    present: await target.list(),
  };
  const ids = new Map<string, string>();
  for (const id of request.assignedIds) {
    const standIn = await standInFor(ctx, id);
    if (standIn !== null) ids.set(id, standIn);
  }
  return ids;
}
