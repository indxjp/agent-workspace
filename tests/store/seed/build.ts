/**
 * What the deploy's seeding step sends the platform for each catalog entry it seeds
 * (`PUT /api/demo/templates/{entry}`, `DemoTemplateSeed`; {@link seededEntries}: in staging every
 * entry with a source, live or coming soon, in production the live ones): built offline from the
 * entry's own source project, with no network and no credential.
 *
 * - The agent is the entry's demo agent rendered to the portable K-1 definition by the SDK's own
 *   `toAgentVersionBody`, which is what `aw push` stores and `aw agents export` reads back, then made
 *   what a demo copy is: no model, no model connection, no runtime profile, and no pinned skill
 *   revision (a template keeps a skill's files as they are). It holds no secret: a connector is
 *   named, never configured.
 * - The skills are the ones the agent uses, each with its files from the entry's own
 *   `skills/<name>/` folder; a built-in skill is named by the definition and not carried, since the
 *   platform installs its own release.
 * - The sample files are the entry's `demo.seed` folders, at their collection paths, bytes as base64.
 * - The connectors are the ones the definition names, each with the tools that read and the tools
 *   that would send or write outside, so a visitor's copy can answer a read from the entry's records
 *   and a write with the demo-only reply. An app entry's tools are its app kit's, derived from the
 *   app's resources; an `openapiTool`'s are the operations its `allow` rules admit in its own
 *   document; `CONNECTOR_TOOLS` is the explicit table of the `mcp()` connectors whose tools live
 *   in a server's code, with the writes a records stand-in keeps (`recorded`). A connector found in none of these declares no tool, and a
 *   copy offers it one send tool, so `tests/store/demo-copy-tools.test.ts` checks that every tool a
 *   live entry's moment needs is offered.
 * - An `openapiTool`'s writes wait for a person's approval on the platform because its connector
 *   says so (ADR-0113 SD4), and a template's connector is a declaration with no document, so the
 *   definition's policy states the same rules (`requireApproval`, by connector name, as compose
 *   matches them) and the copy keeps them.
 * - The sample records are the entry's `demo.records` folder (one set per resource and language) and
 *   the gallery fixtures in `FIXTURE_RECORDS` (in the fixtures' one language), each mapped to the read
 *   tools that answer with it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DemoTemplateSeedSchema,
  type DemoRecordedWrite,
  type DemoSampleRecords,
  type DemoSeedConnector,
  type DemoSeedFile,
  type DemoSeedSkill,
  type DemoTemplateSeed,
} from '@indx-workspace/contracts/demo-operator';
import { isBuiltinSkillName } from '@indx-workspace/contracts/skills';
import {
  AW_DEV_TOOLS_CONNECTOR,
  selectAllowedOperations,
  toolApprovalRules,
  TOOL_OPERATION_METHODS,
  type ToolOperationMethod,
} from '@indx-workspace/contracts/tool-connectors';
import {
  isOpenApiTool,
  publicSourceRecords,
  toAgentVersionBody,
  type CodeTool,
  type DefinedAgent,
  type OpenApiTool,
  type PublicSourceConfig,
} from '@indx-workspace/sdk/define';

import {
  hasSource,
  type CatalogEntry,
  type LiveEntry,
  type SourcedEntry,
} from '../../../examples/store/catalog/define.ts';
import { CATALOG } from '../../../examples/store/catalog/index.ts';
import marketStats, { stats as marketSource } from '../../../use-cases/market/tools/stats.ts';
import screeningLists, {
  lists as screeningSource,
} from '../../../use-cases/screening/tools/lists.ts';
import { parseAuthorityMatrix } from '../../gallery/ringi-review/mcp/authority.mjs';
import { demoAgentDefinition } from '../demo-agents.test-support.ts';

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const LANGS = ['ja', 'en'] as const;

interface ToolLists {
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  /**
   * The writes a copy's records stand-in keeps once a person approved them, each with the kind of
   * record it is and the read that answers with it (G3, ADR-0169).
   */
  readonly recorded?: readonly DemoRecordedWrite[];
}

/**
 * The tools of the `mcp()` connectors whose tools live in a server's code rather than in the
 * source project, as the servers name them: the gallery's (`<source>/mcp/*.mjs`, which a seed
 * carries records for, `FIXTURE_RECORDS`) and a use case's stand-in connector. Keyed by entry slug,
 * then connector name. An entry with no source is never seeded, so its row waits harmlessly.
 */
