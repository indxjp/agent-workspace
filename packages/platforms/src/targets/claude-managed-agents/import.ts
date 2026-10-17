import {
  PlatformFileSchema,
  type FieldVerdict,
  type PlatformFile,
  type PlatformRefusal,
} from '@indx-workspace/contracts/platforms';
import {
  PORTABLE_AGENT_API_VERSION,
  PORTABLE_AGENT_KIND,
  PortableNameSchema,
  PortableProjectSchema,
  type PortableAgentInput,
  type PortableProjectInput,
} from '@indx-workspace/contracts/portable-agent';
import { parse } from 'yaml';
import { z } from 'zod';

import { dropped, mapped, native } from '../../paths.js';
import type { PlatformImportResult } from '../../port.js';
import {
  AGENT_TOOLSET_TYPE,
  AW_TOOLS_SERVER_NAME,
  MULTIAGENT_TYPE,
  READ_TOOLS,
  TOOLSET_ORDER,
  WRITE_TOOLS,
  type ToolsetTool,
} from './compile.js';

const AGENT_FILE = /^agents\/([^/]+)\.md$/u;
const SKILL_FILE = /^skills\/([^/]+)\/(.+)$/u;
const SKILL_REFERENCE = /^\.\.\/skills\/([^/]+)\/?$/u;
const AGENT_REFERENCE = /^(?:\.\/)?([^/]+)\.md$/u;
const FRONTMATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/u;
const SKILL_MD = 'SKILL.md';
const COORDINATOR_TYPE = 'coordinator';
const TEXT_MAX = 128;
const DETAILS_MAX = 64;
const DETAIL_TEXT_MAX = 512;

const PermissionPolicy = z.strictObject({
  type: z.enum(['always_allow', 'always_ask', 'auto']),
});
const Toggle = z.strictObject({ type: z.enum(['enabled', 'disabled']) });
const Version = z.union([z.string(), z.number()]);

const Toolset = z.strictObject({
  type: z.literal(AGENT_TOOLSET_TYPE),
  default_config: z
    .strictObject({
      enabled: z.boolean().optional(),
      permission_policy: PermissionPolicy.optional(),
    })
    .optional(),
  configs: z
    .array(
      z.strictObject({
        name: z.enum(TOOLSET_ORDER),
        enabled: z.boolean().optional(),
        permission_policy: PermissionPolicy.optional(),
      }),
    )
    .optional(),
});

const McpToolset = z.strictObject({
  type: z.literal('mcp_toolset'),
  mcp_server_name: z.string().min(1),
  default_config: z
    .strictObject({
      enabled: z.boolean().optional(),
      permission_policy: PermissionPolicy.optional(),
    })
    .optional(),
  configs: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        enabled: z.boolean().optional(),
        permission_policy: PermissionPolicy.optional(),
      }),
    )
    .optional(),
});

const CustomTool = z.strictObject({
  type: z.literal('custom'),
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
});

const AgentReference = z.union([
  z.string().min(1),
  z.strictObject({ type: z.literal('agent'), id: z.string().min(1), version: Version.optional() }),
  z.strictObject({ type: z.literal('self') }),
]);

const Multiagent = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal(MULTIAGENT_TYPE),
    subagents: z
      .strictObject({
        type: z.enum(['enabled', 'disabled']),
        inline_agents: Toggle.optional(),
        predefined_agents: z.array(AgentReference).optional(),
      })
      .optional(),
    workflows: Toggle.optional(),
  }),
  z.strictObject({ type: z.literal(COORDINATOR_TYPE), agents: z.array(AgentReference) }),
]);

