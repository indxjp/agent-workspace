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
  PortableRelativePathSchema,
  PortableToolNameSchema,
  type PortableAgentInput,
  type PortableProjectInput,
} from '@indx-workspace/contracts/portable-agent';
import { ProjectHttpUrlSchema } from '@indx-workspace/contracts/project-file';
import { SECRET_NAME_PATTERN } from '@indx-workspace/contracts/secrets';
import { z } from 'zod';

import { dropped, mapped, native } from '../../paths.js';
import type { PlatformImportResult } from '../../port.js';
import { AW_TOOLS_NAME } from './compile.js';
import { BEDROCK_CLAUDE_MODEL_IDS } from './options.js';

const PROJECT_FILE = 'agentcore/agentcore.json';
const TEXT_MAX = 128;
const DETAILS_MAX = 64;
const DETAIL_TEXT_MAX = 512;
const KEY_MAX = 64;

/** The shell and file builtins a harness allows, by the `allowedTools` entries that cover them. */
const SHELL_ENTRIES: readonly string[] = ['*', '@builtin', '@builtin/*', '@builtin/shell'];
const FILE_ENTRIES: readonly string[] = [
  '*',
  '@builtin',
  '@builtin/*',
  '@builtin/file_*',
  '@builtin/file_operations',
];

const TOKEN_VAULT_REFERENCE =
  '\\$\\{arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\\d{12}:token-vault/default/apikeycredentialprovider/([^/}]+)\\}';
const BEARER_REFERENCE = new RegExp(`^Bearer ${TOKEN_VAULT_REFERENCE}$`, 'u');
const WHOLE_REFERENCE = new RegExp(`^${TOKEN_VAULT_REFERENCE}$`, 'u');
const S3_SKILL = /^s3:\/\/[^/]+\/(?:[^/]+\/)*([^/]+)\/?$/u;

const REVERSE_MODEL_IDS = new Map(
  Object.entries(BEDROCK_CLAUDE_MODEL_IDS).map(([anthropicId, bedrockId]) => [
    bedrockId,
    anthropicId,
  ]),
);

const ProjectFile = z.looseObject({
  harnesses: z.array(z.looseObject({ name: z.string(), path: z.string() })),
});

const HARNESS_KEYS = new Set([
  'name',
  'model',
  'systemPrompt',
  'tools',
  'skills',
  'allowedTools',
  'memory',
  'maxIterations',
  'maxTokens',
  'timeoutSeconds',
]);

const Harness = z.looseObject({
  name: z.string(),
  model: z.looseObject({ provider: z.string(), modelId: z.string().min(1) }).optional(),
  systemPrompt: z.string().optional(),
  tools: z
    .array(
      z.looseObject({
        type: z.string(),
        name: z.string(),
        config: z.looseObject({ remoteMcp: z.unknown().optional() }).optional(),
      }),
    )
    .optional(),
  skills: z
    .array(z.looseObject({ s3Uri: z.string().optional(), path: z.string().optional() }))
    .optional(),
  allowedTools: z.array(z.string()).optional(),
  // Only ever dropped, and their vendor shape is unverified, so any value is accepted.
  memory: z.unknown().optional(),
  maxIterations: z.number().int().positive().optional(),
  maxTokens: z.unknown().optional(),
  timeoutSeconds: z.unknown().optional(),
});
type HarnessSpec = z.infer<typeof Harness>;

const RemoteMcp = z.looseObject({
  url: ProjectHttpUrlSchema,
  headers: z.record(z.string(), z.string()).optional(),
});

type PortableTool = NonNullable<PortableAgentInput['tools']>[number];
type SkillFile = { readonly path: string; readonly content: PlatformFile['content'] };

interface Source {
  readonly name: string;
  readonly directory: string;
  readonly spec: HarnessSpec;
  readonly prompt: string | undefined;
  readonly nameReport: FieldVerdict[];
}

interface Section<T> {
  readonly value: T;
  readonly report: FieldVerdict[];
}