export const CONNECTOR_TOOLS: Readonly<Record<string, Readonly<Record<string, ToolLists>>>> = {
  'ringi-review': { authority: { reads: ['check_authority'], writes: [] } },
  'meeting-minutes': { 'task-tracker': { reads: ['list_members'], writes: [] } },
  // The incident router (use-cases/incident): it reads the tracker's open tasks and routes an alert
  // by creating one, which waits for approval and is then kept as a task the read answers with.
  incident: {
    tracker: {
      reads: ['list_tasks'],
      writes: ['create_task'],
      recorded: [{ write: 'create_task', kind: 'task', read: 'list_tasks' }],
    },
  },
  // The onboarding flow (use-cases/onboarding): it creates one onboarding task per approved call
  // and reads them back; its connector is named after the entry, so no other demo shares it.
  onboarding: {
    'onboarding-tasks': {
      reads: ['list_tasks'],
      writes: ['create_task'],
      recorded: [{ write: 'create_task', kind: 'task', read: 'list_tasks' }],
    },
  },
  // The account requests desk (use-cases/account-requests): it records one access change per
  // approved call and reads them back; its connector is named after the entry, so no other demo
  // shares it.
  'account-requests': {
    'account-requests-grants': {
      reads: ['list_grants'],
      writes: ['change_access'],
      recorded: [{ write: 'change_access', kind: 'access', read: 'list_grants' }],
    },
  },
  // The use cases that read a public source (ADR-0170): the code tool is a read of the shared
  // code-tool connector, answered from the snapshot in `PUBLIC_SOURCES` below.
  market: { [AW_DEV_TOOLS_CONNECTOR]: { reads: [marketStats.name], writes: [] } },
  screening: { [AW_DEV_TOOLS_CONNECTOR]: { reads: [screeningLists.name], writes: [] } },
};

/**
 * The public-source tools of the use cases that read one (ADR-0170 D4), keyed by entry slug: the code
 * tool the project declares and the configuration it ships. A copy's records stand-in answers the
 * tool's read from that configuration's own snapshot, in both languages, as the tool's snapshot
 * mode does, so the demo and the project cannot drift.
 */
export const PUBLIC_SOURCES: Readonly<
  Record<string, { readonly tool: CodeTool; readonly source: PublicSourceConfig }>
> = {
  market: { tool: marketStats, source: marketSource },
  screening: { tool: screeningLists, source: screeningSource },
};

/** The record sets of the entry's public-source tool, one per language; none without one. */
export function publicSourceSets(slug: string): readonly DemoSampleRecords[] {
  const publicSource = PUBLIC_SOURCES[slug];
  if (publicSource === undefined) return [];
  const { snapshot } = publicSource.source;
  if (snapshot === undefined) throw new Error(`${slug}: its public source ships no snapshot`);
  return LANGS.map((lang) =>
    publicSourceRecords({
      connector: AW_DEV_TOOLS_CONNECTOR,
      tool: publicSource.tool.name,
      lang,
      snapshot,
    }),
  );
}

/** The connector `name` as a seed declares it; `recorded` only when it keeps a write. */
export function declaredConnector(name: string, tools: ToolLists): DemoSeedConnector {
  return {
    name,
    reads: tools.reads,
    writes: tools.writes,
    ...(tools.recorded === undefined ? {} : { recorded: tools.recorded }),
  };
}

/** Which read tools answer with the records of a gallery entry's resource (a records file name). */
const RECORD_TOOLS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  quotation: { parts: ['searchParts'], orders: ['getOrder'], rates: ['getRate'] },
};

