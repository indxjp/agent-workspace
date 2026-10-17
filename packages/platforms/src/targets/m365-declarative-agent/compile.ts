import { AGENT_PERMISSION_KEYS } from '@indx-workspace/contracts/agents';
import type {
  FieldVerdict,
  PlatformFile,
  PlatformId,
  PlatformRefusal,
} from '@indx-workspace/contracts/platforms';
import type { PortableAgent, PortableProject } from '@indx-workspace/contracts/portable-agent';
import type { z } from 'zod';

import { narrowOpenApiSpec } from '../../openapi-allow.js';
import { dropped, mapped, native, portableFieldPaths } from '../../paths.js';
import type { PlatformCompileResult } from '../../port.js';
import {
  decodeBase64,
  PLACEHOLDER_COLOR_ICON_PNG_BASE64,
  PLACEHOLDER_OUTLINE_ICON_PNG_BASE64,
} from './icons.js';
import type { M365DeclarativeAgentOptions } from './options.js';
import {
  APP_MANIFEST_SCHEMA_URL,
  AppManifestSchema,
  DECLARATIVE_AGENT_SCHEMA_URL,
  DeclarativeAgentManifestV18Schema,
  PLUGIN_SCHEMA_URL,
  PluginManifestV24Schema,
  type AppManifest,
  type DeclarativeAgentManifestV18,
  type PluginManifestV24,
} from './vendor-schema.js';

export const M365_DECLARATIVE_AGENT_ID = 'm365-declarative-agent' satisfies PlatformId;

const INSTRUCTIONS_MAX = 8_000;
const DESCRIPTION_MAX = 1_000;
const ACTIONS_MAX = 10;
const SHORT_NAME_MAX = 30;
const SHORT_DESCRIPTION_MAX = 80;
const WEB_SEARCH_SITES_MAX = 4;
const WEB_SEARCH_SITE_SEGMENTS_MAX = 2;
const NOTE_MAX = 1_024;
const CODE_TOOLS_PLUGIN = 'aw-tools';
const DEVELOPER_VARIABLES = [
  'DEVELOPER_NAME',
  'DEVELOPER_WEBSITE_URL',
  'DEVELOPER_PRIVACY_URL',
  'DEVELOPER_TERMS_OF_USE_URL',
] as const;

type Tool = PortableAgent['tools'][number];
type RemoteMcpTool = Extract<Tool, { kind: 'mcp'; transport: 'streamable-http' | 'sse' }>;
type CodeTool = Extract<Tool, { kind: 'code' }>;
type OpenApiTool = Extract<Tool, { kind: 'openapi' }>;
type BuiltinTool = Extract<Tool, { kind: 'builtin' }>;
type Capability = NonNullable<DeclarativeAgentManifestV18['capabilities']>[number];

interface Plugin {
  /** The tool name made unique across plugin file names, namespaces and auth variables. It is also the action id. */
  readonly slug: string;
  readonly file: string;
  readonly manifest: PluginManifestV24;
  /** The `env/.env.dev` variable that holds the auth config id, when the plugin authenticates. */
  readonly authVariable?: string;
  /** The OpenAPI document bundled next to the plugin, as `appPackage/<file>`. */
  readonly spec?: { readonly file: string; readonly content: string };
}

interface MappedTool {
  readonly verdict: FieldVerdict;
  readonly plugin?: Plugin;
}

interface ToolContext {
  readonly project: PortableProject;
  readonly agent: PortableAgent;
  readonly firstCodeTool: number;
  /** Hands out `name` or, when another plugin already holds a colliding key, `name-2`, `name-3`, … */
  readonly claimSlug: (name: string) => string;
  /** The slug of the plugin that serves the code tools, claimed on first use. */
  readonly codeToolsSlug: () => string;
}

/** `${{NAME}}`: Agents Toolkit fills it from `env/.env.<env>` when it provisions. */
function placeholder(variable: string): string {
  return `\${{${variable}}}`;
}

