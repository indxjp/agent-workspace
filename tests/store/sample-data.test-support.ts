/**
 * What the sample-data checks of the live Agent Store entries share: the live entries, the app
 * resources and tools read from their source files, and the folders their sample records sit in.
 *
 * The catalog cannot read the repository around it (the No fork cell), so the checks that need the
 * agent definitions, the app resources and the sample files read them here.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  hasSource,
  type LiveEntry,
  type SourcedEntry,
} from '../../examples/store/catalog/define.ts';
import { CATALOG } from '../../examples/store/catalog/index.ts';
import { REPOSITORY_ROOT } from '../apps/registry.ts';
import { demoAgentDefinition } from './demo-agents.test-support.ts';
import { stagedView } from './live-verify/source-hash.ts';
import { CONNECTOR_TOOLS } from './seed/build.ts';

export const live = CATALOG.filter((entry): entry is LiveEntry => entry.status === 'live');
/**
 * The entries with a demo block: the live ones and the coming-soon ones seeded with their code, and
 * a live entry's staged rebuild (`next`, ADR-0174) beside it. A demo rule that can be checked before
 * the flip or the repoint is checked on all of them, because the demo block is part of the source
 * hash an R1 record carries: a fix made at the flip or the repoint would make R1 stale.
 */
export const withDemo: readonly SourcedEntry[] = [
  ...CATALOG.filter(hasSource),
  ...CATALOG.filter(hasSource)
    .map((entry) => stagedView(entry))
    .filter((entry) => !CATALOG.includes(entry)),
];
export const LANGS = ['ja', 'en'] as const;
export type Lang = (typeof LANGS)[number];

export const sourceOf = (entry: SourcedEntry): string => path.join(REPOSITORY_ROOT, entry.source);
export const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(file, 'utf8')) as unknown;

/** The entries as `[slug, entry]` rows, the shape `it.each` takes. */
export const bySlugRows = <E extends SourcedEntry>(
  entries: readonly E[],
): (readonly [string, E])[] => entries.map((entry) => [entry.slug, entry] as const);

/** The entry of `entries` with this slug; a missing one is a broken test, not a result. */
export function entryOf<E extends SourcedEntry>(entries: readonly E[], slug: string): E {
  const entry = entries.find((candidate) => candidate.slug === slug);
  if (entry === undefined) throw new Error(`no entry ${slug}`);
  return entry;
}

/** The live entries whose sample data is records rather than a seed folder. */
export const withRecords = live.filter((entry) => entry.demo.records !== undefined);

export const recordsFolder = (entry: LiveEntry, lang: Lang): string =>
  path.join(sourceOf(entry), entry.demo.records ?? '', lang);

// ---------------------------------------------------------------------------------------------
// The tools a demo agent can call
// ---------------------------------------------------------------------------------------------

interface DefinedAgent {
  readonly permissions?: {
    readonly readFiles?: boolean;
    readonly writeFiles?: boolean;
    readonly runCommands?: boolean;
  };
  readonly engine?: { readonly handoff?: boolean };
  readonly files?: readonly unknown[];
  readonly tools?: readonly DefinedTool[];
}

type DefinedTool =
  | { readonly connector: string }
  | { readonly name: string; readonly run: string }
  | { readonly name: string; readonly spec: string; readonly allow?: readonly string[] };

/**
 * One field of an example app resource: the constructor that declares it, whether it may be left
 * out, and the constructor's arguments as written.
 */
export interface AppField {
  readonly ctor: string;
  readonly optional: boolean;
  readonly args: string;
}

/**
 * One resource of an example app, read from its source file (the apps are not importable here).
 *
 * The tool-naming rule in `appToolNames` below and the field constructors read by `FIELD_LINE` are
 * a second copy of `packages/app/src/server/mcp-tools.ts` (`agentToolsOf`) and the field schemas,
 * because `@indx-workspace/app` does not resolve from the root tests project. That file is the
 * source of truth: change the rule there and mirror it here (a mismatch fails as "not a field" or
 * as a tool the demo agent cannot call).
 */
export interface AppResource {
  readonly name: string;
  readonly page: boolean;
  readonly fields: ReadonlyMap<string, AppField>;
  readonly read: boolean;
  readonly write: readonly string[] | false;
  readonly search: boolean;
}

const FIELD_LINE =
  /^\s+(\w+): (text|ref|person|enumOf|money|richText|tags|bool|number|files)\((.*)\),?$/gmu;

/** The fields every page resource has, whatever its file declares. */
function pageFields(text: string): Map<string, AppField> {
  const fields = new Map<string, AppField>([
    ['title', { ctor: 'text', optional: false, args: '' }],
    ['parent', { ctor: 'ref', optional: true, args: "'page'" }],
    ['position', { ctor: 'number', optional: true, args: '' }],
    ['blocks', { ctor: 'richText', optional: false, args: '' }],
  ]);
  if (/space: true/u.test(text)) {
    fields.set('space', { ctor: 'ref', optional: false, args: "'space'" });
  }
  return fields;
}

/** What `agents: { read, write }` of a resource file grants. */
function agentAccess(text: string): { read: boolean; write: readonly string[] | false } {
  const agents = /agents: \{ read: (true|false)(?:, write: (\[[^\]]*\]|false))? \}/u.exec(text);
  const writeSpec = agents?.[2];
  const write =
    writeSpec === undefined || writeSpec === 'false'
      ? false
      : [...writeSpec.matchAll(/'(\w+)'/gu)].map((match) => match[1] ?? '');
  return { read: agents?.[1] === 'true', write };
}