/** Records a gallery entry's fixtures hold for one connector, read from its source project. */
interface FixtureRecords {
  readonly connector: string;
  readonly resource: string;
  readonly tools: readonly string[];
  readonly data: (source: string) => unknown;
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8')) as unknown;

/**
 * The gallery fixtures a copy's read tools answer with, for the entries whose catalog names no
 * records folder: the QMS's past defect reports, the authority matrix as `check_authority` reads
 * it from the rule book, and the assignable members `list_members` shows. The fixtures are in
 * Japanese only, as the entries' data is. The gallery servers compute an answer from these (a 4M
 * count, one approver); a copy hands the model the records the computation would read.
 */
const FIXTURE_RECORDS: Readonly<Record<string, readonly FixtureRecords[]>> = {
  'quality-defect': [
    {
      connector: 'qms',
      resource: 'defects',
      tools: ['searchDefects', 'getDefect', 'causeStats'],
      data: (source) =>
        filesUnder(path.join(source, 'data', 'defects')).map((file) =>
          readJson(path.join(source, 'data', 'defects', file)),
        ),
    },
  ],
  'ringi-review': [
    {
      connector: 'authority',
      resource: 'authority',
      tools: ['check_authority'],
      data: (source) =>
        parseAuthorityMatrix(
          readFileSync(path.join(source, 'data', 'rules', 'authority-matrix.md'), 'utf8'),
        ).categories,
    },
  ],
  'meeting-minutes': [
    {
      connector: 'task-tracker',
      resource: 'members',
      tools: ['list_members'],
      data: (source) => {
        const roster = readJson(path.join(source, 'data', 'members.json')) as {
          readonly members: readonly {
            readonly name: string;
            readonly department: string;
            readonly title: string;
            readonly assignable: boolean;
          }[];
        };
        return roster.members
          .filter((member) => member.assignable)
          .map(({ name, department, title }) => ({ name, department, title }));
      },
    },
  ],
};

const isOperationMethod = (method: string): method is ToolOperationMethod =>
  TOOL_OPERATION_METHODS.some((known) => known === method);

/**
 * The operations an `openapiTool` exposes: the ones its `allow` rules admit in its document (a
 * project-relative JSON file), by operation id, which is the tool name the platform registers.
 */
function operationsOf(
  entry: SourcedEntry,
  tool: OpenApiTool,
): readonly { readonly name: string; readonly method: ToolOperationMethod }[] {
  const document = readJson(path.join(sourceOf(entry), tool.spec)) as {
    readonly paths?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  };
  const candidates = Object.entries(document.paths ?? {}).flatMap(([template, item]) =>
    Object.entries(item).flatMap(([method, operation]) => {
      const upper = method.toUpperCase();
      const operationId = (operation as { readonly operationId?: unknown } | null)?.operationId;
      return isOperationMethod(upper) && typeof operationId === 'string'
        ? [{ method: upper, path: template, operationId }]
        : [];
    }),
  );
  const { admitted, refusals } = selectAllowedOperations(tool.allow, candidates);
  if (refusals.length > 0 || admitted.length === 0) {
    throw new Error(`${entry.slug}: the allow rules of ${tool.name} do not hold in its document`);
  }
  return admitted.map((operation) => ({ name: operation.operationId, method: operation.method }));
}

/** The `openapiTool`s the entry's agent holds. */
function openApiToolsOf(entry: SourcedEntry): readonly OpenApiTool[] {
  const agent = demoAgentDefinition(entry) as DefinedAgent;
  return (agent.tools ?? []).filter(isOpenApiTool);
}

/** Its reads and writes, as a seed declares a connector's tools. */
function openApiToolLists(entry: SourcedEntry, tool: OpenApiTool): ToolLists {
  const operations = operationsOf(entry, tool);
  const gated = new Set(toolApprovalRules(tool.name, operations));
  const isWrite = (name: string): boolean => gated.has(`mcp__${tool.name}__${name}`);
  return {
    reads: operations.filter((op) => !isWrite(op.name)).map((op) => op.name),
    writes: operations.filter((op) => isWrite(op.name)).map((op) => op.name),
  };
}

/**
 * The agent tools of an app entry's connector, by resource (`tests/store/sample-data.test.ts` checks
 * the same rule): for a resource agents may read, `<name>_list`, `<name>_get` and, when it is searchable,
 * `<name>_search`; a page resource also `<name>_children`; for one agents may write, `<name>_update`
 * and, for pages, `<name>_create`. The app's source is read as text, because the example apps import
 * the app kit, which the repository root does not resolve outside the test runner, and this runs as a
 * plain script.
 */
function appToolsOf(source: string): {
  readonly connector: string;
  readonly byResource: ReadonlyMap<string, ToolLists>;
  readonly all: ToolLists;
} {
  const config = readFileSync(path.join(source, 'app.config.ts'), 'utf8');
  const connector = /defineApp\(\{\s*name: '([^']+)'/u.exec(config)?.[1];
  if (connector === undefined) throw new Error(`${source}: app.config.ts names no app`);
  const byResource = new Map<string, ToolLists>();
  for (const [, file] of config.matchAll(/from '\.\/resources\/(\w+)\.ts'/gu)) {
    const text = readFileSync(path.join(source, 'resources', `${file ?? ''}.ts`), 'utf8');
    const page = text.includes('definePages(');
    const name = page ? 'page' : (/name: '(\w+)'/u.exec(text)?.[1] ?? '');
    const agents = /agents: \{ read: (true|false)(?:, write: (\[[^\]]*\]|false))? \}/u.exec(text);
    const readable = agents?.[1] === 'true';
    const writable = agents?.[2] !== undefined && agents[2] !== 'false';
    const searchable = page || /search: \[[^\]]+\]/u.test(text);
    byResource.set(name, {
      reads: readable
        ? [
            `${name}_list`,
            `${name}_get`,
            ...(searchable ? [`${name}_search`] : []),
            ...(page ? [`${name}_children`] : []),
          ]
        : [],
      writes: writable ? [`${name}_update`, ...(page ? [`${name}_create`] : [])] : [],
    });
  }
  const lists = [...byResource.values()];
  return {
    connector,
    byResource,
    all: { reads: lists.flatMap((l) => l.reads), writes: lists.flatMap((l) => l.writes) },
  };
}