const Frontmatter = z.strictObject({
  type: z.literal('agent').optional(),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  model: z.union([
    z.string().min(1),
    z.strictObject({
      id: z.string().min(1),
      speed: z.string().optional(),
      effort: z.string().optional(),
      inference_geo: z.string().optional(),
    }),
  ]),
  system: z.string().optional(),
  mcp_servers: z
    .array(z.strictObject({ type: z.literal('url'), name: z.string().min(1), url: z.string() }))
    .optional(),
  tools: z.array(z.discriminatedUnion('type', [Toolset, McpToolset, CustomTool])).optional(),
  skills: z
    .array(
      z.union([
        z.string().min(1),
        z.strictObject({
          type: z.enum(['anthropic', 'custom']),
          skill_id: z.string().min(1),
          version: Version.optional(),
        }),
      ]),
    )
    .optional(),
  multiagent: Multiagent.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
type Frontmatter = z.infer<typeof Frontmatter>;
type ToolEntry = NonNullable<Frontmatter['tools']>[number];
type SkillEntry = NonNullable<Frontmatter['skills']>[number];
type Reference = z.infer<typeof AgentReference>;
type PortableTool = NonNullable<PortableAgentInput['tools']>[number];

type SkillFile = { readonly path: string; readonly content: PlatformFile['content'] };

interface AgentSource {
  readonly name: string;
  readonly path: string;
  readonly frontmatter: Frontmatter;
  readonly body: string;
}

interface MappedAgent {
  readonly agent: PortableAgentInput;
  readonly report: FieldVerdict[];
  readonly skills: readonly string[];
}

/** Thrown inside the importer and turned into a typed refusal at its edge; nothing else catches it. */
class Refused extends Error {
  constructor(readonly refusal: PlatformRefusal) {
    super(refusal.message);
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function refuse(
  code: PlatformRefusal['code'],
  where: string,
  problem: string,
  details: readonly string[] = [],
): never {
  throw new Refused({
    code,
    message: `${clip(where, TEXT_MAX)}: ${problem}`,
    details: details.slice(0, DETAILS_MAX).map((detail) => clip(detail, DETAIL_TEXT_MAX)),
  });
}

function issueDetails(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

function firstIssuePath(error: z.ZodError): string {
  return error.issues[0]?.path.join('.') || '(root)';
}

function decode(file: PlatformFile): string {
  if (typeof file.content === 'string') return file.content;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(file.content);
  } catch {
    return refuse('platform_options_invalid', file.path, 'the file is not valid UTF-8 text');
  }
}

/** The raw YAML parser error quotes source lines, so it is never forwarded. */
function parseFrontmatter(path: string, source: string): { value: Frontmatter; body: string } {
  const match = FRONTMATTER.exec(source);
  if (match === null) {
    return refuse('platform_options_invalid', path, 'the file has no frontmatter block');
  }
  let data: unknown;
  try {
    data = parse(match[1] ?? '', {
      strict: true,
      uniqueKeys: true,
      maxAliasCount: 0,
      logLevel: 'error',
    });
  } catch {
    return refuse('platform_options_invalid', path, 'the frontmatter is not valid YAML');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return refuse('platform_options_invalid', path, 'the frontmatter is not a mapping');
  }
  const result = Frontmatter.safeParse(data);
  if (!result.success) {
    return refuse(
      'platform_options_invalid',
      path,
      `the frontmatter is invalid at "${firstIssuePath(result.error)}"`,
      issueDetails(result.error),
    );
  }
  return { value: result.data, body: source.slice(match[0].length) };
}

function instructionsOf(source: AgentSource): string {
  const body = source.body.replace(/^\r?\n/u, '').replace(/\r?\n$/u, '');
  const { system } = source.frontmatter;
  const hasBody = body.trim() !== '';
  if (hasBody && system !== undefined && system !== '') {
    return refuse(
      'platform_options_invalid',
      source.path,
      'the file has both a Markdown body and a "system" key',
    );
  }
  return hasBody ? body : (system ?? '');
}

interface ToolMapping {
  readonly tools: PortableTool[];
  readonly permissions: PortableAgentInput['permissions'];
  readonly report: FieldVerdict[];
}

function toolsetState(
  toolset: Extract<ToolEntry, { type: typeof AGENT_TOOLSET_TYPE }>,
): ToolsetTool[] {
  const byDefault = toolset.default_config?.enabled ?? true;
  return TOOLSET_ORDER.filter(
    (name) => toolset.configs?.find((config) => config.name === name)?.enabled ?? byDefault,
  );
}

function mapTools(source: AgentSource): ToolMapping {
  const { name, path, frontmatter } = source;
  const servers = frontmatter.mcp_servers ?? [];
  const serverByName = new Map<string, number>();
  servers.forEach((server, index) => {
    if (serverByName.has(server.name)) {
      refuse(
        'platform_options_invalid',
        path,
        `mcp_servers.${index} repeats the name of an earlier server`,
      );
    }
    serverByName.set(server.name, index);
  });

  const report: FieldVerdict[] = [];
  const mcpTools: PortableTool[] = [];
  const enabled = new Set<ToolsetTool>();
  const paired = new Set<number>();

  (frontmatter.tools ?? []).forEach((tool, index) => {
    const at = `${name}.tools.${index}`;
    switch (tool.type) {
      case AGENT_TOOLSET_TYPE: {
        const tools = toolsetState(tool);
        for (const entry of tools) enabled.add(entry);
        const policy =
          tool.default_config?.permission_policy !== undefined ||
          tool.configs?.some((config) => config.permission_policy !== undefined) === true;
        report.push(
          mapped(
            at,
            `Enabled sandbox tools (${tools.join(', ') || 'none'}) become permissions and built-in tools${policy ? '; permission policies are not carried' : ''}`,
          ),
        );
        return;
      }
      case 'custom':
        report.push(
          dropped(
            at,
            'code_tool_needs_public_mcp',
            'A client-executed custom tool has no run function in the files; serve it through an MCP server',
          ),
        );
        return;
      case 'mcp_toolset': {
        const serverIndex = serverByName.get(tool.mcp_server_name);
        const server = serverIndex === undefined ? undefined : servers[serverIndex];
        if (serverIndex === undefined || server === undefined) {
          return refuse(
            'platform_options_invalid',
            path,
            `tools.${index} names an MCP server that is not in mcp_servers`,
          );
        }
        if (paired.has(serverIndex)) {
          return refuse(
            'platform_options_invalid',
            path,
            `tools.${index} repeats the toolset of mcp_servers.${serverIndex}`,
          );
        }
        paired.add(serverIndex);
        const serverAt = `${name}.mcp_servers.${serverIndex}`;
        if (server.name === AW_TOOLS_SERVER_NAME) {
          const byDefault = tool.default_config?.enabled ?? true;
          const exposed = (tool.configs ?? []).flatMap((config, position) =>
            (config.enabled ?? byDefault) ? [position] : [],
          );
          report.push(
            dropped(
              serverAt,
              'code_tool_needs_public_mcp',
              "The project's tool endpoint: its code tools cannot be rebuilt, because the run function, description and schema are not in the files",
            ),
          );
          for (const position of exposed) {
            report.push(
              dropped(
                `${at}.configs.${position}`,
                'code_tool_needs_public_mcp',
                'A code tool served by the tool endpoint; it is not imported',
              ),
            );
          }
          return;
        }
        mcpTools.push({
          kind: 'mcp',
          name: server.name,
          transport: 'streamable-http',
          url: server.url,
        });
        report.push(
          mapped(
            serverAt,
            'Imported as a remote MCP tool without auth; add auth.secretRef (vault credentials are not in the files)',
          ),
        );
        if (tool.default_config !== undefined || tool.configs !== undefined) {
          report.push(mapped(at, 'Per-tool configs and permission policies are not carried'));
        }
        return;
      }
    }
  });

  servers.forEach((_, index) => {
    if (!paired.has(index)) {
      refuse('platform_options_invalid', path, `mcp_servers.${index} has no matching mcp_toolset`);
    }
  });

  const builtins: PortableTool[] = [];
  if (enabled.has('web_fetch')) builtins.push({ kind: 'builtin', id: 'web_fetch' });
  if (enabled.has('web_search')) builtins.push({ kind: 'builtin', id: 'web_search' });
  return {
    tools: [...mcpTools, ...builtins],
    permissions: {
      readFiles: READ_TOOLS.some((tool) => enabled.has(tool)),
      writeFiles: WRITE_TOOLS.some((tool) => enabled.has(tool)),
      runCommands: enabled.has('bash'),
      unrestrictedNetwork: false,
    },
    report,
  };
}

function mapSkills(
  source: AgentSource,
  skillDirs: ReadonlyMap<string, readonly SkillFile[]>,
): { skills: { name: string; path: string }[]; report: FieldVerdict[] } {
  const skills: { name: string; path: string }[] = [];
  const report: FieldVerdict[] = [];
  const entries: readonly SkillEntry[] = source.frontmatter.skills ?? [];
  entries.forEach((entry, index) => {
    const at = `${source.name}.skills.${index}`;
    if (typeof entry !== 'string') {
      report.push(
        dropped(at, 'skills_unsupported', 'A skill given by id is not part of the files'),
      );
      return;
    }
    const directory = SKILL_REFERENCE.exec(entry)?.[1];
    const files = directory === undefined ? undefined : skillDirs.get(directory);
    if (
      directory === undefined ||
      !PortableNameSchema.safeParse(directory).success ||
      files?.some((file) => file.path === SKILL_MD) !== true
    ) {
      report.push(
        dropped(
          at,
          'skills_unsupported',
          'The skill is not a ../skills/<name> directory that holds a SKILL.md in these files',
        ),
      );
      return;
    }
    skills.push({ name: directory, path: `skills/${directory}` });
    report.push(native(at, 'Imported from the skills directory'));
  });
  return { skills, report };
}

function referenceTarget(
  reference: Reference,
): { readonly kind: 'self' } | { readonly kind: 'ref'; readonly value: string } {
  if (typeof reference === 'string') return { kind: 'ref', value: reference };
  return reference.type === 'self' ? { kind: 'self' } : { kind: 'ref', value: reference.id };
}

function mapSubagents(
  source: AgentSource,
  agentNames: ReadonlySet<string>,
): { subagents: { name: string }[]; report: FieldVerdict[] } {
  const multiagent = source.frontmatter.multiagent;
  const subagents: { name: string }[] = [];
  const report: FieldVerdict[] = [];
  if (multiagent === undefined) return { subagents, report };

  let references: readonly Reference[];
  let base: string;
  if (multiagent.type === COORDINATOR_TYPE) {
    references = multiagent.agents;
    base = `${source.name}.multiagent.agents`;
  } else {
    base = `${source.name}.multiagent.subagents.predefined_agents`;
    references =
      multiagent.subagents?.type === 'disabled'
        ? []
        : (multiagent.subagents?.predefined_agents ?? []);
    if (multiagent.subagents?.inline_agents?.type === 'enabled') {
      report.push(
        dropped(
          `${source.name}.multiagent.subagents.inline_agents`,
          'subagents_unsupported',
          'Inline agents are not part of the agent files',
        ),
      );
    }
    if (multiagent.workflows?.type === 'enabled') {
      report.push(
        dropped(
          `${source.name}.multiagent.workflows`,
          'subagents_unsupported',
          'Workflows are not part of a portable agent',
        ),
      );
    }
  }

  const seen = new Set<string>();
  references.forEach((reference, index) => {
    const at = `${base}.${index}`;
    const target = referenceTarget(reference);
    const name = target.kind === 'ref' ? AGENT_REFERENCE.exec(target.value)?.[1] : undefined;
    if (name !== undefined && seen.has(name)) {
      report.push(dropped(at, 'subagents_unsupported', 'The agent is already a subagent'));
    } else if (name !== undefined && name !== source.name && agentNames.has(name)) {
      seen.add(name);
      subagents.push({ name });
      report.push(native(at, 'Imported as a subagent'));
    } else {
      report.push(
        dropped(
          at,
          'subagents_unsupported',
          target.kind === 'self'
            ? 'A self reference is not a subagent'
            : 'The reference is an agent id or a file that is not in these files',
        ),
      );
    }
  });
  return { subagents, report };
}

function mapModel(source: AgentSource): {
  model: NonNullable<PortableAgentInput['model']>;
  report: FieldVerdict[];
} {
  const { model } = source.frontmatter;
  const at = `${source.name}.model`;
  if (typeof model === 'string') {
    return {
      model: { provider: 'anthropic', id: model },
      report: [native(at, 'Imported as the Anthropic model id')],
    };
  }
  const report = [mapped(at, 'Imported as the Anthropic model id')];
  for (const key of ['speed', 'effort', 'inference_geo'] as const) {
    if (model[key] !== undefined) {
      report.push(
        dropped(
          `${at}.${key}`,
          'field_unsupported',
          `${key} is not carried; set it in the claude-managed-agents platform options`,
        ),
      );
    }
  }
  return { model: { provider: 'anthropic', id: model.id }, report };
}

function mapAgent(
  source: AgentSource,
  isRoot: boolean,
  agentNames: ReadonlySet<string>,
  skillDirs: ReadonlyMap<string, readonly SkillFile[]>,
): MappedAgent {
  const { name, frontmatter } = source;
  const report: FieldVerdict[] = [];

  let description = frontmatter.description;
  if (frontmatter.name === name) {
    report.push(native(`${name}.name`, 'The agent name is the file name'));
  } else if (description === undefined && !PortableNameSchema.safeParse(frontmatter.name).success) {
    description = frontmatter.name;
    report.push(
      mapped(
        `${name}.name`,
        'Not a kebab-case name; kept as the description. The file name is the agent name',
      ),
    );
  } else {
    report.push(
      dropped(
        `${name}.name`,
        'field_unsupported',
        'The agent name is the file name; the frontmatter name is not carried',
      ),
    );
  }
  if (frontmatter.description !== undefined) {
    report.push(native(`${name}.description`, 'Imported as the description'));
  }

  const instructions = instructionsOf(source);
  if (instructions !== '') {
    report.push(
      native(
        `${name}.system`,
        source.body.trim() === ''
          ? 'Imported from the system key'
          : 'Imported from the Markdown body',
      ),
    );
  }

  const model = mapModel(source);
  const tools = mapTools(source);
  const skills = mapSkills(source, skillDirs);
  report.push(...model.report, ...tools.report, ...skills.report);

  let subagents: { name: string }[] = [];
  if (isRoot) {
    const mappedSubagents = mapSubagents(source, agentNames);
    subagents = mappedSubagents.subagents;
    report.push(...mappedSubagents.report);
  } else if (frontmatter.multiagent !== undefined) {
    report.push(
      dropped(
        `${name}.multiagent`,
        'subagents_unsupported',
        'Only the root agent keeps its subagents (one level only)',
      ),
    );
  }
  if (frontmatter.metadata !== undefined) {
    report.push(
      dropped(
        `${name}.metadata`,
        'field_unsupported',
        'Agent metadata is not part of a portable agent',
      ),
    );
  }

  return {
    agent: {
      apiVersion: PORTABLE_AGENT_API_VERSION,
      kind: PORTABLE_AGENT_KIND,
      name,
      ...(description === undefined ? {} : { description }),
      instructions,
      model: model.model,
      permissions: tools.permissions,
      tools: tools.tools,
      skills: skills.skills,
      subagents,
    },
    report,
    skills: skills.skills.map((skill) => skill.name),
  };
}

function chooseRoot(sources: readonly AgentSource[]): {
  root: AgentSource;
  report: FieldVerdict[];
} {
  const orchestrators = sources.filter(({ frontmatter: { multiagent } }) =>
    multiagent === undefined
      ? false
      : multiagent.type === COORDINATOR_TYPE || multiagent.subagents?.type !== 'disabled',
  );
  const candidates = orchestrators.length > 0 ? orchestrators : sources;
  const [root] = candidates;
  if (root === undefined) {
    return refuse('platform_agent_not_found', 'agents', 'the layout has no agents/*.md file');
  }
  return {
    root,
    report:
      candidates.length === 1
        ? []
        : [
            mapped(
              'import.root',
              `${candidates.length} agents could be the root; the first by file path was chosen`,
            ),
          ],
  };
}

function importFiles(files: readonly PlatformFile[]): PlatformImportResult {
  const checked = z.array(PlatformFileSchema).safeParse(files);
  if (!checked.success) {
    return refuse(
      'platform_options_invalid',
      'files',
      'the file list is invalid',
      issueDetails(checked.error),
    );
  }

  const agentFiles = new Map<string, PlatformFile>();
  const skillDirs = new Map<string, SkillFile[]>();
  let hasMemoryStores = false;
  let hasDeployments = false;
  for (const file of checked.data) {
    const agentName = AGENT_FILE.exec(file.path)?.[1];
    const skill = SKILL_FILE.exec(file.path);
    if (agentName !== undefined) {
      if (agentFiles.has(file.path)) {
        refuse('platform_options_invalid', file.path, 'the file is listed more than once');
      }
      agentFiles.set(file.path, file);
    } else if (skill?.[1] !== undefined && skill[2] !== undefined) {
      const entries = skillDirs.get(skill[1]) ?? [];
      entries.push({ path: skill[2], content: file.content });
      skillDirs.set(skill[1], entries);
    } else if (file.path.startsWith('memory_stores/')) {
      hasMemoryStores = true;
    } else if (file.path.startsWith('deployments/')) {
      hasDeployments = true;
    }
  }

  const sources: AgentSource[] = [...agentFiles.keys()].sort().map((path) => {
    const file = agentFiles.get(path);
    const name = AGENT_FILE.exec(path)?.[1];
    if (file === undefined || name === undefined) throw new Error(`lost the agent file ${path}`);
    if (!PortableNameSchema.safeParse(name).success) {
      refuse(
        'platform_options_invalid',
        path,
        'the file name is not a lower-case kebab agent name',
      );
    }
    const parsed = parseFrontmatter(path, decode(file));
    return { name, path, frontmatter: parsed.value, body: parsed.body };
  });

  const { root, report: rootReport } = chooseRoot(sources);
  const agentNames = new Set(sources.map((source) => source.name));
  const ordered = [root, ...sources.filter((source) => source !== root)];
  const mappedAgents = ordered.map((source) =>
    mapAgent(source, source === root, agentNames, skillDirs),
  );

  const usedSkills = [...new Set(mappedAgents.flatMap((entry) => entry.skills))];
  const report: FieldVerdict[] = [...rootReport, ...mappedAgents.flatMap((entry) => entry.report)];
  if (hasMemoryStores) {
    report.push(
      dropped(
        'import.memory_stores',
        'knowledge_unsupported',
        'Memory stores are not part of a portable agent',
      ),
    );
  }
  if (hasDeployments) {
    report.push(
      dropped(
        'import.deployments',
        'limits_unsupported',
        'Scheduled runs are not part of an agent definition',
      ),
    );
  }

  const input: PortableProjectInput = {
    root: root.name,
    agents: mappedAgents.map((entry) => entry.agent),
    skills: usedSkills.map((skill) => ({ name: skill, files: skillDirs.get(skill) ?? [] })),
  };
  const project = PortableProjectSchema.safeParse(input);
  if (!project.success) {
    return refuse(
      'platform_options_invalid',
      'project',
      `the imported project is invalid at "${firstIssuePath(project.error)}"`,
      issueDetails(project.error),
    );
  }
  return { ok: true, project: project.data, report };
}

/** Pure inverse of `compileClaudeManagedAgents`: reads an `ant apply` layout back into a portable project. */
export function importClaudeManagedAgents(files: readonly PlatformFile[]): PlatformImportResult {
  try {
    return importFiles(files);
  } catch (error) {
    if (error instanceof Refused) return { ok: false, refusal: error.refusal };
    throw error;
  }
}
