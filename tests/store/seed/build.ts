/**
 * What the deploy's seeding step sends the platform for each live catalog entry
 * (`PUT /api/demo/templates/{entry}`, `DemoTemplateSeed`): built offline from the entry's own source
 * project, with no network and no credential.
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
 *   app's resources; `CONNECTOR_TOOLS` is the other entries' explicit table. A connector whose
 *   tools are not listed there declares none, and a copy offers it one send tool.
 * - The sample records are the entry's `demo.records` folder: one set per resource and language,
 *   mapped to the read tools that answer with it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DemoTemplateSeedSchema,
  type DemoSampleRecords,
  type DemoSeedConnector,
  type DemoSeedFile,
  type DemoSeedSkill,
  type DemoTemplateSeed,
} from '@indx-workspace/contracts/demo-operator';
import { isBuiltinSkillName } from '@indx-workspace/contracts/skills';
import { toAgentVersionBody, type DefinedAgent } from '@indx-workspace/sdk/define';

import type { LiveEntry } from '../../../examples/store/catalog/define.ts';
import { CATALOG } from '../../../examples/store/catalog/index.ts';
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
}

/**
 * The tools of the connectors the gallery entries' agents name, where a seed carries records for
 * them: the quotation entry's ERP, whose reads are its three lookups and whose one write is the
 * quote it books after a person's approval. Keyed by entry slug, then connector name.
 */
const CONNECTOR_TOOLS: Readonly<Record<string, Readonly<Record<string, ToolLists>>>> = {
  quotation: {
    erp: { reads: ['searchParts', 'getOrder', 'getRate'], writes: ['createQuote'] },
  },
};

/** Which read tools answer with the records of a gallery entry's resource (a records file name). */
const RECORD_TOOLS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  quotation: { parts: ['searchParts'], orders: ['getOrder'], rates: ['getRate'] },
};

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

const sourceOf = (entry: LiveEntry): string => path.join(REPOSITORY_ROOT, entry.source);

/** The text of the agent's instructions when it keeps them in a file beside its definition. */
function instructionsOf(entry: LiveEntry, agent: DefinedAgent): string | undefined {
  const { instructions } = agent;
  if (typeof instructions === 'string') return undefined;
  const folder = path.join(sourceOf(entry), 'agents');
  return readFileSync(path.join(folder, instructions.file), 'utf8');
}

/** The agent as the portable definition a demo template is made from. */
function definitionOf(entry: LiveEntry): DemoTemplateSeed['definition'] {
  const agent = demoAgentDefinition(entry) as DefinedAgent;
  const instructions = instructionsOf(entry, agent);
  const { definition } = toAgentVersionBody(
    agent,
    instructions === undefined ? {} : { instructions },
  );
  return {
    ...definition,
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
function skillsOf(entry: LiveEntry, names: readonly string[]): readonly DemoSeedSkill[] {
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
function filesOf(entry: LiveEntry): readonly DemoSeedFile[] {
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
  entry: LiveEntry,
  names: readonly string[],
  app: ReturnType<typeof appToolsOf> | null,
): readonly DemoSeedConnector[] {
  return names.map((name) => {
    const tools =
      app !== null && name === app.connector
        ? app.all
        : (CONNECTOR_TOOLS[entry.slug]?.[name] ?? { reads: [], writes: [] });
    return { name, reads: tools.reads, writes: tools.writes };
  });
}

/** The entry's sample records, one set per resource and language, for the connector that serves them. */
function recordsOf(
  entry: LiveEntry,
  connectors: readonly DemoSeedConnector[],
  app: ReturnType<typeof appToolsOf> | null,
): readonly DemoSampleRecords[] {
  const folder = entry.demo.records;
  if (folder === undefined) return [];
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

/** The seed of one live entry. */
export function buildSeed(entry: LiveEntry): DemoTemplateSeed {
  const definition = definitionOf(entry);
  const app = entry.kind === 'app' ? appToolsOf(sourceOf(entry)) : null;
  const connectors = connectorsOf(entry, definition.resources.connectors, app);
  return DemoTemplateSeedSchema.parse({
    definition,
    connectors,
    skills: skillsOf(entry, definition.resources.skills),
    files: filesOf(entry),
    records: recordsOf(entry, connectors, app),
  });
}

/** The live entries of the catalog: the ones with a demo to seed. */
export function liveEntries(): readonly LiveEntry[] {
  return CATALOG.filter((entry): entry is LiveEntry => entry.status === 'live');
}