interface Skills {
  readonly dirs: Map<string, string>;
  readonly files: Map<string, SkillFile[]>;
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

/** The parser error quotes the source, which can hold a credential, so it is never forwarded. */
function readJson<T extends z.ZodType>(file: PlatformFile, schema: T): z.infer<T> {
  let data: unknown;
  try {
    data = JSON.parse(decode(file));
  } catch (error) {
    if (error instanceof Refused) throw error;
    return refuse('platform_options_invalid', file.path, 'the file is not valid JSON');
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    return refuse(
      'platform_options_invalid',
      file.path,
      `the file is invalid at "${firstIssuePath(result.error)}"`,
      issueDetails(result.error),
    );
  }
  return result.data;
}

function importName(harness: string): Section<string> {
  const name = harness.toLowerCase().replaceAll('_', '-');
  if (!PortableNameSchema.safeParse(name).success) {
    return refuse(
      'platform_options_invalid',
      `harness ${clip(harness, TEXT_MAX)}`,
      'the name does not become a lower-case kebab agent name',
    );
  }
  return {
    value: name,
    report: [
      name === harness
        ? native(`${name}.name`, 'The harness name')
        : mapped(`${name}.name`, `The harness name ${harness}, lower-cased with "_" as "-"`),
    ],
  };
}

function importInstructions(source: Source): Section<string> {
  const { name, spec, prompt } = source;
  const report: FieldVerdict[] = [];
  if (prompt === undefined && spec.systemPrompt === undefined) {
    return refuse(
      'platform_options_invalid',
      `harness ${name}`,
      'the harness has no system prompt',
    );
  }
  if (prompt !== undefined && spec.systemPrompt !== undefined) {
    report.push(
      dropped(`${name}.systemPrompt`, 'field_unsupported', 'system-prompt.md is used instead'),
    );
  }
  report.push(
    native(
      `${name}.instructions`,
      prompt === undefined ? 'Imported from systemPrompt' : 'Imported from system-prompt.md',
    ),
  );
  const text = prompt ?? spec.systemPrompt ?? '';
  return { value: prompt === undefined ? text : text.replace(/\n$/u, ''), report };
}

function importModel(name: string, spec: HarnessSpec): Section<PortableAgentInput['model']> {
  const { model } = spec;
  if (model === undefined) return { value: undefined, report: [] };
  const at = `${name}.model`;
  const report: FieldVerdict[] = [];
  let value: PortableAgentInput['model'];
  if (model.provider === 'bedrock') {
    const anthropicId = REVERSE_MODEL_IDS.get(model.modelId);
    value =
      anthropicId === undefined
        ? { id: model.modelId }
        : { provider: 'anthropic', id: anthropicId };
    report.push(
      mapped(
        at,
        anthropicId === undefined
          ? 'A Bedrock model id with no Anthropic API id; portable models have no bedrock provider, so the id is kept without one'
          : `The Bedrock id ${model.modelId} is Anthropic ${anthropicId}`,
      ),
    );
  } else if (model.provider === 'open_ai') {
    value = { provider: 'openai', id: model.modelId };
    report.push(mapped(at, 'An OpenAI model'));
  } else {
    value = { id: model.modelId };
    report.push(
      mapped(
        at,
        `A ${clip(model.provider, KEY_MAX)} model; portable models have no such provider, so the id is kept without one`,
      ),
    );
  }
  for (const key of Object.keys(model)) {
    if (key === 'maxTokens') {
      report.push(
        dropped(`${at}.${key}`, 'limits_unsupported', 'The output-token budget is not carried'),
      );
    } else if (key !== 'provider' && key !== 'modelId') {
      report.push(
        dropped(
          `${at}.${clip(key, KEY_MAX)}`,
          'field_unsupported',
          key === 'apiKeyArn'
            ? 'A credential reference is never carried'
            : 'Model settings are not carried',
        ),
      );
    }
  }
  return { value, report };
}

function allows(allowed: readonly string[] | undefined, entries: readonly string[]): boolean {
  return allowed === undefined || allowed.some((entry) => entries.includes(entry));
}

function importPermissions(
  name: string,
  spec: HarnessSpec,
): Section<PortableAgentInput['permissions']> {
  const { allowedTools } = spec;
  const runCommands = allows(allowedTools, SHELL_ENTRIES);
  const files = allows(allowedTools, FILE_ENTRIES);
  const at = (key: string): string => `${name}.permissions.${key}`;
  const note =
    allowedTools === undefined
      ? 'allowedTools is absent, and the harness default allows shell and file_operations'
      : undefined;
  const verdict = (key: string, text: string): FieldVerdict =>
    note === undefined ? native(at(key), text) : mapped(at(key), note);
  return {
    value: { readFiles: files, writeFiles: files, runCommands, unrestrictedNetwork: runCommands },
    report: [
      verdict('readFiles', 'Read from @builtin/file_operations'),
      verdict('writeFiles', 'Read from @builtin/file_operations'),
      verdict('runCommands', 'Read from @builtin/shell'),
      mapped(
        at('unrestrictedNetwork'),
        'The PUBLIC network mode has no egress allow-list, so it is open exactly when the shell is',
      ),
    ],
  };
}

function importAuth(
  headers: Readonly<Record<string, string>> | undefined,
  at: string,
): Section<{ scheme: 'bearer' | 'api-key'; secretRef: string } | undefined> {
  let auth: { scheme: 'bearer' | 'api-key'; secretRef: string } | undefined;
  const report: FieldVerdict[] = [];
  Object.entries(headers ?? {}).forEach(([header, value], index) => {
    const lower = header.toLowerCase();
    const bearer = lower === 'authorization' ? BEARER_REFERENCE.exec(value)?.[1] : undefined;
    const key = lower === 'x-api-key' ? WHOLE_REFERENCE.exec(value)?.[1] : undefined;
    const secretRef = bearer ?? key;
    if (auth === undefined && secretRef !== undefined && SECRET_NAME_PATTERN.test(secretRef)) {
      auth = { scheme: bearer === undefined ? 'api-key' : 'bearer', secretRef };
      report.push(
        mapped(`${at}.headers.${index}`, 'A token-vault reference, imported as auth.secretRef'),
      );
    } else {
      report.push(
        dropped(
          `${at}.headers.${index}`,
          'field_unsupported',
          'The header is not carried: its value can be a credential. Only a token-vault reference in Authorization or x-api-key is imported',
        ),
      );
    }
  });
  return { value: auth, report };
}

function importRemoteMcp(
  at: string,
  tool: NonNullable<HarnessSpec['tools']>[number],
): Section<PortableTool | undefined> {
  if (tool.name === AW_TOOLS_NAME) {
    return {
      value: undefined,
      report: [
        dropped(
          at,
          'code_tool_needs_public_mcp',
          "The project's tool endpoint: its code tools cannot be rebuilt, because the run function, description and schema are not in the files",
        ),
      ],
    };
  }
  const config = RemoteMcp.safeParse(tool.config?.remoteMcp);
  if (!config.success || !PortableToolNameSchema.safeParse(tool.name).success) {
    return {
      value: undefined,
      report: [
        dropped(
          at,
          'field_unsupported',
          'The tool has no usable name or config.remoteMcp.url (an http(s) URL with no credential)',
        ),
      ],
    };
  }
  const auth = importAuth(config.data.headers, at);
  return {
    value: {
      kind: 'mcp',
      name: tool.name,
      transport: 'streamable-http',
      url: config.data.url,
      ...(auth.value === undefined ? {} : { auth: auth.value }),
    },
    report: [native(at, 'A remote MCP tool'), ...auth.report],
  };
}

/** The `allowedTools` entries that cover a harness tool, as compile emits them. */
function toolEntries(tool: { readonly type: string; readonly name: string }): string[] {
  return tool.type === 'remote_mcp' ? ['*', `@${tool.name}`, `@${tool.name}/*`] : ['*', tool.name];
}

function importTools(name: string, spec: HarnessSpec): Section<PortableTool[]> {
  const tools: PortableTool[] = [];
  const report: FieldVerdict[] = [];
  const builtins = new Map<string, PortableTool>();
  (spec.tools ?? []).forEach((tool, index) => {
    const at = `${name}.tools.${index}`;
    // An entry covering only some of a server's tools (`@<name>/<tool>`) has no portable form, so
    // the tool is dropped rather than widened. The tool endpoint is always dropped, with its own code.
    const endpoint = tool.type === 'remote_mcp' && tool.name === AW_TOOLS_NAME;
    if (!endpoint && !allows(spec.allowedTools, toolEntries(tool))) {
      report.push(dropped(at, 'field_unsupported', 'The tool is listed but not in allowedTools'));
      return;
    }
    const builtin =
      tool.type === 'agentcore_code_interpreter'
        ? { id: 'code_execution' as const, note: 'The AgentCore code interpreter' }
        : tool.type === 'agentcore_browser'
          ? { id: 'web_fetch' as const, note: 'The AgentCore browser, narrowed to fetching' }
          : undefined;
    if (tool.type === 'remote_mcp') {
      const imported = importRemoteMcp(at, tool);
      if (imported.value !== undefined) tools.push(imported.value);
      report.push(...imported.report);
    } else if (builtin !== undefined && !builtins.has(builtin.id)) {
      builtins.set(builtin.id, { kind: 'builtin', id: builtin.id });
      report.push(mapped(at, builtin.note));
    } else {
      report.push(
        dropped(
          at,
          'field_unsupported',
          builtin === undefined
            ? 'Only remote MCP tools, the code interpreter and the browser have a portable form'
            : 'The same built-in tool is already imported',
        ),
      );
    }
  });
  return { value: [...tools, ...builtins.values()], report };
}

function skillDirectory(
  entry: NonNullable<HarnessSpec['skills']>[number],
  harnessDir: string,
): { name: string; dir: string } | undefined {
  const name =
    entry.s3Uri === undefined ? entry.path?.split('/').at(-1) : S3_SKILL.exec(entry.s3Uri)?.[1];
  if (name === undefined || !PortableNameSchema.safeParse(name).success) return undefined;
  if (entry.s3Uri !== undefined) return { name, dir: `${harnessDir}/skills/${name}` };
  return entry.path !== undefined && PortableRelativePathSchema.safeParse(entry.path).success
    ? { name, dir: `${harnessDir}/${entry.path}` }
    : undefined;
}

function importSkills(
  source: Source,
  files: readonly PlatformFile[],
  skills: Skills,
): Section<{ name: string; path: string }[]> {
  const value: { name: string; path: string }[] = [];
  const report: FieldVerdict[] = [];
  (source.spec.skills ?? []).forEach((entry, index) => {
    const at = `${source.name}.skills.${index}`;
    const found = skillDirectory(entry, source.directory);
    const own = found === undefined ? [] : filesUnder(files, found.dir);
    if (found === undefined || own.every((file) => file.path !== 'SKILL.md')) {
      report.push(
        dropped(
          at,
          'skills_unsupported',
          'The skill is not an S3 or path skill whose SKILL.md is in these files',
        ),
      );
    } else if (
      skills.dirs.get(found.name) !== undefined &&
      skills.dirs.get(found.name) !== found.dir
    ) {
      report.push(
        dropped(at, 'skills_unsupported', 'Another skill directory already has this name'),
      );
    } else {
      skills.dirs.set(found.name, found.dir);
      skills.files.set(found.name, own);
      if (!value.some((skill) => skill.name === found.name)) {
        value.push({ name: found.name, path: `skills/${found.name}` });
      }
      report.push(native(at, 'Imported from the skill directory in the files'));
    }
  });
  return { value, report };
}

function filesUnder(files: readonly PlatformFile[], directory: string): SkillFile[] {
  return files
    .filter((file) => file.path.startsWith(`${directory}/`))
    .map((file) => ({ path: file.path.slice(directory.length + 1), content: file.content }));
}

function importLimits(name: string, spec: HarnessSpec): Section<{ maxTurns: number } | undefined> {
  const report: FieldVerdict[] = [];
  if (spec.maxIterations !== undefined) {
    report.push(mapped(`${name}.limits.maxTurns`, 'One iteration is one reason/act cycle'));
  }
  for (const key of ['maxTokens', 'timeoutSeconds'] as const) {
    if (spec[key] !== undefined) {
      report.push(
        dropped(`${name}.${key}`, 'limits_unsupported', 'Only the iteration limit is carried'),
      );
    }
  }
  return {
    value: spec.maxIterations === undefined ? undefined : { maxTurns: spec.maxIterations },
    report,
  };
}

function unmappedKeys(name: string, spec: HarnessSpec): FieldVerdict[] {
  const report: FieldVerdict[] = [];
  const { memory } = spec;
  const disabled =
    typeof memory === 'object' && memory !== null && 'mode' in memory && memory.mode === 'disabled';
  if (memory !== undefined && !disabled) {
    report.push(
      dropped(
        `${name}.memory`,
        'field_unsupported',
        'Agent memory is not part of a portable agent',
      ),
    );
  }
  for (const key of Object.keys(spec)) {
    if (!HARNESS_KEYS.has(key)) {
      report.push(
        dropped(
          `${name}.${clip(key, KEY_MAX)}`,
          'field_unsupported',
          'The key is not part of a portable agent',
        ),
      );
    }
  }
  return report;
}

function importAgent(
  source: Source,
  files: readonly PlatformFile[],
  skills: Skills,
): { agent: PortableAgentInput; report: FieldVerdict[] } {
  const { name, spec } = source;
  const instructions = importInstructions(source);
  const model = importModel(name, spec);
  const permissions = importPermissions(name, spec);
  const tools = importTools(name, spec);
  const own = importSkills(source, files, skills);
  const limits = importLimits(name, spec);
  return {
    agent: {
      apiVersion: PORTABLE_AGENT_API_VERSION,
      kind: PORTABLE_AGENT_KIND,
      name,
      instructions: instructions.value,
      ...(model.value === undefined ? {} : { model: model.value }),
      permissions: permissions.value,
      tools: tools.value,
      skills: own.value,
      subagents: [],
      ...(limits.value === undefined ? {} : { limits: limits.value }),
    },
    report: [
      ...instructions.report,
      ...model.report,
      ...permissions.report,
      ...tools.report,
      ...own.report,
      ...limits.report,
      ...unmappedKeys(name, spec),
    ],
  };
}

function sourcesOf(byPath: ReadonlyMap<string, PlatformFile>): Source[] {
  const projectFile = byPath.get(PROJECT_FILE);
  if (projectFile === undefined) {
    return refuse(
      'platform_agent_not_found',
      PROJECT_FILE,
      'the AgentCore project file is missing',
    );
  }
  const { harnesses } = readJson(projectFile, ProjectFile);
  if (harnesses.length === 0) {
    return refuse('platform_agent_not_found', PROJECT_FILE, 'the project lists no harness');
  }
  const names = new Set<string>();
  return harnesses.map((entry, index) => {
    const directory = entry.path;
    if (!PortableRelativePathSchema.safeParse(directory).success) {
      return refuse(
        'platform_options_invalid',
        PROJECT_FILE,
        `harnesses.${index}.path is not a relative path`,
      );
    }
    const harnessFile = byPath.get(`${directory}/harness.json`);
    if (harnessFile === undefined) {
      return refuse(
        'platform_agent_not_found',
        `${directory}/harness.json`,
        'the harness file is missing',
      );
    }
    const spec = readJson(harnessFile, Harness);
    const { value: name, report: nameReport } = importName(spec.name);
    if (names.has(name)) {
      return refuse(
        'platform_options_invalid',
        harnessFile.path,
        'another harness has the same agent name',
      );
    }
    names.add(name);
    const promptFile = byPath.get(`${directory}/system-prompt.md`);
    return {
      name,
      directory,
      spec,
      prompt: promptFile === undefined ? undefined : decode(promptFile),
      nameReport,
    };
  });
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
  const byPath = new Map<string, PlatformFile>();
  for (const file of checked.data) {
    if (byPath.has(file.path)) {
      refuse('platform_options_invalid', file.path, 'the file is listed more than once');
    }
    byPath.set(file.path, file);
  }

  const skills: Skills = { dirs: new Map(), files: new Map() };
  const imported = sourcesOf(byPath).map((source) => {
    const agent = importAgent(source, checked.data, skills);
    return { agent: agent.agent, report: [...source.nameReport, ...agent.report] };
  });

  const [root] = imported;
  const input: PortableProjectInput = {
    root: root?.agent.name ?? '',
    agents: imported.map((entry) => entry.agent),
    skills: [...skills.files].map(([skill, skillFiles]) => ({ name: skill, files: skillFiles })),
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
  return { ok: true, project: project.data, report: imported.flatMap((entry) => entry.report) };
}

/** Pure inverse of `compileAwsAgentCore`: reads an AgentCore CLI project back into a portable project. */
export function importAwsAgentCore(files: readonly PlatformFile[]): PlatformImportResult {
  try {
    return importFiles(files);
  } catch (error) {
    if (error instanceof Refused) return { ok: false, refusal: error.refusal };
    throw error;
  }
}
