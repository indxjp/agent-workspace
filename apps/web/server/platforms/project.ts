/**
 * Builds the {@link PortableProject} one saved agent version exports (issue #968). The translators
 * in `@indx-workspace/platforms` stay pure, so everything they need as bytes is loaded here.
 *
 * The project is assembled by `loadPortableProject` over a virtual project directory: the stored
 * version is the agent, its subagents are the production (else local) versions of the agents it
 * names, and the skill and knowledge files are read from this workspace. The public MCP tool
 * endpoint is the one `mcp-project` client that publishes the root agent. What a stored version
 * cannot carry is reported as `dropped`, never guessed. An OpenAPI connector is carried with the
 * document it was registered with; one registered before documents were kept has none, and is
 * `dropped` with a note to register it again.
 */
import { createHash } from 'node:crypto';

import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';
import { connectorKindOf } from '@indx-workspace/contracts/connectors';
import type { EndpointClientResource } from '@indx-workspace/contracts/endpoint-clients';
import type { FieldVerdict } from '@indx-workspace/contracts/platforms';
import {
  PLATFORM_EXPORT_MAX_BYTES,
  PLATFORM_EXPORT_PROBLEM_CODES,
} from '@indx-workspace/contracts/platforms';
import {
  PortableRelativePathSchema,
  PortableToolNameSchema,
  type PortableProject,
} from '@indx-workspace/contracts/portable-agent';
import { SECRET_NAME_MAX_LENGTH } from '@indx-workspace/contracts/secrets';
import { SKILL_MD_FILENAME } from '@indx-workspace/contracts/skills';
import { AW_DEV_TOOLS_CONNECTOR } from '@indx-workspace/contracts/tool-connectors';
import { NAME_KEY_PATTERN, type ProjectConnector } from '@indx-workspace/contracts/project-file';
import type { OpenApiToolDefinition } from '@indx-workspace/sdk/define';
import { loadPortableProject, type PortableProjectSource } from '@indx-workspace/sdk/portable';
import { parse as parseYaml } from 'yaml';

import { agentVersionNotFound } from '../agent-versions/problems';
import { toAgentVersionResource } from '../agent-versions/contract';
import type { WorkspaceAgentVersionStore } from '../agent-versions/store';
import { problem, type ApiResult } from '../agents/handlers';
import type { AnyConnectorResource } from '../connectors/contract';
import type { WorkspaceConnectorsStore } from '../connectors/store';

const NOTE_MAX_LENGTH = 1_024;
const PATH_MAX_LENGTH = 512;
const SKILLS_DIRECTORY = 'skills/';
const SKILL_DROP_REASON = /^skills\/(.+)\/ is not in the project$/u;
const CONNECTOR_DROP_PATH = /^definition\.resources\.connectors\.(\d+)$/u;
const SKILL_DROP_PATH = /^skills\.\d+$/u;
const MCP_PROJECT_KIND = 'mcp-project';
const SERVER_VARIABLE = /\{([^{}]*)\}/gu;
/** The origin a relative `servers[].url` is resolved against; only its query and the rest matter. */
const SERVER_URL_BASE = 'https://server.invalid/';

/** One file of a skill's tree, relative to the skill's directory; its bytes are read on demand. */
export interface SkillFileListing {
  readonly path: string;
  readonly sizeBytes: number;
  readonly read: () => Promise<Uint8Array>;
}

/**
 * Thrown once the files an export would carry hold more bytes than an export may hold, so the
 * export stops before reading the rest; {@link exportAgentVersion} answers it as
 * `422 platform_export_too_large`.
 */
export class PlatformExportTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`The export reached ${bytes} bytes, over the ${PLATFORM_EXPORT_MAX_BYTES} byte cap.`);
  }
}