function clip(note: string): string {
  return note.length > NOTE_MAX ? `${note.slice(0, NOTE_MAX - 1)}…` : note;
}

function authVariable(name: string): string {
  return `MCP_${name.toUpperCase().replaceAll('-', '_')}_AUTH_REFERENCE_ID`;
}

function namespaceOf(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9]/gu, '');
}

/**
 * Plugin names that stay distinct as file names (case-insensitive file systems), namespaces and
 * auth variables: `a-b`, `a_b` and `ab` would otherwise share a namespace, and `a-b` and `a_b` an
 * auth variable. The first claim keeps its name.
 */
function slugClaimer(): (name: string) => string {
  const taken = new Set<string>();
  return (name) => {
    const keys = (slug: string): readonly string[] => [
      slug.toLowerCase(),
      namespaceOf(slug).toLowerCase(),
      authVariable(slug),
    ];
    let slug = name;
    for (let n = 2; keys(slug).some((key) => taken.has(key)); n += 1) slug = `${name}-${n}`;
    for (const key of keys(slug)) taken.add(key);
    return slug;
  };
}

function renamedNote(slug: string, name: string): string {
  return `emitted as ${slug}: ${name} collides with another plugin's file name, namespace or auth variable`;
}

function refuse(
  code: PlatformRefusal['code'],
  message: string,
  details: readonly string[],
): PlatformCompileResult {
  return { ok: false, refusal: { code, message, details } };
}

function remotePlugin(input: {
  readonly slug: string;
  readonly name: string;
  readonly descriptionForHuman: string;
  readonly descriptionForModel?: string;
  readonly url: string;
  readonly authenticated: boolean;
}): Plugin {
  const variable = authVariable(input.slug);
  return {
    slug: input.slug,
    file: `ai-plugin.${input.slug}.json`,
    manifest: {
      $schema: PLUGIN_SCHEMA_URL,
      schema_version: 'v2.4',
      name_for_human: input.name,
      namespace: namespaceOf(input.slug),
      description_for_human: input.descriptionForHuman,
      ...(input.descriptionForModel === undefined
        ? {}
        : { description_for_model: input.descriptionForModel }),
      functions: [],
      runtimes: [
        {
          type: 'RemoteMCPServer',
          auth: input.authenticated
            ? { type: 'OAuthPluginVault', reference_id: placeholder(variable) }
            : { type: 'None' },
          run_for_functions: ['*'],
          spec: { url: input.url },
        },
      ],
    },
    ...(input.authenticated ? { authVariable: variable } : {}),
  };
}

function mapRemoteMcp({ claimSlug }: ToolContext, tool: RemoteMcpTool, path: string): MappedTool {
  const notes: string[] = [];
  const slug = claimSlug(tool.name);
  if (slug !== tool.name) notes.push(renamedNote(slug, tool.name));
  if (tool.transport === 'sse') {
    notes.push('M365 connects over Streamable HTTP; confirm the server serves it');
  }
  if (tool.auth !== undefined) {
    notes.push(
      `secret ${tool.auth.secretRef} is not used; register an OAuth/Entra SSO auth config for this server in Teams Developer Portal and set ${authVariable(slug)} in env/.env.dev`,
    );
  }
  const plugin = remotePlugin({
    slug,
    name: tool.name,
    descriptionForHuman: `Tools from the ${tool.name} MCP server.`,
    url: tool.url,
    authenticated: tool.auth !== undefined,
  });
  return {
    plugin,
    verdict:
      notes.length === 0
        ? native(path, 'RemoteMCPServer plugin with dynamic tool discovery')
        : mapped(path, clip(notes.join('; '))),
  };
}

