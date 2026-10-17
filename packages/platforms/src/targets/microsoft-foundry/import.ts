import {
  PlatformFileSchema,
  type FieldVerdict,
  type PlatformFile,
  type PlatformRefusal,
} from '@indx-workspace/contracts/platforms';
import {
  PORTABLE_AGENT_API_VERSION,
  PORTABLE_AGENT_KIND,
  PortableModelSchema,
  PortableNameSchema,
  PortableProjectSchema,
  PortableToolSchema,
  type PortableAgentInput,
} from '@indx-workspace/contracts/portable-agent';
import { z } from 'zod';

import { dropped, mapped, native } from '../../paths.js';
import type { PlatformImportResult } from '../../port.js';
import { A2A_CONNECTION_PREFIX, TOOL_ENDPOINT_LABEL, fitConnectionName } from './compile.js';
import {
  FOUNDRY_IMPORT_TOOL_SCHEMAS,
  FoundryAgentVersionImportSchema,
  type FoundryAgentVersionImport,
} from './wire.js';

const MAX_FILES = 10_000;
const DETAILS_MAX = 64;
const PLAN_PATH = 'project.plan.json';
const VERSION_SUFFIX = '.version.json';
const ENDPOINT_SUFFIX = '.endpoint.json';
const PlanRootSchema = z.looseObject({ root: PortableNameSchema });
const VENDOR_VERSION_OBJECT = 'agent.version';
const NO_PERMISSIONS = {
  readFiles: false,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
} as const;

type Refusal = Extract<PlatformImportResult, { ok: false }>;
type ImportedTool = NonNullable<PortableAgentInput['tools']>[number];
type VendorTool = NonNullable<FoundryAgentVersionImport['definition']['tools']>[number];

interface VersionFile {
  readonly path: string;
  readonly name: string;
  readonly body: FoundryAgentVersionImport;
}

interface MappedTool {
  readonly tool?: ImportedTool;
  readonly subagent?: string;
  readonly verdict: FieldVerdict;
}

function refuse(code: PlatformRefusal['code'], message: string, details: string[]): Refusal {
  return { ok: false, refusal: { code, message, details: details.slice(0, DETAILS_MAX) } };
}

/** Zod issue paths only: a message or a value could carry file content. */
function issuePaths(file: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => `${file}: ${issue.path.join('.') || '(document)'}`);
}

function readJson(
  file: PlatformFile,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  let text: string;
  try {
    text =
      typeof file.content === 'string'
        ? file.content
        : new TextDecoder('utf-8', { fatal: true }).decode(file.content);
  } catch {
    return { ok: false, reason: 'is not valid UTF-8' };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'is not valid JSON' };
  }
}

function isVendorVersion(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'object' in value &&
    value.object === VENDOR_VERSION_OBJECT
  );
}

function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.endsWith(VERSION_SUFFIX) ? base.slice(0, -VERSION_SUFFIX.length) : base.slice(0, -5);
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** The imported agent an `aw-agent-<name>` a2a tool points at, when there is one. */
function a2aTargetOf(tool: VendorTool, names: ReadonlySet<string>): string | undefined {
  if (tool.type !== 'a2a') return undefined;
  const id = FOUNDRY_IMPORT_TOOL_SCHEMAS.a2a.safeParse(tool).data?.project_connection_id;
  if (id === undefined) return undefined;
  for (const name of names) {
    if (id === fitConnectionName(`${A2A_CONNECTION_PREFIX}${name}`)) return name;
  }
  return undefined;
}

function accept(candidate: unknown, verdict: FieldVerdict, path: string): MappedTool {
  const tool = PortableToolSchema.safeParse(candidate);
  return tool.success
    ? { tool: tool.data, verdict }
    : {
        verdict: dropped(path, 'field_unsupported', 'does not fit a portable tool; not imported'),
      };
}

function mapMcp(tool: VendorTool, path: string): MappedTool {
  const parsed = FOUNDRY_IMPORT_TOOL_SCHEMAS.mcp.safeParse(tool);
  if (!parsed.success) {
    return {
      verdict: dropped(
        path,
        'field_unsupported',
        'an MCP tool needs a server_label and server_url',
      ),
    };
  }
  const { server_label: label, server_url: url, project_connection_id: connection } = parsed.data;
  if (label === TOOL_ENDPOINT_LABEL) {
    return {
      verdict: dropped(
        path,
        'field_unsupported',
        `the shared ${TOOL_ENDPOINT_LABEL} server is not rebuilt into code tools from its URL`,
      ),
    };
  }
  return accept(
    { kind: 'mcp', name: label, transport: 'streamable-http', url },
    connection === undefined
      ? native(path, 'remote MCP server')
      : mapped(
          path,
          `credential not imported: set auth.secretRef (project connection ${connection})`,
        ),
    path,
  );
}