/** What {@link buildPortableProject} reads; each member is bound to the caller's workspace. */
export interface PortableProjectSources {
  readonly versions: Pick<WorkspaceAgentVersionStore, 'find' | 'list' | 'agentsByName'>;
  readonly connectors: Pick<WorkspaceConnectorsStore, 'list' | 'openapiDocument'>;
  /** The listing of the skill `name`'s files; empty when the skill's tree is gone. */
  readonly skillFiles: (name: string) => Promise<readonly SkillFileListing[]>;
  /** The bytes of the workspace file at `path`, or `null` when there is none. */
  readonly workspaceFile: (path: string) => Promise<Uint8Array | null>;
  /** Every endpoint client of the workspace; `[]` when the deployment serves none. */
  readonly endpointClients: () => Promise<readonly EndpointClientResource[]>;
  /** The deployment's public origin (`AW_PUBLIC_URL`), or `null` when it has none. */
  readonly publicOrigin: string | null;
}

export type PortableProjectOutcome =
  | {
      readonly ok: true;
      readonly project: PortableProject;
      /** Everything the stored version could not carry into the project, as `dropped` verdicts. */
      readonly dropped: readonly FieldVerdict[];
    }
  | { readonly ok: false; readonly result: ApiResult };

function dropped(path: string, reason: string): FieldVerdict {
  return {
    path: path.slice(0, PATH_MAX_LENGTH),
    verdict: 'dropped',
    code: 'field_unsupported',
    note: reason.slice(0, NOTE_MAX_LENGTH),
  };
}

function isPlainUrl(url: URL): boolean {
  return url.username === '' && url.password === '' && url.search === '' && url.hash === '';
}

/** Why an assigned connector cannot be exported, or `null` when it can. */
function connectorRefusal(connector: AnyConnectorResource): string | null {
  const kind = connectorKindOf(connector);
  if (kind !== 'mcp') return `${kind} connectors are not exported yet`;
  if (connector.transport === 'stdio' || connector.url === null) {
    return 'stdio MCP connectors run inside Agent Workspace and have no remote URL';
  }
  // Fails closed: only a URL with no userinfo, query or fragment is exported, because any of them
  // can hold a credential. The note names the connector and never the URL.
  if (!URL.canParse(connector.url) || !isPlainUrl(new URL(connector.url))) {
    return `the connector ${connector.name}: the URL carries a query, fragment or credential; re-register it without one`;
  }
  if (connector.authType === 'oauth')
    return 'OAuth connectors cannot be written as a secret reference';
  if (
    (connector.authType === 'bearer' || connector.authType === 'api-key') &&
    !connector.hasCredential
  ) {
    return `the connector ${connector.name} requires a ${connector.authType} credential but none is on file; add one and export again`;
  }
  return null;
}

/**
 * Whether every top-level `servers[].url` of an OpenAPI document passes {@link isPlainUrl}. Each
 * `{variable}` is its string default (else `x`), and a relative URL is resolved against a stand-in
 * origin. Fails closed: a document that does not parse, or a URL that does not, is not plain.
 */