function mapCodeTool(
  { project, agent, firstCodeTool, codeToolsSlug }: ToolContext,
  tool: CodeTool,
  index: number,
  path: string,
): MappedTool {
  const endpoint = project.toolEndpoint;
  if (endpoint === undefined) {
    return {
      verdict: dropped(
        path,
        'code_tool_needs_public_mcp',
        `${tool.name} needs a public tool endpoint (project.toolEndpoint); Microsoft 365 cannot run it`,
      ),
    };
  }
  const slug = codeToolsSlug();
  const verdict = mapped(
    path,
    `served through ${slug} (ai-plugin.${slug}.json), a RemoteMCPServer at the project tool endpoint`,
  );
  if (index !== firstCodeTool) return { verdict };
  const codeTools = agent.tools.filter((candidate) => candidate.kind === 'code');
  return {
    verdict,
    plugin: remotePlugin({
      slug,
      name: CODE_TOOLS_PLUGIN,
      descriptionForHuman: `Code tools of the ${agent.name} agent.`,
      descriptionForModel: codeTools.map((code) => `${code.name}: ${code.description}`).join('\n'),
      url: endpoint.url,
      authenticated: true,
    }),
  };
}

function mapOpenApi(
  { project, claimSlug }: ToolContext,
  tool: OpenApiTool,
  path: string,
): MappedTool {
  const notes: string[] = [];
  const narrowed = tool.allow === undefined ? undefined : narrowOpenApiSpec(project, tool);
  if (narrowed?.ok === false) {
    return { verdict: dropped(path, 'permissions_unsupported', clip(narrowed.reason)) };
  }
  const remote = tool.specRef.startsWith('https://');
  const verbatim = project.openapiSpecs.find((spec) => spec.ref === tool.specRef);
  if (narrowed === undefined && !remote && verbatim === undefined) {
    return {
      verdict: dropped(
        path,
        'field_unsupported',
        clip(
          `${tool.specRef} is not bundled in the project, so the plugin has no document to read`,
        ),
      ),
    };
  }
  const slug = claimSlug(tool.name);
  if (slug !== tool.name) notes.push(renamedNote(slug, tool.name));
  const bundle =
    narrowed !== undefined
      ? { extension: 'json', content: `${renderJson(narrowed.spec)}\n` }
      : verbatim === undefined
        ? undefined
        : {
            extension: /\.(json|yaml|yml)$/iu.exec(tool.specRef)?.[1]?.toLowerCase() ?? 'json',
            content: verbatim.content,
          };
  const specFile = bundle === undefined ? undefined : `openapi/${slug}.${bundle.extension}`;
  if (narrowed !== undefined) {
    notes.push(`spec narrowed to the ${narrowed.operations} operations allow admits`);
  }
  if (tool.baseUrl !== undefined) notes.push('baseUrl is not carried');
  if (tool.auth !== undefined) {
    notes.push(
      `secret ${tool.auth.secretRef} is not used; the plugin is emitted with auth None — register an ApiKeyPluginVault auth config in Teams Developer Portal and set runtimes[0].auth to {type: "ApiKeyPluginVault", reference_id} in ai-plugin.${slug}.json`,
    );
  }
  return {
    plugin: {
      slug,
      file: `ai-plugin.${slug}.json`,
      manifest: {
        $schema: PLUGIN_SCHEMA_URL,
        schema_version: 'v2.4',
        name_for_human: tool.name,
        namespace: namespaceOf(slug),
        description_for_human: `The ${tool.name} API.`,
        runtimes: [
          { type: 'OpenApi', auth: { type: 'None' }, spec: { url: specFile ?? tool.specRef } },
        ],
      },
      ...(bundle === undefined || specFile === undefined
        ? {}
        : { spec: { file: specFile, content: bundle.content } }),
    },
    verdict: mapped(
      path,
      clip(
        notes.length === 0
          ? 'OpenApi plugin; the operations are inferred from the document'
          : notes.join('; '),
      ),
    ),
  };
}