const sourceOf = (entry: SourcedEntry): string => path.join(REPOSITORY_ROOT, entry.source);

/** The text of the agent's instructions when it keeps them in a file beside its definition. */
function instructionsOf(entry: SourcedEntry, agent: DefinedAgent): string | undefined {
  const { instructions } = agent;
  if (typeof instructions === 'string') return undefined;
  const folder = path.join(sourceOf(entry), 'agents');
  return readFileSync(path.join(folder, instructions.file), 'utf8');
}

/** The agent as the portable definition a demo template is made from. */
function definitionOf(entry: SourcedEntry): DemoTemplateSeed['definition'] {
  const agent = demoAgentDefinition(entry) as DefinedAgent;
  const instructions = instructionsOf(entry, agent);
  const { definition } = toAgentVersionBody(
    agent,
    instructions === undefined ? {} : { instructions },
  );
  const gated = openApiToolsOf(entry).flatMap((tool) =>
    toolApprovalRules(tool.name, operationsOf(entry, tool)),
  );
  const { policy } = definition;
  if (gated.length > 0 && !('tools' in policy)) {
    throw new Error(`${entry.slug}: an openapiTool's writes need a Claude policy to wait in`);
  }
  return {
    ...definition,
    ...(gated.length === 0 || !('tools' in policy)
      ? {}
      : {
          policy: {
            ...policy,
            requireApproval: [...new Set([...(policy.requireApproval ?? []), ...gated])].sort(),
          },
          policySource: 'stored' as const,
        }),
    agent: {
      ...definition.agent,
      model: null,
      modelConnectionName: null,
      runtimeProfileName: null,
    },
    // A template keeps each skill's files as they are, so no revision is pinned.
    resources: {
      files: definition.resources.files,
      skills: definition.resources.skills,
      connectors: definition.resources.connectors,
    },
  };
}

/** Every file under `folder`, as paths relative to it, in a stable order. */
function filesUnder(folder: string): readonly string[] {
  const found: string[] = [];
  const walk = (relative: string): void => {
    for (const name of readdirSync(path.join(folder, relative)).sort()) {
      const child = path.join(relative, name);
      if (statSync(path.join(folder, child)).isDirectory()) walk(child);
      else found.push(child);
    }
  };
  walk('');
  return found;
}

/** The skills the definition names that are not built-ins, each with its files from `skills/<name>/`. */
function skillsOf(entry: SourcedEntry, names: readonly string[]): readonly DemoSeedSkill[] {
  return names
    .filter((name) => !isBuiltinSkillName(name))
    .map((name) => {
      const folder = path.join(sourceOf(entry), 'skills', name);
      return {
        name,
        files: filesUnder(folder).map((relative) => ({
          path: relative.split(path.sep).join('/'),
          base64: readFileSync(path.join(folder, relative)).toString('base64'),
        })),
      };
    });
}