function serverUrlsArePlain(text: string): boolean {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch {
    return false;
  }
  const servers = isRecord(document) ? document['servers'] : undefined;
  if (servers === undefined || servers === null) return true;
  if (!Array.isArray(servers)) return false;
  return servers.every((server: unknown) => {
    if (!isRecord(server) || server['url'] === undefined) return true;
    const raw = server['url'];
    if (typeof raw !== 'string') return false;
    const variables = isRecord(server['variables']) ? server['variables'] : {};
    const url = raw.replace(SERVER_VARIABLE, (_, name: string) => {
      const variable = Object.hasOwn(variables, name) ? variables[name] : undefined;
      const fallback = isRecord(variable) ? variable['default'] : undefined;
      return typeof fallback === 'string' ? fallback : 'x';
    });
    return URL.canParse(url, SERVER_URL_BASE) && isPlainUrl(new URL(url, SERVER_URL_BASE));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The secret name `name` is referenced by: `prefix` and the name as an upper-case identifier,
 * which is always a valid, never a reserved, secret name.
 */
function secretNameOf(prefix: string, name: string): string {
  const identifier = name.toUpperCase().replaceAll(/[^A-Z0-9]+/gu, '_');
  return `${prefix}${identifier}`.slice(0, SECRET_NAME_MAX_LENGTH);
}

/**
 * The connector as a project file would declare it. A credential on file becomes a secret
 * reference by {@link secretNameOf}; the resource has no field that could hold its value.
 */
function projectConnectorOf(connector: AnyConnectorResource): ProjectConnector | null {
  if (connector.url === null) return null;
  const scheme = connector.authType === 'api-key' ? 'api-key' : 'bearer';
  const hasAuth = connector.hasCredential && connector.authType !== 'none';
  return {
    url: connector.url,
    ...(connector.transport === 'sse' ? { transport: 'sse' as const } : {}),
    ...(hasAuth
      ? { auth: { scheme, credential: { secret: secretNameOf('CONNECTOR_', connector.name) } } }
      : {}),
  };
}

/**
 * The OpenAPI tool a connector exports as, with the document text its `spec` ref names, or why it
 * cannot be. The stored text must hash to the digest the resource reports, so a document left by
 * another revision (a rolling deploy) is never exported as the wrong spec.
 */
async function openApiEntryOf(
  connector: AnyConnectorResource,
  documentOf: PortableProjectSources['connectors']['openapiDocument'],
): Promise<{ readonly tool: OpenApiToolDefinition; readonly text: string } | string> {
  const config = 'openapi' in connector ? connector.openapi : undefined;
  if (config === undefined) return `the connector ${connector.name} has no OpenAPI configuration`;
  // Refused before the document is read, so no bytes are reserved for a tool the converter drops.
  if (!PortableToolNameSchema.safeParse(connector.name).success) {
    return `the connector ${connector.name} cannot be a portable tool name (1-64 letters, digits, "_" or "-"); rename it and export again`;
  }
  // The same fail-closed rule as an MCP connector's URL; the note names the connector, never the URL.
  if (!URL.canParse(config.baseUrl) || !isPlainUrl(new URL(config.baseUrl))) {
    return `the connector ${connector.name}: the base URL carries a query, fragment or credential; re-register it without one`;
  }
  const text = await documentOf(connector.id);
  if (text === null) {
    return `the connector ${connector.name} was registered before Agent Workspace kept OpenAPI documents; replace it with its document and export again`;
  }
  if (`sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}` !== config.spec.digest) {
    return `the connector ${connector.name}'s stored document does not match its digest; replace it with its document and export again`;
  }
  // The document is exported byte for byte, so a server URL that fails the rule drops the connector.
  if (!serverUrlsArePlain(text)) {
    return `the connector ${connector.name}: a server URL in its document carries a query, fragment or credential; replace it with a document without one`;
  }
  if (config.auth !== 'none' && !connector.hasCredential) {
    return `the connector ${connector.name} requires a credential but none is on file; add one and export again`;
  }
  return {
    text,
    tool: {
      kind: 'openapi',
      name: connector.name,
      spec: `openapi/${connector.id}.${text.trimStart().startsWith('{') ? 'json' : 'yaml'}`,
      allow: config.allow,
      auth: config.auth,
      baseUrl: config.baseUrl,
      ...(config.auth === 'none'
        ? {}
        : { credential: { secret: secretNameOf('CONNECTOR_', connector.name) } }),
    },
  };
}

/** The connectors every exported body assigns, as project entries, and why the others are not. */
async function connectorContext(
  bodies: readonly AgentVersionBody[],
  sources: PortableProjectSources['connectors'],
  reserve: (bytes: number) => void,
): Promise<{
  readonly connectors: Record<string, ProjectConnector>;
  readonly catalogTools: OpenApiToolDefinition[];
  readonly specs: ReadonlyMap<string, string>;
  readonly refusals: ReadonlyMap<string, string>;
}> {
  const workspaceConnectors = await sources.list();
  const connectors: Record<string, ProjectConnector> = {};
  const openApi = new Map<string, { tool: OpenApiToolDefinition; text: string }>();
  const refusals = new Map<string, string>();
  const names = new Set(
    bodies
      .flatMap((body) => body.definition.resources.connectors)
      .filter((name) => name !== AW_DEV_TOOLS_CONNECTOR),
  );
  for (const name of names) {
    const connector = workspaceConnectors.find((candidate) => candidate.name === name);
    if (connector === undefined) {
      refusals.set(name, `this workspace has no connector named ${name}`);
      continue;
    }
    if (connectorKindOf(connector) === 'openapi') {
      const entry = await openApiEntryOf(connector, sources.openapiDocument);
      if (typeof entry === 'string') refusals.set(name, entry);
      else openApi.set(name, entry);
      continue;
    }
    const refusal = connectorRefusal(connector);
    const projectConnector = refusal === null ? projectConnectorOf(connector) : null;
    if (projectConnector === null) {
      refusals.set(name, refusal ?? `the connector ${name} has no URL`);
    } else {
      connectors[name] = projectConnector;
    }
  }

  // Two names can map to one secret name (`a-b` and `a_b`); binding both to one host secret would
  // hand one connector the other's credential. Order-independent: every member of a group is dropped.
  const bySecret = new Map<string, string[]>();
  const secretOf = [
    ...Object.entries(connectors).map(
      ([name, connector]) => [name, connector.auth?.credential.secret] as const,
    ),
    ...[...openApi].map(([name, entry]) => [name, entry.tool.credential?.secret] as const),
  ];
  for (const [name, secret] of secretOf) {
    if (secret !== undefined) bySecret.set(secret, [...(bySecret.get(secret) ?? []), name]);
  }
  for (const [secret, group] of bySecret) {
    if (group.length < 2) continue;
    for (const name of group) {
      refusals.set(
        name,
        `the connectors ${group.join(', ')} would share the secret name ${secret}; rename one and export again`,
      );
      delete connectors[name];
      openApi.delete(name);
    }
  }

  const specs = new Map<string, string>();
  for (const { tool, text } of openApi.values()) {
    reserve(Buffer.byteLength(text, 'utf8'));
    specs.set(tool.spec, text);
  }
  return {
    connectors,
    catalogTools: [...openApi.values()].map((entry) => entry.tool),
    specs,
    refusals,
  };
}

type ToolEndpoint =
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly names: readonly string[] }
  | { readonly kind: 'found'; readonly endpoint: NonNullable<PortableProject['toolEndpoint']> };

/**
 * The public MCP tool endpoint of the root agent: the one live `mcp-project` client that publishes
 * it, with its key referenced by `TOOL_ENDPOINT_<CLIENT>`; only the client's name is read, never a
 * key. `none` when there is no such client or no https origin, so the translators report the code
 * tools themselves; `ambiguous` when several clients publish it, because an export does not guess.
 */
export function toolEndpointOf(
  clients: readonly EndpointClientResource[],
  rootAgentId: string,
  origin: string | null,
): ToolEndpoint {
  if (origin === null || !origin.startsWith('https://')) return { kind: 'none' };
  const names = clients
    .filter(
      (client) =>
        client.kind === MCP_PROJECT_KIND &&
        client.revokedAt === null &&
        client.agentIds.includes(rootAgentId),
    )
    .map((client) => client.name)
    .sort();
  const [only, ...others] = names;
  if (only === undefined) return { kind: 'none' };
  if (others.length > 0) return { kind: 'ambiguous', names };
  return {
    kind: 'found',
    endpoint: {
      url: `${origin}/mcp/projects/${only}`,
      auth: { scheme: 'bearer', secretRef: secretNameOf('TOOL_ENDPOINT_', only) },
    },
  };
}

/**
 * The bodies that serve the root's subagents: each kebab name the root declares, resolved to the
 * `production` version of the agent of that name, else its `local` one. A name with no agent, no
 * pointer, a version named differently, or a version with subagents of its own (one level,
 * ADR-0133 D14) is `missing`, for the caller to refuse.
 */
async function subagentBodies(
  root: AgentVersionBody,
  versions: PortableProjectSources['versions'],
): Promise<{ readonly bodies: AgentVersionBody[]; readonly missing: string[] }> {
  const rootName = root.definition.agent.name;
  const names = (root.subagents ?? [])
    .map((subagent) => subagent.name)
    .filter((name) => NAME_KEY_PATTERN.test(name));
  const bodies: AgentVersionBody[] = [];
  const missing: string[] = [];
  if (names.length === 0) return { bodies, missing };
  const candidates = await versions.agentsByName(names);
  for (const name of names) {
    const candidate = candidates.get(name);
    const listing = candidate === undefined ? null : await versions.list(candidate.id);
    const pointers = listing?.pointers ?? [];
    const pointer =
      pointers.find((each) => each.environment === 'production') ??
      pointers.find((each) => each.environment === 'local');
    const record =
      candidate === undefined || pointer === undefined
        ? null
        : await versions.find(candidate.id, pointer.number);
    const body = record === null ? null : toAgentVersionResource(record).body;
    if (
      body === null ||
      name === rootName ||
      body.definition.agent.name !== name ||
      (body.subagents ?? []).length > 0
    ) {
      missing.push(name);
    } else {
      bodies.push(body);
    }
  }
  return { bodies, missing };
}

/** Why the skill `name` cannot be exported, or `null` when its tree can. */
function skillRefusal(name: string, files: readonly SkillFileListing[]): string | null {
  if (files.filter((file) => file.path === SKILL_MD_FILENAME).length !== 1) {
    return `the skill ${name} has no ${SKILL_MD_FILENAME} in this workspace`;
  }
  if (files.some((file) => !PortableRelativePathSchema.safeParse(file.path).success)) {
    return `the skill ${name} has a file whose path cannot be exported`;
  }
  return null;
}

/**
 * The project directory the loader reads, made of this workspace's resources: `skills/<name>/**`
 * is the skill's tree, a granted knowledge path is the workspace file at that path, and an OpenAPI
 * ref is the document already fetched for it. Stored versions have no `agents/*.agent.md`. Every
 * byte counts toward the cap: a skill by its listed sizes when it is listed, before any byte is
 * read (a dropped skill is never counted or read), a knowledge file as it is read, a document when
 * it is fetched.
 */
function virtualProject(
  sources: PortableProjectSources,
  knowledgePaths: ReadonlySet<string>,
  skillReasons: Map<string, string>,
  specs: ReadonlyMap<string, string>,
  reserve: (bytes: number) => void,
): PortableProjectSource {
  const listed = new Map<string, SkillFileListing>();
  const counted = new Set<string>();
  return {
    listFiles: async (directory) => {
      if (!directory.startsWith(SKILLS_DIRECTORY)) return [];
      const name = directory.slice(SKILLS_DIRECTORY.length);
      const files = await sources.skillFiles(name);
      const refusal = skillRefusal(name, files);
      if (refusal !== null) {
        skillReasons.set(name, refusal);
        return [];
      }
      if (!counted.has(name)) {
        counted.add(name);
        reserve(files.reduce((sum, file) => sum + file.sizeBytes, 0));
      }
      return files.map((file) => {
        const path = `${directory}/${file.path}`;
        listed.set(path, file);
        return path;
      });
    },
    readFile: async (path) => {
      const spec = specs.get(path);
      if (spec !== undefined) return new TextEncoder().encode(spec);
      const skillFile = listed.get(path);
      if (skillFile !== undefined) return skillFile.read();
      if (!knowledgePaths.has(path)) return null;
      const bytes = await sources.workspaceFile(path);
      if (bytes !== null) reserve(bytes.byteLength);
      return bytes;
    },
  };
}

/**
 * The project for version `version` of `agentId`: the one agent, its subagents, its remote MCP
 * connectors, skills and knowledge files, and the tool endpoint that publishes it. `ok: false`
 * carries the refusal to answer: an unknown version, a name a portable agent cannot carry, or a
 * subagent this workspace cannot serve.
 */
export async function buildPortableProject(
  agentId: string,
  version: number,
  sources: PortableProjectSources,
): Promise<PortableProjectOutcome> {
  const record = await sources.versions.find(agentId, version);
  if (record === null) return { ok: false, result: agentVersionNotFound(version) };

  const { body } = toAgentVersionResource(record);
  const name = body.definition.agent.name;
  if (!NAME_KEY_PATTERN.test(name)) {
    return {
      ok: false,
      result: problem(
        PLATFORM_EXPORT_PROBLEM_CODES.agent_name_not_portable,
        'agent_name_not_portable',
        'The agent name must be lower-case kebab (1-64 characters) to be exported; rename the agent and save a new version.',
      ),
    };
  }

  const subagents = await subagentBodies(body, sources.versions);
  if (subagents.missing.length > 0) {
    return {
      ok: false,
      result: problem(
        PLATFORM_EXPORT_PROBLEM_CODES.platform_agent_not_found,
        'platform_agent_not_found',
        'A subagent is not an agent of the project.',
        subagents.missing.map((missing) => `${name}.subagents.${missing}`),
      ),
    };
  }
  const bodies = [body, ...subagents.bodies];
  const bodyOf = new Map(bodies.map((each) => [each.definition.agent.name, each]));

  let total = 0;
  const reserve = (bytes: number): void => {
    total += bytes;
    if (total > PLATFORM_EXPORT_MAX_BYTES) throw new PlatformExportTooLargeError(total);
  };
  const { connectors, catalogTools, specs, refusals } = await connectorContext(
    bodies,
    sources.connectors,
    reserve,
  );
  const endpoint = toolEndpointOf(await sources.endpointClients(), agentId, sources.publicOrigin);
  const knowledgePaths = new Set(
    bodies.flatMap((each) =>
      (each.knowledge ?? []).flatMap((source) => (source.kind === 'files' ? source.paths : [])),
    ),
  );
  const skillReasons = new Map<string, string>();

  const loaded = await loadPortableProject({
    project: { connectors, models: {} },
    bodies,
    catalogTools,
    root: name,
    source: virtualProject(sources, knowledgePaths, skillReasons, specs, reserve),
    ...(endpoint.kind === 'found' ? { toolEndpoint: endpoint.endpoint } : {}),
  });

  // The loader names a drop by agent and index; the refusal that caused it is keyed by connector or skill.
  const report = loaded.dropped.map((drop) => {
    const [agent = '', ...rest] = drop.path.split('.');
    const path = rest.join('.');
    const connectorAt = CONNECTOR_DROP_PATH.exec(path)?.[1];
    const connectorName =
      connectorAt === undefined
        ? undefined
        : bodyOf.get(agent)?.definition.resources.connectors[Number(connectorAt)];
    const skillName = SKILL_DROP_PATH.test(path)
      ? SKILL_DROP_REASON.exec(drop.reason)?.[1]
      : undefined;
    const reason =
      (connectorName === undefined ? undefined : refusals.get(connectorName)) ??
      (skillName === undefined ? undefined : skillReasons.get(skillName)) ??
      drop.reason;
    return dropped(`agents.${drop.path}`, reason);
  });
  // The loader skips a granted knowledge file the workspace no longer has; report it, never claim it.
  const carried = new Set(loaded.project.knowledgeFiles.map((file) => file.path));
  for (const each of bodies) {
    (each.knowledge ?? []).forEach((source, index) => {
      if (source.kind !== 'files') return;
      for (const path of source.paths.filter((granted) => !carried.has(granted))) {
        report.push(
          dropped(
            `agents.${each.definition.agent.name}.knowledge.${index}`,
            `the knowledge file ${path} is not in this workspace`,
          ),
        );
      }
    });
  }
  if (endpoint.kind === 'ambiguous') {
    report.push(
      dropped(
        'toolEndpoint',
        `the tool endpoint clients ${endpoint.names.join(', ')} all publish this agent; revoke or unlink all but one and export again`,
      ),
    );
  }
  return { ok: true, project: loaded.project, dropped: report };
}