function mapBuiltin(tool: BuiltinTool, path: string): FieldVerdict {
  switch (tool.id) {
    case 'web_search':
      return native(path, 'WebSearch capability');
    case 'code_execution':
      return native(path, 'CodeInterpreter capability');
    case 'web_fetch':
    case 'file_access':
      return dropped(path, 'builtin_unsupported', `Microsoft 365 has no ${tool.id} capability`);
  }
}

function mapTool(context: ToolContext, tool: Tool, index: number): MappedTool {
  const path = `${context.agent.name}.tools.${index}`;
  switch (tool.kind) {
    case 'mcp':
      return tool.transport === 'stdio'
        ? {
            verdict: dropped(
              path,
              'stdio_mcp_unsupported',
              'Microsoft 365 cannot start a local process',
            ),
          }
        : mapRemoteMcp(context, tool, path);
    case 'code':
      return mapCodeTool(context, tool, index, path);
    case 'openapi':
      return mapOpenApi(context, tool, path);
    case 'builtin':
      return { verdict: mapBuiltin(tool, path) };
  }
}

function mapTools(project: PortableProject, agent: PortableAgent): readonly MappedTool[] {
  const claimSlug = slugClaimer();
  let codeSlug: string | undefined;
  const context: ToolContext = {
    project,
    agent,
    firstCodeTool: agent.tools.findIndex((tool) => tool.kind === 'code'),
    claimSlug,
    codeToolsSlug: () => (codeSlug ??= claimSlug(CODE_TOOLS_PLUGIN)),
  };
  return agent.tools.map((tool, index) => mapTool(context, tool, index));
}

/** A site `WebSearch` accepts: at most two path segments and no query. */
function isSearchSite(url: string): boolean {
  if (url.includes('?') || !URL.canParse(url)) return false;
  const segments = new URL(url).pathname.split('/').filter((segment) => segment !== '');
  return segments.length <= WEB_SEARCH_SITE_SEGMENTS_MAX;
}

function mapKnowledge(
  agent: PortableAgent,
  unrestrictedSearch: boolean,
): { readonly sites: readonly string[]; readonly verdicts: readonly FieldVerdict[] } {
  const sites: string[] = [];
  const verdicts = agent.knowledge.map((source, index): FieldVerdict => {
    const path = `${agent.name}.knowledge.${index}`;
    switch (source.kind) {
      case 'files':
        return dropped(
          path,
          'knowledge_unsupported',
          'EmbeddedKnowledge is not enabled by Microsoft yet and accepts only doc/ppt/xls/txt/pdf up to 1 MB; upload the files to SharePoint and add OneDriveAndSharePoint by hand',
        );
      case 'connector':
        return dropped(
          path,
          'knowledge_unsupported',
          'a Copilot connector connection id is a tenant object; add GraphConnectors by hand',
        );
      case 'url':
        if (unrestrictedSearch)
          return mapped(path, 'covered by the unrestricted WebSearch capability');
        if (!isSearchSite(source.url)) {
          return dropped(
            path,
            'knowledge_unsupported',
            `WebSearch sites take at most ${WEB_SEARCH_SITE_SEGMENTS_MAX} path segments and no query`,
          );
        }
        if (sites.length >= WEB_SEARCH_SITES_MAX) {
          return dropped(
            path,
            'knowledge_unsupported',
            `WebSearch takes at most ${WEB_SEARCH_SITES_MAX} sites`,
          );
        }
        sites.push(source.url);
        return mapped(path, 'added to the sites of the WebSearch capability');
    }
  });
  return { sites, verdicts };
}

function platformBlockVerdict(path: string, id: string, isRoot: boolean): FieldVerdict {
  if (id !== M365_DECLARATIVE_AGENT_ID) {
    return dropped(path, 'field_unsupported', `options for ${id}, not for this target`);
  }
  return mapped(
    path,
    isRoot
      ? 'read as the options of this target'
      : 'only the root agent’s options are read; this block is not applied',
  );
}