/** The entry's `demo.seed` folders as sample files, at `<collection>/<path under the folder>`. */
function filesOf(entry: SourcedEntry): readonly DemoSeedFile[] {
  return entry.demo.seed.flatMap((seed) => {
    const from = path.join(sourceOf(entry), seed.from);
    return filesUnder(from).map((relative) => ({
      path: `${seed.collection}/${relative.split(path.sep).join('/')}`,
      base64: readFileSync(path.join(from, relative)).toString('base64'),
    }));
  });
}

/** The tools of each connector the definition names, for the entry. */
function connectorsOf(
  entry: SourcedEntry,
  names: readonly string[],
  app: ReturnType<typeof appToolsOf> | null,
): readonly DemoSeedConnector[] {
  const openApi = new Map(openApiToolsOf(entry).map((tool) => [tool.name, tool] as const));
  return names.map((name) => {
    const tool = openApi.get(name);
    const tools =
      app !== null && name === app.connector
        ? app.all
        : tool !== undefined
          ? openApiToolLists(entry, tool)
          : (CONNECTOR_TOOLS[entry.slug]?.[name] ?? { reads: [], writes: [] });
    return declaredConnector(name, tools);
  });
}

/** The entry's sample records, one set per resource and language, for the connector that serves them. */
function recordsOf(
  entry: SourcedEntry,
  connectors: readonly DemoSeedConnector[],
  app: ReturnType<typeof appToolsOf> | null,
): readonly DemoSampleRecords[] {
  const fixtures = (FIXTURE_RECORDS[entry.slug] ?? []).map((fixture): DemoSampleRecords => ({
    connector: fixture.connector,
    resource: fixture.resource,
    lang: 'ja',
    tools: fixture.tools,
    data: fixture.data(sourceOf(entry)),
  }));
  const folder = entry.demo.records;
  if (folder === undefined) return fixtures;
  if (fixtures.length > 0) throw new Error(`${entry.slug}: records come from one place only`);
  const connector =
    app === null ? connectors.find((candidate) => candidate.reads.length > 0) : undefined;
  const connectorName = app === null ? connector?.name : app.connector;
  if (connectorName === undefined) {
    throw new Error(`${entry.slug}: it has sample records and no connector that reads them`);
  }
  const sets: DemoSampleRecords[] = [];
  for (const lang of LANGS) {
    const langFolder = path.join(sourceOf(entry), folder, lang);
    for (const file of readdirSync(langFolder).sort()) {
      const resource = path.basename(file, '.json');
      const tools =
        app === null
          ? (RECORD_TOOLS[entry.slug]?.[resource] ?? [])
          : (app.byResource.get(resource)?.reads ?? []);
      // A resource no read tool answers for is not something the agent can read.
      if (tools.length === 0) continue;
      sets.push({
        connector: connectorName,
        resource,
        lang,
        tools,
        data: JSON.parse(readFileSync(path.join(langFolder, file), 'utf8')) as unknown,
      });
    }
  }
  return sets;
}

/** The seed of one entry with a source, live or coming soon. */
export function buildSeed(entry: SourcedEntry): DemoTemplateSeed {
  const definition = definitionOf(entry);
  const app = entry.kind === 'app' ? appToolsOf(sourceOf(entry)) : null;
  const connectors = connectorsOf(entry, definition.resources.connectors, app);
  return DemoTemplateSeedSchema.parse({
    definition,
    connectors,
    skills: skillsOf(entry, definition.resources.skills),
    files: filesOf(entry),
    records: [...recordsOf(entry, connectors, app), ...publicSourceSets(entry.slug)],
  });
}

/** The live entries of the catalog: the ones a visitor can try. */
export function liveEntries(): readonly LiveEntry[] {
  return CATALOG.filter((entry): entry is LiveEntry => entry.status === 'live');
}

/** Where the deploy seeds: the staging project (every push to main) or production (a tag). */
export type SeedEnvironment = 'staging' | 'production';

/**
 * The entries the deploy seeds a template for. Staging: every entry with a source, live or coming
 * soon, so an entry's code merged as `soon` is seeded and R1 can verify it before the flip (the Agent
 * Store 100-use-case plan, section 7). Production: the live entries only, the ones a visitor can try
 * and the nightly sample check expects.
 */
export function seededEntries(
  environment: SeedEnvironment,
  entries: readonly CatalogEntry[] = CATALOG,
): readonly SourcedEntry[] {
  return entries.filter((entry): entry is SourcedEntry =>
    environment === 'staging' ? hasSource(entry) : entry.status === 'live',
  );
}