function mapOpenApi(tool: VendorTool, path: string): MappedTool {
  const parsed = FOUNDRY_IMPORT_TOOL_SCHEMAS.openapi.safeParse(tool);
  if (!parsed.success) {
    return {
      verdict: dropped(path, 'field_unsupported', 'an OpenAPI tool needs a name and a spec'),
    };
  }
  const { name, spec } = parsed.data.openapi;
  const ref = spec['$ref'];
  if (typeof ref !== 'string') {
    return {
      verdict: dropped(
        path,
        'field_unsupported',
        'an inline spec has no portable form; save it and reference it as specRef',
      ),
    };
  }
  return accept(
    { kind: 'openapi', name, specRef: ref },
    mapped(path, 'the spec $ref is kept; bundle the spec and set auth.secretRef by hand'),
    path,
  );
}

function mapFileSearch(tool: VendorTool, path: string): MappedTool {
  const parsed = FOUNDRY_IMPORT_TOOL_SCHEMAS.file_search.safeParse(tool);
  const ids = parsed.data?.vector_store_ids ?? parsed.data?.file_search?.vector_store_ids ?? [];
  return {
    verdict: dropped(
      path,
      'knowledge_unsupported',
      ids.length === 0
        ? 'a vector store has no portable form; upload the files as knowledge'
        : `vector store ${ids.join(', ')} has no portable form; upload the files as knowledge`,
    ),
  };
}

function mapA2a(
  tool: VendorTool,
  path: string,
  agent: string,
  isRoot: boolean,
  names: ReadonlySet<string>,
): MappedTool {
  const target = a2aTargetOf(tool, names);
  if (target === undefined || target === agent) {
    return {
      verdict: dropped(
        path,
        'subagents_unsupported',
        `the project connection is not an ${A2A_CONNECTION_PREFIX}<name> of another imported agent`,
      ),
    };
  }
  if (!isRoot) {
    return {
      verdict: dropped(
        path,
        'subagents_unsupported',
        'only the root agent keeps its subagents (one level only)',
      ),
    };
  }
  return {
    subagent: target,
    verdict: mapped(
      path,
      `subagent ${target}, from the project connection ${fitConnectionName(`${A2A_CONNECTION_PREFIX}${target}`)}`,
    ),
  };
}

function mapTool(
  tool: VendorTool,
  path: string,
  agent: string,
  isRoot: boolean,
  names: ReadonlySet<string>,
): MappedTool {
  switch (tool.type) {
    case 'web_search':
      return { tool: { kind: 'builtin', id: 'web_search' }, verdict: native(path, 'web search') };
    case 'code_interpreter':
      return {
        tool: { kind: 'builtin', id: 'code_execution' },
        verdict: native(path, 'code execution'),
      };
    case 'mcp':
      return mapMcp(tool, path);
    case 'openapi':
      return mapOpenApi(tool, path);
    case 'file_search':
      return mapFileSearch(tool, path);
    case 'a2a':
      return mapA2a(tool, path, agent, isRoot, names);
    default:
      return {
        verdict: dropped(path, 'builtin_unsupported', `the ${tool.type} tool has no portable form`),
      };
  }
}

/**
 * `aw.model` (`provider/id`, or an id that may itself hold a `/`) when it is a portable model, else
 * the deployment name.
 */
function mapModel(version: VersionFile): {
  model?: PortableAgentInput['model'];
  verdict: FieldVerdict;
} {
  const path = `${version.name}.model`;
  const label = version.body.metadata?.['aw.model'];
  if (typeof label === 'string') {
    const slash = label.indexOf('/');
    const split =
      slash < 0
        ? undefined
        : PortableModelSchema.safeParse({
            provider: label.slice(0, slash),
            id: label.slice(slash + 1),
          });
    const model = split?.success ? split : PortableModelSchema.safeParse({ id: label });
    if (model.success)
      return { model: model.data, verdict: mapped(path, 'restored from metadata aw.model') };
  }
  const model = PortableModelSchema.safeParse({ id: version.body.definition.model });
  return model.success
    ? {
        model: model.data,
        verdict: mapped(path, 'the Foundry deployment name, not a model id; check it'),
      }
    : { verdict: dropped(path, 'field_unsupported', 'the deployment name is not a model id') };
}

function mapAgent(
  version: VersionFile,
  isRoot: boolean,
  names: ReadonlySet<string>,
): { agent: PortableAgentInput; report: FieldVerdict[] } {
  const { name, body } = version;
  const model = mapModel(version);
  const mappedTools = (body.definition.tools ?? []).map((tool, index) =>
    mapTool(tool, `${name}.tools.${index}`, name, isRoot, names),
  );
  const subagents = [...new Set(mappedTools.flatMap(({ subagent }) => subagent ?? []))];
  const description = body.description ?? '';
  return {
    agent: {
      apiVersion: PORTABLE_AGENT_API_VERSION,
      kind: PORTABLE_AGENT_KIND,
      name,
      ...(description === '' ? {} : { description }),
      instructions: body.definition.instructions ?? '',
      ...(model.model === undefined ? {} : { model: model.model }),
      permissions: NO_PERMISSIONS,
      tools: mappedTools.flatMap(({ tool }) => tool ?? []),
      subagents: subagents.map((subagent) => ({ name: subagent })),
    },
    report: [
      ...(description === '' ? [] : [native(`${name}.description`, 'description')]),
      native(`${name}.instructions`, 'definition.instructions'),
      model.verdict,
      ...mappedTools.map(({ verdict }) => verdict),
    ],
  };
}