function reportRootFields(agent: PortableAgent): readonly FieldVerdict[] {
  const at = (field: string): string => `${agent.name}.${field}`;
  const runsItself = 'the platform’s own orchestrator runs the agent';
  return [
    ...(agent.description === undefined
      ? []
      : [
          agent.description.length > SHORT_DESCRIPTION_MAX
            ? mapped(
                at('description'),
                `the app’s short description is cut to ${SHORT_DESCRIPTION_MAX} characters`,
              )
            : native(at('description'), 'declarative agent and app description'),
        ]),
    native(at('instructions'), 'declarative agent instructions'),
    ...(agent.model === undefined
      ? []
      : [dropped(at('model'), 'field_unsupported', 'Microsoft 365 Copilot selects the model')]),
    ...(agent.engine === undefined ? [] : [dropped(at('engine'), 'field_unsupported', runsItself)]),
    ...AGENT_PERMISSION_KEYS.map((key) =>
      agent.permissions[key]
        ? dropped(
            at(`permissions.${key}`),
            'permissions_unsupported',
            'the host has no sandbox to grant it in',
          )
        : native(at(`permissions.${key}`), 'not granted; nothing to configure'),
    ),
    ...agent.skills.map((_, index) =>
      dropped(
        at(`skills.${index}`),
        'skills_unsupported',
        'the declarative agent manifest has no skill reference',
      ),
    ),
    ...agent.subagents.map((_, index) =>
      dropped(
        at(`subagents.${index}`),
        'subagents_unsupported',
        'worker_agents is a preview and needs the title id of a published app; an app holds one declarative agent',
      ),
    ),
    ...(agent.limits?.maxTurns === undefined
      ? []
      : [dropped(at('limits.maxTurns'), 'limits_unsupported', 'the platform sets its own limits')]),
    ...(agent.limits?.maxBudgetUsd === undefined
      ? []
      : [
          dropped(
            at('limits.maxBudgetUsd'),
            'limits_unsupported',
            'the platform sets its own limits',
          ),
        ]),
    ...Object.keys(agent.extensions?.engines ?? {}).map((id) =>
      dropped(at(`extensions.engines.${id}`), 'field_unsupported', runsItself),
    ),
    ...Object.keys(agent.extensions?.platforms ?? {}).map((id) =>
      platformBlockVerdict(at(`extensions.platforms.${id}`), id, true),
    ),
  ];
}

/** Every field of an agent that does not become the declarative agent: the app holds exactly one. */
function reportOtherAgent(project: PortableProject, agent: PortableAgent): readonly FieldVerdict[] {
  const prefix = `${agent.name}.`;
  return portableFieldPaths(project)
    .filter((path) => path.startsWith(prefix))
    .map((path): FieldVerdict => {
      const field = path.slice(prefix.length);
      const platformId = /^extensions\.platforms\.(.+)$/u.exec(field)?.[1];
      if (platformId !== undefined) return platformBlockVerdict(path, platformId, false);
      if (field === 'engine' || field.startsWith('extensions.engines.')) {
        return dropped(
          path,
          'field_unsupported',
          'only the root agent becomes the declarative agent',
        );
      }
      const tool = agent.tools[Number(/^tools\.(\d+)$/u.exec(field)?.[1])];
      if (tool?.kind === 'mcp' && tool.transport === 'stdio') {
        return dropped(path, 'stdio_mcp_unsupported', 'Microsoft 365 cannot start a local process');
      }
      if (tool?.kind === 'code' && project.toolEndpoint === undefined) {
        return dropped(path, 'code_tool_needs_public_mcp', 'there is no public tool endpoint');
      }
      return dropped(
        path,
        'subagents_unsupported',
        'only the root agent becomes the declarative agent (one per app)',
      );
    });
}

