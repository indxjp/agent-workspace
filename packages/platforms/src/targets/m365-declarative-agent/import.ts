import { AGENT_PERMISSION_KEYS } from '@indx-workspace/contracts/agents';
import type {
  FieldVerdict,
  PlatformDropCode,
  PlatformFile,
} from '@indx-workspace/contracts/platforms';
import {
  PORTABLE_AGENT_API_VERSION,
  PORTABLE_AGENT_DESCRIPTION_MAX_LENGTH,
  PORTABLE_AGENT_KIND,
  PortableKnowledgeSourceSchema,
  PortableProjectSchema,
  PortableRelativePathSchema,
  PortableToolNameSchema,
  PortableToolSchema,
} from '@indx-workspace/contracts/portable-agent';
import type { z } from 'zod';

import { dropped, mapped, native } from '../../paths.js';
import type { PlatformImportResult } from '../../port.js';
import { M365_DECLARATIVE_AGENT_ID } from './compile.js';
import { M365DeclarativeAgentOptionsSchema } from './options.js';
import {
  ImportedAppManifestSchema,
  ImportedDeclarativeAgentSchema,
  ImportedPluginSchema,
  type ImportedDeclarativeAgent,
} from './vendor-schema.js';

const APP_PACKAGE = 'appPackage/';
const NAME_MAX = 64;
const KEY_ECHO_MAX = 64;
const INSTRUCTION_FILE = /^\$\[file\((['"])(.+)\1\)\]$/u;
const PLACEHOLDER = /\$\{\{[^}]*\}\}/gu;
const HANDLED_AGENT_KEYS = new Set([
  '$schema',
  'version',
  'name',
  'description',
  'instructions',
  'capabilities',
  'conversation_starters',
  'actions',
  'behavior_overrides',
  'disclaimer',
]);
const HANDLED_OVERRIDE_KEYS = new Set(['default_response_mode', 'special_instructions']);
/** Capabilities that ground the agent in tenant data; any other unhandled one is a builtin. */
const KNOWLEDGE_CAPABILITIES = new Set([
  'OneDriveAndSharePoint',
  'GraphConnectors',
  'Dataverse',
  'Email',
  'TeamsMessages',
  'People',
  'Meetings',
]);

/** Raised for a file the import cannot go on without; the details name paths and fields, never content. */
class ImportRefusal extends Error {
  readonly details: readonly string[];

  constructor(message: string, details: readonly string[]) {
    super(message);
    this.details = details;
  }
}

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly missing: boolean; readonly error: string };

const decoder = new TextDecoder('utf-8', { fatal: true });

function textOf(files: readonly PlatformFile[], path: string): string | undefined {
  const content = files.find((file) => file.path === path)?.content;
  if (content === undefined || typeof content === 'string') return content;
  try {
    return decoder.decode(content);
  } catch {
    return undefined;
  }
}

function parseJson<S extends z.ZodType>(
  files: readonly PlatformFile[],
  path: string,
  schema: S,
): Parsed<z.infer<S>> {
  const text = textOf(files, path);
  if (text === undefined) {
    return {
      ok: false,
      missing: !files.some((file) => file.path === path),
      error: `${path} cannot be read`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, missing: false, error: `${path} is not valid JSON` };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'))];
  return {
    ok: false,
    missing: false,
    error: `${path} does not have the expected shape (${fields.slice(0, 5).join(', ')})`,
  };
}

/** A path from a manifest, resolved against `base` (a directory ending in `/`, or `''`); undefined when it could leave the package. */
function inPackage(base: string, reference: string): string | undefined {
  const path = `${base}${reference}`;
  return PortableRelativePathSchema.safeParse(path).success ? path : undefined;
}

/** The directory of a file path, ending in `/`, or `''` at the root. */
function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/') + 1);
}

function slugify(name: string): string {
  const slug = name
    .replaceAll(PLACEHOLDER, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .slice(0, NAME_MAX)
    .replaceAll(/^-+|-+$/gu, '');
  return slug === '' ? 'agent' : slug;
}

function extraKeys(value: object, handled: ReadonlySet<string>): readonly string[] {
  return Object.keys(value)
    .filter((key) => !handled.has(key))
    .map((key) => key.slice(0, KEY_ECHO_MAX));
}

interface PluginTool {
  readonly tool: unknown;
  readonly spec?: { readonly ref: string; readonly content: string };
  readonly authenticated: boolean;
}

/** The portable tool for one plugin runtime, or the reason there is none. */
function toolOfPlugin(
  files: readonly PlatformFile[],
  pluginFile: string,
  id: string,
  plugin: z.infer<typeof ImportedPluginSchema>,
): PluginTool | string {
  const runtime = plugin.runtimes?.[0];
  const url = runtime?.spec?.url;
  if (runtime === undefined || url === undefined)
    return 'the plugin has no runtime with a spec url';
  const authenticated = runtime.auth !== undefined && runtime.auth.type !== 'None';
  if (runtime.type === 'RemoteMCPServer') {
    return { tool: { kind: 'mcp', name: id, transport: 'streamable-http', url }, authenticated };
  }
  if (runtime.type !== 'OpenApi')
    return 'only RemoteMCPServer and OpenApi runtimes have a portable form';
  const tool = { kind: 'openapi', name: id, specRef: url };
  if (url.startsWith('https://')) return { tool, authenticated };
  const specPath = inPackage(directoryOf(pluginFile), url);
  const content = specPath === undefined ? undefined : textOf(files, specPath);
  if (content === undefined) return 'the OpenAPI document is not in the app package';
  return { tool, spec: { ref: url, content }, authenticated };
}

interface Draft {
  readonly tools: unknown[];
  readonly knowledge: unknown[];
  readonly openapiSpecs: { ref: string; content: string }[];
  readonly report: FieldVerdict[];
}

type At = (pointer: string) => string;

function readEmbeddedKnowledge(
  files: readonly PlatformFile[],
  agentDirectory: string,
  capability: NonNullable<ImportedDeclarativeAgent['capabilities']>[number],
  path: string,
  { knowledge, report }: Draft,
): void {
  const entries = capability.files ?? [];
  if (entries.length === 0) {
    report.push(dropped(path, 'knowledge_unsupported', 'EmbeddedKnowledge lists no files'));
    return;
  }
  const paths: string[] = [];
  entries.forEach((entry, fileIndex) => {
    const filePath = inPackage(agentDirectory, entry.file);
    const present = filePath !== undefined && files.some((file) => file.path === filePath);
    if (present) paths.push(filePath);
    report.push(
      present
        ? mapped(`${path}/files/${fileIndex}`, 'an embedded file is a files knowledge source')
        : dropped(
            `${path}/files/${fileIndex}`,
            'knowledge_unsupported',
            'the embedded file is not in the package or its path could leave it',
          ),
    );
  });
  if (paths.length > 0) knowledge.push({ kind: 'files', paths });
}

function readCapabilities(
  files: readonly PlatformFile[],
  agentDirectory: string,
  da: ImportedDeclarativeAgent,
  at: At,
  draft: Draft,
): void {
  const { tools, knowledge, report } = draft;
  da.capabilities?.forEach((capability, index) => {
    const path = at(`capabilities/${index}`);
    if (capability.name === 'CodeInterpreter') {
      tools.push({ kind: 'builtin', id: 'code_execution' });
      report.push(native(path, 'code_execution builtin'));
    } else if (capability.name === 'WebSearch' && (capability.sites ?? []).length === 0) {
      tools.push({ kind: 'builtin', id: 'web_search' });
      report.push(native(path, 'web_search builtin'));
    } else if (capability.name === 'WebSearch') {
      (capability.sites ?? []).forEach((site, siteIndex) => {
        const sitePath = `${path}/sites/${siteIndex}`;
        const source = PortableKnowledgeSourceSchema.safeParse({ kind: 'url', url: site.url });
        if (source.success) knowledge.push(source.data);
        report.push(
          source.success
            ? mapped(sitePath, 'a site of WebSearch is a url knowledge source')
            : dropped(sitePath, 'knowledge_unsupported', 'a WebSearch site is not an https URL'),
        );
      });
    } else if (capability.name === 'EmbeddedKnowledge') {
      readEmbeddedKnowledge(files, agentDirectory, capability, path, draft);
    } else if (KNOWLEDGE_CAPABILITIES.has(capability.name)) {
      report.push(
        dropped(path, 'knowledge_unsupported', 'a Microsoft 365 data source is a tenant object'),
      );
    } else {
      report.push(dropped(path, 'builtin_unsupported', 'the capability has no portable builtin'));
    }
  });
}

function readActions(
  files: readonly PlatformFile[],
  agentDirectory: string,
  da: ImportedDeclarativeAgent,
  at: At,
  { tools, openapiSpecs, report }: Draft,
): void {
  const toolNames = new Set<string>();
  da.actions?.forEach((action, index) => {
    const path = at(`actions/${index}`);
    const drop = (reason: string, code: PlatformDropCode = 'field_unsupported'): void => {
      report.push(dropped(path, code, reason));
    };
    const pluginFile = inPackage(agentDirectory, action.file);
    if (!PortableToolNameSchema.safeParse(action.id).success) {
      return drop('the action id is not a valid tool name');
    }
    if (toolNames.has(action.id.toLowerCase())) return drop('another action has this id');
    if (pluginFile === undefined) return drop('the action file path could leave the app package');
    const plugin = parseJson(files, pluginFile, ImportedPluginSchema);
    if (!plugin.ok) return drop(plugin.error);
    if (plugin.value.runtimes?.[0]?.type === 'LocalPlugin') {
      return drop(
        'a LocalPlugin runs on the device and has no portable form',
        'builtin_unsupported',
      );
    }
    const found = toolOfPlugin(files, pluginFile, action.id, plugin.value);
    if (typeof found === 'string') return drop(found);
    const tool = PortableToolSchema.safeParse(found.tool);
    if (!tool.success) return drop('the plugin url is not a usable URL (a placeholder?)');
    toolNames.add(action.id.toLowerCase());
    tools.push(tool.data);
    if (found.spec !== undefined) openapiSpecs.push(found.spec);
    report.push(
      found.authenticated
        ? mapped(path, 'the auth config is a tenant object and is not carried; register it again')
        : native(path, `${tool.data.kind} tool`),
    );
  });
}

function readExtraKeys(da: ImportedDeclarativeAgent, at: At, report: FieldVerdict[]): void {
  for (const key of extraKeys(da, HANDLED_AGENT_KEYS)) {
    report.push(
      dropped(
        at(key),
        key === 'worker_agents' ? 'subagents_unsupported' : 'field_unsupported',
        'the portable agent has no field for it',
      ),
    );
  }
  for (const key of extraKeys(da.behavior_overrides ?? {}, HANDLED_OVERRIDE_KEYS)) {
    report.push(
      dropped(
        at(`behavior_overrides/${key}`),
        'field_unsupported',
        'the portable agent has no field for it',
      ),
    );
  }
}

function readOptions(
  app: z.infer<typeof ImportedAppManifestSchema> | undefined,
  manifestFile: string,
  da: ImportedDeclarativeAgent,
  at: At,
  name: string,
  report: FieldVerdict[],
): Record<string, unknown> {
  const developer = app?.developer;
  const literal = (value: string | undefined): string | undefined =>
    value === undefined || value.includes('${{') ? undefined : value;
  const [devName, website, privacy, terms] = [
    literal(developer?.name),
    literal(developer?.websiteUrl),
    literal(developer?.privacyUrl),
    literal(developer?.termsOfUseUrl),
  ];
  const inManifest = (pointer: string): string => `${manifestFile}#/${pointer}`;
  // [option key, value, the source field it was read from]
  const candidates: readonly (readonly [string, unknown, string])[] = [
    ['appVersion', app?.version, inManifest('version')],
    ['accentColor', app?.accentColor, inManifest('accentColor')],
    [
      'developer',
      devName === undefined || website === undefined || privacy === undefined || terms === undefined
        ? undefined
        : { name: devName, websiteUrl: website, privacyUrl: privacy, termsOfUseUrl: terms },
      inManifest('developer'),
    ],
    [
      'conversationStarters',
      da.conversation_starters?.map((starter) => ({
        ...(starter.title === undefined ? {} : { title: starter.title }),
        text: starter.text,
      })),
      at('conversation_starters'),
    ],
    ['disclaimer', da.disclaimer?.text, at('disclaimer')],
    [
      'defaultResponseMode',
      da.behavior_overrides?.default_response_mode,
      at('behavior_overrides/default_response_mode'),
    ],
    [
      'discourageModelKnowledge',
      da.behavior_overrides?.special_instructions?.discourage_model_knowledge,
      at('behavior_overrides/special_instructions/discourage_model_knowledge'),
    ],
  ];
  const options: Record<string, unknown> = {};
  for (const [key, value, source] of candidates) {
    if (value === undefined) continue;
    if (M365DeclarativeAgentOptionsSchema.safeParse({ [key]: value }).success) options[key] = value;
    else
      report.push(
        dropped(source, 'field_unsupported', `${key} is not valid as an option of this target`),
      );
  }
  if (Object.keys(options).length > 0) {
    report.push(
      mapped(
        `${name}.extensions.platforms.${M365_DECLARATIVE_AGENT_ID}`,
        `kept as the options of this target: ${Object.keys(options).join(', ')}`,
      ),
    );
  }
  return options;
}

function importProject(files: readonly PlatformFile[]): PlatformImportResult {
  // A whole Agents Toolkit project keeps its package in appPackage/; a bare package is at the root.
  const base = [`${APP_PACKAGE}manifest.json`, `${APP_PACKAGE}declarativeAgent.json`].some((path) =>
    files.some((file) => file.path === path),
  )
    ? APP_PACKAGE
    : '';
  const manifestFile = `${base}manifest.json`;
  const manifest = parseJson(files, manifestFile, ImportedAppManifestSchema);
  if (!manifest.ok && !manifest.missing) {
    throw new ImportRefusal('The app manifest cannot be read.', [manifest.error]);
  }
  const app = manifest.ok ? manifest.value : undefined;
  const agentFile = inPackage(
    base,
    app?.copilotAgents?.declarativeAgents?.[0]?.file ?? 'declarativeAgent.json',
  );
  if (agentFile === undefined) {
    throw new ImportRefusal('The app manifest points at an unusable declarative agent path.', [
      `${manifestFile}: copilotAgents.declarativeAgents.0.file`,
    ]);
  }
  const parsedAgent = parseJson(files, agentFile, ImportedDeclarativeAgentSchema);
  if (!parsedAgent.ok) {
    throw new ImportRefusal('The declarative agent manifest cannot be read.', [parsedAgent.error]);
  }
  const da = parsedAgent.value;
  const agentDirectory = directoryOf(agentFile);
  const at = (pointer: string): string => `${agentFile}#/${pointer}`;

  const fromFile = INSTRUCTION_FILE.exec(da.instructions)?.[2];
  const instructionFile = fromFile === undefined ? undefined : inPackage(agentDirectory, fromFile);
  const inlined = instructionFile === undefined ? undefined : textOf(files, instructionFile);
  // A missing instruction file keeps the reference, so a re-compile emits it again.
  const referenceKept = fromFile !== undefined && (inlined === undefined || inlined.trim() === '');
  const instructions = inlined === undefined || referenceKept ? da.instructions : inlined;

  const name = slugify(da.name);
  const description = [name === da.name ? undefined : da.name, da.description]
    .filter((part) => part !== undefined && part !== '')
    .join(': ')
    .slice(0, PORTABLE_AGENT_DESCRIPTION_MAX_LENGTH);
  const report: FieldVerdict[] = [
    name === da.name
      ? native(at('name'), 'agent name')
      : mapped(
          at('name'),
          `used as the lower-case kebab agent name ${name}; the original is kept in the description`,
        ),
    fromFile === undefined
      ? native(at('instructions'), 'agent instructions')
      : referenceKept
        ? mapped(
            at('instructions'),
            'the instruction file is not in the package; the reference is kept',
          )
        : native(at('instructions'), 'read from the instruction file'),
    mapped(`${name}.model`, 'set model before running on an engine'),
  ];
  const draft: Draft = { tools: [], knowledge: [], openapiSpecs: [], report };
  readCapabilities(files, agentDirectory, da, at, draft);
  readActions(files, agentDirectory, da, at, draft);
  readExtraKeys(da, at, report);
  const options = readOptions(app, manifestFile, da, at, name, report);

  const project = PortableProjectSchema.safeParse({
    root: name,
    agents: [
      {
        apiVersion: PORTABLE_AGENT_API_VERSION,
        kind: PORTABLE_AGENT_KIND,
        name,
        ...(description === '' ? {} : { description }),
        instructions,
        permissions: Object.fromEntries(AGENT_PERMISSION_KEYS.map((key) => [key, false])),
        tools: draft.tools,
        knowledge: draft.knowledge,
        ...(Object.keys(options).length === 0
          ? {}
          : { extensions: { platforms: { [M365_DECLARATIVE_AGENT_ID]: options } } }),
      },
    ],
    openapiSpecs: draft.openapiSpecs,
  });
  if (!project.success) {
    const fields = [
      ...new Set(project.error.issues.map((issue) => issue.path.join('.') || '(root)')),
    ];
    throw new ImportRefusal(
      'The declarative agent does not fit the portable agent format.',
      fields.slice(0, 8),
    );
  }
  return { ok: true, project: project.data, report };
}

/**
 * Reads an Agents Toolkit project (or the contents of its `appPackage/` at the root) back into a
 * portable project: the declarative agent the app manifest points at, its instructions,
 * `WebSearch`, `CodeInterpreter` and `EmbeddedKnowledge`, the RemoteMCPServer and OpenApi plugins it
 * acts through (with the OpenAPI documents the package bundles) and the settings this target keeps
 * as options. References resolve against the directory of the document that holds them. Everything
 * else is reported as dropped.
 * Pure. Refuses with `platform_agent_not_found` when no agent can be read; a refusal names paths and
 * fields, never file content.
 */
export function importM365DeclarativeAgent(files: readonly PlatformFile[]): PlatformImportResult {
  try {
    return importProject(files);
  } catch (error) {
    if (!(error instanceof ImportRefusal)) throw error;
    return {
      ok: false,
      refusal: { code: 'platform_agent_not_found', message: error.message, details: error.details },
    };
  }
}