/** `plan` is the parsed `project.plan.json` when there is one; its `root` is unset if unreadable. */
function chooseRoot(
  versions: readonly VersionFile[],
  names: ReadonlySet<string>,
  plan: { readonly root: string | undefined } | undefined,
): { root: string; report: FieldVerdict[] } {
  if (plan?.root !== undefined && names.has(plan.root)) return { root: plan.root, report: [] };
  const linked = new Set(
    versions.flatMap(({ body }) =>
      (body.definition.tools ?? []).flatMap((tool) => a2aTargetOf(tool, names) ?? []),
    ),
  );
  const unlinked = versions.filter(({ name }) => !linked.has(name));
  const candidates = unlinked.length > 0 ? unlinked : versions;
  const [first] = candidates;
  const notes = [
    ...(plan === undefined
      ? []
      : [`the root in ${PLAN_PATH} is not readable or not an imported agent`]),
    ...(candidates.length === 1
      ? []
      : [`${candidates.length} agents could be the root; the first by file path was chosen`]),
  ];
  return {
    root: first?.name ?? '',
    report: notes.length === 0 ? [] : [mapped('import.root', notes.join('; '))],
  };
}

/**
 * Best-effort import of Foundry agent versions: the `*.version.json` files this target emits or a
 * `GET .../versions/{v}` response saved as JSON. `project.plan.json` only names the root. A file
 * that is not valid refuses the import; a tool with no portable equivalent is reported dropped.
 */
export function importFoundry(files: readonly PlatformFile[]): PlatformImportResult {
  const checked = z.array(PlatformFileSchema).max(MAX_FILES).safeParse(files);
  if (!checked.success) {
    return refuse(
      'platform_options_invalid',
      'The files are not valid.',
      issuePaths('files', checked.error),
    );
  }

  const problems: string[] = [];
  const versions: VersionFile[] = [];
  let plan: { root: string | undefined } | undefined;
  for (const file of [...checked.data].sort(byPath)) {
    if (!file.path.endsWith('.json') || file.path.endsWith(ENDPOINT_SUFFIX)) continue;
    const json = readJson(file);
    if (file.path === PLAN_PATH) {
      // Only the root is read, so a plan from another version of this target still names it.
      const parsed = json.ok ? PlanRootSchema.safeParse(json.value) : undefined;
      plan = { root: parsed?.success ? parsed.data.root : undefined };
      continue;
    }
    const isVersion = file.path.endsWith(VERSION_SUFFIX);
    if (!json.ok) {
      if (isVersion) problems.push(`${file.path}: ${json.reason}`);
      continue;
    }
    if (!isVersion && !isVendorVersion(json.value)) continue;
    const body = FoundryAgentVersionImportSchema.safeParse(json.value);
    if (!body.success) {
      problems.push(...issuePaths(file.path, body.error));
      continue;
    }
    if (body.data.definition.kind !== 'prompt') {
      problems.push(`${file.path}: definition.kind`);
      continue;
    }
    const name = body.data.name ?? stemOf(file.path);
    if (!PortableNameSchema.safeParse(name).success) {
      problems.push(`${file.path}: name`);
      continue;
    }
    versions.push({ path: file.path, name, body: body.data });
  }
  if (problems.length > 0) {
    return refuse('platform_options_invalid', 'The agent versions cannot be imported.', problems);
  }
  if (versions.length === 0) {
    return refuse('platform_agent_not_found', 'The files hold no Foundry agent version.', []);
  }

  const names = new Set(versions.map(({ name }) => name));
  const { root, report: rootReport } = chooseRoot(versions, names, plan);
  const mappedAgents = [
    ...versions.filter(({ name }) => name === root),
    ...versions.filter(({ name }) => name !== root),
  ].map((version) => mapAgent(version, version.name === root, names));

  const project = PortableProjectSchema.safeParse({
    root,
    agents: mappedAgents.map(({ agent }) => agent),
  });
  if (!project.success) {
    return refuse(
      'platform_options_invalid',
      'The agent versions are not a valid project.',
      issuePaths('project', project.error),
    );
  }
  return {
    ok: true,
    project: project.data,
    report: [...rootReport, ...mappedAgents.flatMap(({ report }) => report)],
  };
}