function reportToolEndpoint(
  project: PortableProject,
  codePlugin: Plugin | undefined,
): readonly FieldVerdict[] {
  const endpoint = project.toolEndpoint;
  if (endpoint === undefined) return [];
  if (codePlugin === undefined) {
    return [dropped('toolEndpoint', 'field_unsupported', 'no code tool of the root agent uses it')];
  }
  return [
    mapped(
      'toolEndpoint',
      `served as ${codePlugin.file}; secret ${endpoint.auth.secretRef} is not used, register an OAuth/Entra SSO auth config in Teams Developer Portal and set ${authVariable(codePlugin.slug)} in env/.env.dev`,
    ),
  ];
}

function limitViolations(agent: PortableAgent, actions: number): readonly string[] {
  const violation = (field: string, limit: number, actual: number): string[] => [
    `field: ${field}`,
    `limit: ${limit}`,
    `actual: ${actual}`,
  ];
  return [
    ...(agent.instructions.trim() === '' || agent.instructions.length > INSTRUCTIONS_MAX
      ? violation('instructions', INSTRUCTIONS_MAX, agent.instructions.length)
      : []),
    ...((agent.description?.length ?? 0) > DESCRIPTION_MAX
      ? violation('description', DESCRIPTION_MAX, agent.description?.length ?? 0)
      : []),
    ...(actions > ACTIONS_MAX ? violation('tools', ACTIONS_MAX, actions) : []),
  ];
}

function shortDescription(text: string): string {
  if (text.length <= SHORT_DESCRIPTION_MAX) return text;
  const head = text.slice(0, SHORT_DESCRIPTION_MAX - 1);
  const boundary = head.search(/\s\S*$/u);
  return `${(boundary > 0 ? head.slice(0, boundary) : head).trimEnd()}…`;
}

function renderAppManifest(
  agent: PortableAgent,
  options: M365DeclarativeAgentOptions,
): AppManifest {
  const description = agent.description ?? agent.name;
  const developer = options.developer;
  return {
    $schema: APP_MANIFEST_SCHEMA_URL,
    manifestVersion: '1.24',
    version: options.appVersion,
    id: placeholder('TEAMS_APP_ID'),
    developer:
      developer === undefined
        ? {
            name: placeholder('DEVELOPER_NAME'),
            websiteUrl: placeholder('DEVELOPER_WEBSITE_URL'),
            privacyUrl: placeholder('DEVELOPER_PRIVACY_URL'),
            termsOfUseUrl: placeholder('DEVELOPER_TERMS_OF_USE_URL'),
          }
        : {
            name: developer.name,
            websiteUrl: developer.websiteUrl,
            privacyUrl: developer.privacyUrl,
            termsOfUseUrl: developer.termsOfUseUrl,
          },
    name: { short: agent.name.slice(0, SHORT_NAME_MAX), full: agent.name },
    description: { short: shortDescription(description), full: description },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: options.accentColor,
    copilotAgents: {
      declarativeAgents: [{ id: 'declarativeAgent', file: 'declarativeAgent.json' }],
    },
  };
}

function capabilitiesOf(tools: readonly Tool[], sites: readonly string[]): readonly Capability[] {
  const has = (id: BuiltinTool['id']): boolean =>
    tools.some((tool) => tool.kind === 'builtin' && tool.id === id);
  const webSearch: Capability[] = has('web_search')
    ? [{ name: 'WebSearch' }]
    : sites.length > 0
      ? [{ name: 'WebSearch', sites: sites.map((url) => ({ url })) }]
      : [];
  return [...webSearch, ...(has('code_execution') ? [{ name: 'CodeInterpreter' as const }] : [])];
}

