/**
 * The connectors of a template agent's copy, by {@link planDemoConnector}: a reader is left out, a
 * tool that could send or write outside is a stand-in (`fake-send-server.ts`, or `records-server.ts`
 * where the seed declared the connector and the template holds sample records for its reads).
 */
import type { AgentPolicy } from '@indx-workspace/contracts/agents';
import {
  DemoSampleRecordsSchema,
  type DemoSampleRecords,
} from '@indx-workspace/contracts/demo-operator';

import type { ConnectorsStoreProvider } from '../../integrations';
import type { StorageService } from '../../storage-and-sharing';
import { fakeSendServerCommand } from './fake-send-server';
import { type DemoConnectorPlan, planDemoConnector } from './outside-tools';
import { toolsNamedOn } from './policy-remap';
import { recordsServerCommand } from './records-server';
import { recordsFolderOf } from './template-layout';
import type { TemplateSource, Visitor } from './template-copy-types';

export interface ConnectorCopyDependencies {
  readonly connectors: Pick<ConnectorsStoreProvider, 'forWorkspace'>;
  readonly storage: Pick<StorageService, 'open'>;
}

/** What the stand-ins of one template agent are made from. */
export interface StandInRequest {
  readonly assignedIds: readonly string[];
  readonly template: TemplateSource;
  readonly policy: AgentPolicy;
}

type ConnectorStore = ReturnType<ConnectorsStoreProvider['forWorkspace']>;
type PresentConnector = Awaited<ReturnType<ConnectorStore['list']>>[number];
type StandInPlan = Exclude<DemoConnectorPlan, { readonly kind: 'omit' }>;

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

/** The stand-in server's command: a records server when reads have records, else a fake send. */
function standInCommand(
  plan: StandInPlan,
  reads: readonly string[],
  sets: readonly DemoSampleRecords[],
  templateTools: readonly string[],
): ReturnType<typeof fakeSendServerCommand> {
  if (reads.length > 0) return recordsServerCommand({ reads, writes: plan.tools, sets });
  return fakeSendServerCommand(plan.tools.length > 0 ? plan.tools : templateTools);
}

/**
 * Make the stand-in for template connector `id`, or `null` when a connector the seed declared that
 * only reads has no records to read.
 */
async function createStandIn(
  ctx: StandInContext,
  id: string,
  plan: StandInPlan,
): Promise<string | null> {
  // The reads of a declared connector answer from its records; with none they are left out.
  const sets =
    plan.reads.length > 0 ? await recordSetsOf(ctx.deps, ctx.request.template, plan.name) : [];
  const reads = plan.reads.filter((tool) => sets.some((set) => set.tools.includes(tool)));
  const readsOnlyWithoutRecords =
    reads.length === 0 && plan.reads.length > 0 && plan.tools.length === 0;
  if (readsOnlyWithoutRecords) return null;
  const { command, args } = standInCommand(plan, reads, sets, toolsNamedOn(ctx.request.policy, id));
  const made = await ctx.target.create(
    {
      name: plan.name,
      transport: 'stdio',
      command,
      args,
      url: null,
      authType: 'none',
      credential: null,
    },
    { principalId: ctx.visitor.principalId, userId: ctx.visitor.userId },
  );
  if (made.kind === 'created') return made.server.id;
  // A name taken by a copy running at the same time is that copy's stand-in.
  const raced = (await ctx.target.list()).find((candidate) => candidate.name === plan.name);
  if (raced === undefined) {
    throw new Error(`the demo stand-in for ${plan.name} was not made: ${made.kind}`);
  }
  return raced.id;
}

/** The visitor's stand-in for template connector `id`, or `null` when it has none. */
async function standInFor(ctx: StandInContext, id: string): Promise<string | null> {
  const connector = await ctx.source.get(id);
  if (connector === null) return null;
  const plan = planDemoConnector(connector);
  if (plan.kind === 'omit') return null;
  const existing = ctx.present.find((candidate) => candidate.name === plan.name);
  if (existing !== undefined) return existing.id;
  return createStandIn(ctx, id, plan);
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