/** The resource a `resources/<name>.ts` file defines, read as text. */
function readResource(file: string): AppResource {
  const text = readFileSync(file, 'utf8');
  const page = text.includes('definePages(');
  const fields = page ? pageFields(text) : new Map<string, AppField>();
  for (const match of text.matchAll(FIELD_LINE)) {
    const args = match[3] ?? '';
    fields.set(match[1] ?? '', {
      ctor: match[2] ?? '',
      optional: /optional: true/u.test(args),
      args,
    });
  }
  return {
    name: page ? 'page' : (/name: '(\w+)'/u.exec(text)?.[1] ?? ''),
    page,
    fields,
    ...agentAccess(text),
    search: page || /search: \[[^\]]+\]/u.test(text),
  };
}

/** The resources an example app lists in its `app.config.ts`. */
export function readApp(source: string): AppResource[] {
  const config = readFileSync(path.join(source, 'app.config.ts'), 'utf8');
  return [...config.matchAll(/from '\.\/resources\/(\w+)\.ts'/gu)].map((match) =>
    readResource(path.join(source, 'resources', `${match[1] ?? ''}.ts`)),
  );
}

/** What an app's agent tools are named, by the rule the app's MCP endpoint applies. */
function appToolNames(resource: AppResource): string[] {
  const { name, read, write } = resource;
  return [
    ...(read ? [`${name}_list`, `${name}_get`] : []),
    ...(read && resource.search ? [`${name}_search`] : []),
    ...(resource.page && read ? [`${name}_children`] : []),
    ...(write === false ? [] : [`${name}_update`]),
    ...(resource.page && write !== false ? [`${name}_create`] : []),
  ];
}

/** Whether one `allow` rule admits the operation at `method` `route`. */
function ruleAdmits(rule: string, operationId: string, method: string, route: string): boolean {
  if (rule === `operationId:${operationId}`) return true;
  const [verb, pattern] = rule.split(' ');
  if (pattern === undefined || verb?.toLowerCase() !== method) return false;
  // A glob `*` is exactly one path segment.
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${expression}$`, 'u').test(route);
}

/** The operation ids a tool's `allow` admits from its OpenAPI document. */
function admittedOperations(specFile: string, allow: readonly string[] = []): string[] {
  const document = readJson(specFile) as {
    paths: Record<string, Record<string, { operationId?: string }>>;
  };
  const operations = Object.entries(document.paths).flatMap(([route, byMethod]) =>
    Object.entries(byMethod).map(([method, { operationId }]) => ({ route, method, operationId })),
  );
  return operations.flatMap(({ route, method, operationId }) =>
    operationId !== undefined && allow.some((rule) => ruleAdmits(rule, operationId, method, route))
      ? [operationId]
      : [],
  );
}

/** The tools of the MCP server `connector` that the source folder ships (`mcp/*.mjs`). */
function serverTools(source: string, connector: string): string[] {
  const folder = path.join(source, 'mcp');
  if (!existsSync(folder)) return [];
  for (const file of readdirSync(folder).filter((name) => name.endsWith('.mjs'))) {
    const text = readFileSync(path.join(folder, file), 'utf8');
    const server = new RegExp(`serveTools\\(\\{\\s*name: '${connector}',`, 'u').exec(text);
    if (server === null) continue;
    return [...text.slice(server.index).matchAll(/^ {6}name: '([a-z_]+)',/gmu)].map(
      (match) => match[1] ?? '',
    );
  }
  return [];
}

/** The tools every agent gets from its permissions and engine, whatever tools it declares. */
function builtInTools(defined: DefinedAgent): string[] {
  const { permissions = {}, engine = {} } = defined;
  const canRead = permissions.readFiles === true;
  const hasFiles = (defined.files?.length ?? 0) > 0;
  return [
    ...(canRead ? ['Read'] : []),
    ...(canRead && hasFiles ? ['search_files'] : []),
    ...(permissions.writeFiles === true ? ['Write'] : []),
    ...(permissions.runCommands === true ? ['run_skill_script'] : []),
    ...(engine.handoff === true ? ['handoff_to_person'] : []),
  ];
}

/**
 * The tool names one declared tool of the entry's agent brings. A connector of an agent entry
 * brings the tools its server code serves and the ones the seed's `CONNECTOR_TOOLS` table declares
 * for it (a use case's connector has no server in its folder: the copy's stand-in serves the table).
 * A code tool (`defineTool`, such as a public-source tool) brings its own name, served through the
 * shared code-tool connector.
 */
function declaredToolNames(entry: SourcedEntry, tool: DefinedTool): string[] {
  if ('connector' in tool) {
    if (entry.kind === 'app') return readApp(sourceOf(entry)).flatMap(appToolNames);
    const declared = CONNECTOR_TOOLS[entry.slug]?.[tool.connector];
    return [
      ...serverTools(sourceOf(entry), tool.connector),
      ...(declared === undefined ? [] : [...declared.reads, ...declared.writes]),
    ];
  }
  if ('run' in tool) return [tool.name];
  return admittedOperations(path.join(sourceOf(entry), tool.spec), tool.allow);
}

/** Every tool the demo agent of `entry` can call, by the plain name a run reports. */
export function callableTools(entry: SourcedEntry): Set<string> {
  const defined = demoAgentDefinition(entry) as DefinedAgent;
  return new Set([
    ...builtInTools(defined),
    ...(defined.tools ?? []).flatMap((tool) => declaredToolNames(entry, tool)),
  ]);
}