function renderDeclarativeAgent(
  agent: PortableAgent,
  options: M365DeclarativeAgentOptions,
  capabilities: readonly Capability[],
  plugins: readonly Plugin[],
): DeclarativeAgentManifestV18 {
  const starters = options.conversationStarters ?? [];
  const hasOverrides =
    options.defaultResponseMode !== undefined || options.discourageModelKnowledge !== undefined;
  return {
    $schema: DECLARATIVE_AGENT_SCHEMA_URL,
    version: 'v1.8',
    name: agent.name,
    description: agent.description ?? agent.name,
    instructions: agent.instructions,
    ...(capabilities.length === 0 ? {} : { capabilities: [...capabilities] }),
    ...(starters.length === 0
      ? {}
      : {
          conversation_starters: starters.map((starter) => ({
            ...(starter.title === undefined ? {} : { title: starter.title }),
            text: starter.text,
          })),
        }),
    ...(plugins.length === 0
      ? {}
      : { actions: plugins.map((plugin) => ({ id: plugin.slug, file: plugin.file })) }),
    ...(hasOverrides
      ? {
          behavior_overrides: {
            ...(options.defaultResponseMode === undefined
              ? {}
              : { default_response_mode: options.defaultResponseMode }),
            ...(options.discourageModelKnowledge === undefined
              ? {}
              : {
                  special_instructions: {
                    discourage_model_knowledge: options.discourageModelKnowledge,
                  },
                }),
          },
        }
      : {}),
    ...(options.disclaimer === undefined ? {} : { disclaimer: { text: options.disclaimer } }),
  };
}

/**
 * JSON in the shape Prettier leaves alone, because the goldens are format-checked: two-space
 * indent, objects and arrays of objects expanded, arrays of scalars on one line.
 */
function renderJson(value: unknown, indent = ''): string {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item !== 'object' || item === null)) {
      return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
    }
    const inner = `${indent}  `;
    return `[\n${value.map((item) => inner + renderJson(item, inner)).join(',\n')}\n${indent}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    const inner = `${indent}  `;
    const lines = entries.map(
      ([key, item]) => `${inner}${JSON.stringify(key)}: ${renderJson(item, inner)}`,
    );
    return `{\n${lines.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

/** A document that fails its vendor schema is a bug in this translator, so it throws instead of returning a partial bundle. */
function emitJson<T>(schema: z.ZodType<T>, value: T): string {
  schema.parse(value);
  return `${renderJson(value)}\n`;
}

function renderAtkProject(agentName: string): string {
  const zip = './appPackage/build/appPackage.${{TEAMSFX_ENV}}.zip';
  return [
    // VERIFY(V1): v1.12 and this URL come from a hand-rendered fixture, not a real `atk new` run; tracked in #962.
    '# yaml-language-server: $schema=https://aka.ms/m365-agents-toolkits/v1.12/yaml.schema',
    '# Replace appPackage/color.png and appPackage/outline.png with your brand icons.',
    'version: v1.12',
    'environmentFolderPath: ./env',
    'provision:',
    '  - uses: teamsApp/create',
    '    with:',
    `      name: ${agentName}\${{APP_NAME_SUFFIX}}`,
    '    writeToEnvironmentFile:',
    '      teamsAppId: TEAMS_APP_ID',
    '  - uses: teamsApp/zipAppPackage',
    '    with:',
    '      manifestPath: ./appPackage/manifest.json',
    `      outputZipPath: ${zip}`,
    '      outputFolder: ./appPackage/build',
    '  - uses: teamsApp/validateAppPackage',
    '    with:',
    `      appPackagePath: ${zip}`,
    '  - uses: teamsApp/update',
    '    with:',
    `      appPackagePath: ${zip}`,
    '  - uses: copilotAgent/publish',
    '    with:',
    `      appPackagePath: ${zip}`,
    '      scope: ${{AGENT_SCOPE}}',
    '    writeToEnvironmentFile:',
    '      titleId: M365_TITLE_ID',
    '      appId: M365_APP_ID',
    '      shareLink: SHARE_LINK',
    '',
  ].join('\n');
}

/** Variable names only: a value is the user’s to set, and a secret is never written. */
function renderEnvFile(options: M365DeclarativeAgentOptions, plugins: readonly Plugin[]): string {
  const names = [
    'TEAMS_APP_ID',
    'M365_TITLE_ID',
    'M365_APP_ID',
    'SHARE_LINK',
    ...(options.developer === undefined ? DEVELOPER_VARIABLES : []),
    ...plugins.flatMap((plugin) =>
      plugin.authVariable === undefined ? [] : [plugin.authVariable],
    ),
  ];
  return `${['TEAMSFX_ENV=dev', 'APP_NAME_SUFFIX=dev', 'AGENT_SCOPE=shared', ...new Set(names.map((name) => `${name}=`))].join('\n')}\n`;
}

function renderFiles(
  agent: PortableAgent,
  options: M365DeclarativeAgentOptions,
  capabilities: readonly Capability[],
  plugins: readonly Plugin[],
): readonly PlatformFile[] {
  return [
    { path: 'm365agents.yml', content: renderAtkProject(agent.name) },
    { path: 'env/.env.dev', content: renderEnvFile(options, plugins) },
    {
      path: 'appPackage/manifest.json',
      content: emitJson(AppManifestSchema, renderAppManifest(agent, options)),
    },
    {
      path: 'appPackage/declarativeAgent.json',
      content: emitJson(
        DeclarativeAgentManifestV18Schema,
        renderDeclarativeAgent(agent, options, capabilities, plugins),
      ),
    },
    ...plugins.flatMap((plugin) => [
      {
        path: `appPackage/${plugin.file}`,
        content: emitJson(PluginManifestV24Schema, plugin.manifest),
      },
      ...(plugin.spec === undefined
        ? []
        : [{ path: `appPackage/${plugin.spec.file}`, content: plugin.spec.content }]),
    ]),
    { path: 'appPackage/color.png', content: decodeBase64(PLACEHOLDER_COLOR_ICON_PNG_BASE64) },
    { path: 'appPackage/outline.png', content: decodeBase64(PLACEHOLDER_OUTLINE_ICON_PNG_BASE64) },
  ];
}

/**
 * Compiles the root agent of `project` to an Agents Toolkit project (declarative agent v1.8, plugin
 * manifests v2.4). Pure. `options` is what `M365DeclarativeAgentOptionsSchema` produced; use
 * `compileForPlatform` to validate raw options first.
 */
export function compileM365DeclarativeAgent(
  project: PortableProject,
  options: M365DeclarativeAgentOptions,
): PlatformCompileResult {
  const agent = project.agents.find((candidate) => candidate.name === project.root);
  if (agent === undefined) {
    return refuse(
      'platform_agent_not_found',
      `The root agent ${project.root} is not in the project.`,
      [project.root],
    );
  }

  const tools = mapTools(project, agent);
  const plugins = tools.flatMap(({ plugin }) => (plugin === undefined ? [] : [plugin]));
  const violations = limitViolations(agent, plugins.length);
  if (violations.length > 0) {
    return refuse(
      'platform_limit_exceeded',
      'The root agent exceeds a Microsoft 365 Copilot limit.',
      violations,
    );
  }

  const knowledge = mapKnowledge(
    agent,
    agent.tools.some((tool) => tool.kind === 'builtin' && tool.id === 'web_search'),
  );
  return {
    ok: true,
    files: renderFiles(agent, options, capabilitiesOf(agent.tools, knowledge.sites), plugins),
    report: [
      ...reportToolEndpoint(
        project,
        tools[agent.tools.findIndex((tool) => tool.kind === 'code')]?.plugin,
      ),
      ...reportRootFields(agent),
      ...tools.map(({ verdict }) => verdict),
      ...knowledge.verdicts,
      ...project.agents
        .filter((candidate) => candidate !== agent)
        .flatMap((other) => reportOtherAgent(project, other)),
    ],
  };
}
