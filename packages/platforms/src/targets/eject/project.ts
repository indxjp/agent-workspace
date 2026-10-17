import { CONTRACTS_VERSION } from '@indx-workspace/contracts';
import type {
  FieldVerdict,
  PlatformFile,
  PlatformRefusal,
} from '@indx-workspace/contracts/platforms';
import type { PortableAgent, PortableProject } from '@indx-workspace/contracts/portable-agent';
import { z } from 'zod';

import { portableFieldPaths, dropped, mapped, native } from '../../paths.js';
import { CODE_TOOLS_SOURCE } from './code-tools-template.js';
import { EJECT_PINS } from './versions.js';

export type EjectEngine = 'claude-agent-sdk' | 'mastra' | 'openai-agents';

export const EjectOptionsSchema = z
  .object({
    /** npm package name of the ejected project; default: the root agent's name. */
    packageName: z
      .string()
      .regex(/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u)
      .max(214)
      .optional(),
  })
  .strict();
export type EjectOptions = z.infer<typeof EjectOptionsSchema>;

export function refusal(
  code: PlatformRefusal['code'],
  message: string,
  details: readonly string[],
): { readonly ok: false; readonly refusal: PlatformRefusal } {
  return { ok: false, refusal: { code, message, details } };
}

export type EjectAgents =
  | {
      readonly ok: true;
      readonly root: PortableAgent;
      readonly subagents: readonly PortableAgent[];
      /** Agents that are neither the root nor one of its subagents: an ejected project runs one. */
      readonly unreachable: readonly PortableAgent[];
    }
  | { readonly ok: false; readonly refusal: PlatformRefusal };

/** Root agent + its one-level subagents, or a platform_agent_not_found refusal naming the missing one. */
export function ejectAgents(project: PortableProject): EjectAgents {
  const byName = new Map(project.agents.map((agent) => [agent.name, agent]));
  const root = byName.get(project.root);
  if (root === undefined) {
    return refusal(
      'platform_agent_not_found',
      `The root agent ${project.root} is not in the project.`,
      [project.root],
    );
  }
  const missing = root.subagents.filter((subagent) => !byName.has(subagent.name));
  if (missing.length > 0) {
    return refusal(
      'platform_agent_not_found',
      'A subagent is not an agent of the project.',
      missing.map((subagent) => `${root.name}.subagents.${subagent.name}`),
    );
  }
  const subagents = root.subagents.flatMap((subagent) => {
    const agent = byName.get(subagent.name);
    return agent === undefined ? [] : [agent];
  });
  const used = new Set([root.name, ...subagents.map((agent) => agent.name)]);
  return {
    ok: true,
    root,
    subagents,
    unreachable: project.agents.filter((agent) => !used.has(agent.name)),
  };
}

/** Every field of an agent the ejected project does not run, each reported once. */
export function unreachableVerdicts(agent: PortableAgent): readonly FieldVerdict[] {
  const only = {
    root: agent.name,
    agents: [agent],
    skills: [],
    knowledgeFiles: [],
    openapiSpecs: [],
  };
  return portableFieldPaths(only).map((path) =>
    dropped(
      path,
      'field_unsupported',
      `${agent.name} is neither the root agent nor one of its subagents, so it is not ejected`,
    ),
  );
}

/** Env variable name for a secretRef: upper-case, every run outside [A-Z0-9] becomes `_`. */
export function secretEnvName(secretRef: string): string {
  return secretRef.toUpperCase().replace(/[^A-Z0-9]+/gu, '_');
}

const CODE = Symbol('code');

/** A piece of generated code that is written as it is: only ever built from fixed text and `lit`. */
export interface Code {
  readonly [CODE]: string;
}

export function code(text: string): Code {
  return Object.freeze({ [CODE]: text });
}

function isCode(value: unknown): value is Code {
  return typeof value === 'object' && value !== null && CODE in value;
}

/** A value as a TypeScript literal. The one way a definition value enters generated code. */
export function lit(value: string | number | boolean): string {
  return JSON.stringify(value);
}

export type CodeValue =
  | string
  | number
  | boolean
  | Code
  | readonly CodeValue[]
  | { readonly [key: string]: CodeValue | undefined };

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const INDENT = '  ';

/** Renders a value as TypeScript; every string is a `JSON.stringify` literal. */
export function render(value: CodeValue, depth = 0): string {
  if (isCode(value)) return value[CODE].split('\n').join(`\n${INDENT.repeat(depth)}`);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return lit(value);
  }
  const inner = INDENT.repeat(depth + 1);
  if (Array.isArray(value)) {
    const items = (value as readonly CodeValue[]).map((item) => render(item, depth + 1));
    if (items.length === 0) return '[]';
    const flat = (value as readonly CodeValue[]).every(
      (item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
    );
    if (flat && items.join(', ').length <= 72) return `[${items.join(', ')}]`;
    return `[\n${items.map((item) => `${inner}${item},`).join('\n')}\n${INDENT.repeat(depth)}]`;
  }
  const entries = Object.entries(
    value as { readonly [key: string]: CodeValue | undefined },
  ).flatMap(([key, item]) =>
    item === undefined
      ? []
      : [`${inner}${IDENTIFIER.test(key) ? key : lit(key)}: ${render(item, depth + 1)},`],
  );
  if (entries.length === 0) return '{}';
  return `{\n${entries.join('\n')}\n${INDENT.repeat(depth)}}`;
}

/** `JSON.stringify(x, null, 2) + '\n'`: the only rendering of a data file. */
function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** An import line; the specifier is a fixed module name taken from `EJECT_SDK_PACKAGES` or this project. */
export function importLine(names: readonly string[], specifier: string): string {
  return `import { ${names.join(', ')} } from ${lit(specifier)};`;
}

/** `"Bearer " + requireEnv("<NAME>")`: how a secretRef reaches a header without its value. */
function bearerHeader(secretRef: string): Code {
  return code(`${lit('Bearer ')} + requireEnv(${lit(secretEnvName(secretRef))})`);
}

/** The env reader generated code uses for every secretRef. */
export const REQUIRE_ENV_LINES: readonly string[] = [
  'function requireEnv(name: string): string {',
  '  const value = process.env[name];',
  '  if (value === undefined || value === "") {',
  '    throw new Error("Set " + name + " (see .env.example)");',
  '  }',
  '  return value;',
  '}',
  '',
];

/** The start of every `src/main.ts`: the prompt from argv, or a usage line and exit 1. */
export const MAIN_PROMPT_LINES: readonly string[] = [
  'const prompt = process.argv.slice(2).join(" ").trim();',
  'if (prompt === "") {',
  '  console.error("Usage: node --env-file=.env src/main.ts \\"your prompt\\"");',
  '  process.exit(1);',
  '}',
  '',
];

/** The `engine` preference: native on the engine the project runs, dropped for any other. */
export function engineVerdict(
  agent: PortableAgent,
  engine: EjectEngine,
  engineName: string,
): FieldVerdict[] {
  if (agent.engine === undefined) return [];
  const path = `${agent.name}.engine`;
  return [
    agent.engine === engine
      ? native(path, 'the ejected project runs on this engine')
      : dropped(
          path,
          'field_unsupported',
          `the ejected project runs on ${engineName}, not ${agent.engine}`,
        ),
  ];
}

/** `extensions.platforms.<id>`: only the target's own block is read, and only on the root agent. */
export function platformExtensionVerdicts(
  agent: PortableAgent,
  targetId: string,
  isRoot: boolean,
): FieldVerdict[] {
  return Object.keys(agent.extensions?.platforms ?? {}).map((id) => {
    const path = `${agent.name}.extensions.platforms.${id}`;
    if (id !== targetId) {
      return dropped(path, 'field_unsupported', `options for ${id}, not for this target`);
    }
    return mapped(
      path,
      isRoot ? 'read as this target’s options' : 'only the root agent’s options are read',
    );
  });
}

/** A subagent's own subagents: an ejected project nests one level only. */
export function nestedSubagentVerdicts(agent: PortableAgent, isRoot: boolean): FieldVerdict[] {
  if (isRoot) return [];
  return agent.subagents.map((_, index) =>
    dropped(
      `${agent.name}.subagents.${index}`,
      'subagents_unsupported',
      'a subagent cannot have subagents of its own',
    ),
  );
}

/** The public tool endpoint: an ejected project runs its code tools in-process and needs none. */
export function toolEndpointVerdicts(project: PortableProject): FieldVerdict[] {
  return project.toolEndpoint === undefined
    ? []
    : [mapped('toolEndpoint', 'not needed: an ejected project runs its code tools in-process')];
}

type PortableTool = PortableAgent['tools'][number];

interface McpServer {
  readonly identity: string;
  readonly config: CodeValue;
}

export interface McpBuild {
  /** A server name no tool may take. */
  readonly reserved?: string;
  readonly root: string;
  /** Server names in use, with what each was registered as. */
  readonly servers: Map<string, McpServer>;
  /** The server names each agent uses, in the order its tools list them. */
  readonly usedBy: Map<string, string[]>;
  readonly envNames: string[];
}

/**
 * How a target spells an MCP server, given the name it is registered under. `headers` is the bearer
 * header of a remote server, if it has auth.
 */
export interface McpShape {
  stdio(tool: Extract<PortableTool, { transport: 'stdio' }>, name: string): CodeValue;
  remote(
    tool: Extract<PortableTool, { transport: 'streamable-http' | 'sse' }>,
    headers: CodeValue | undefined,
    name: string,
  ): CodeValue;
}

/** The name a server is registered under: the tool's, or a qualified one when another server has it. */
function registerServer(
  build: McpBuild,
  agent: string,
  name: string,
  identity: string,
  configOf: (registeredAs: string) => CodeValue,
): string {
  const free = (candidate: string): boolean => {
    const existing = build.servers.get(candidate);
    return (
      candidate !== build.reserved && (existing === undefined || existing.identity === identity)
    );
  };
  let chosen = [name, `${name}-${agent}`].find(free);
  for (let counter = 2; chosen === undefined; counter += 1) {
    const candidate = `${name}-${agent}-${counter}`;
    if (free(candidate)) chosen = candidate;
  }
  if (!build.servers.has(chosen)) build.servers.set(chosen, { identity, config: configOf(chosen) });
  const used = build.usedBy.get(agent) ?? [];
  if (!used.includes(chosen)) used.push(chosen);
  build.usedBy.set(agent, used);
  return chosen;
}

/** Registers an MCP tool's server for `agent` and gives the tool its verdict. */
export function mapMcpTool(
  tool: Extract<PortableTool, { kind: 'mcp' }>,
  path: string,
  agent: string,
  build: McpBuild,
  shape: McpShape,
): FieldVerdict {
  const identity = JSON.stringify({ ...tool, name: '' });
  if (tool.transport === 'stdio') {
    const name = registerServer(build, agent, tool.name, identity, (registeredAs) =>
      shape.stdio(tool, registeredAs),
    );
    return native(
      path,
      `a local process registered as MCP server ${name}; it must exist where the project runs`,
    );
  }
  const headers =
    tool.auth === undefined ? undefined : { Authorization: bearerHeader(tool.auth.secretRef) };
  const name = registerServer(build, agent, tool.name, identity, (registeredAs) =>
    shape.remote(tool, headers, registeredAs),
  );
  if (tool.auth === undefined) return native(path, `remote MCP server ${name}`);
  const env = secretEnvName(tool.auth.secretRef);
  build.envNames.push(env);
  return tool.auth.scheme === 'bearer'
    ? native(
        path,
        `remote MCP server ${name}; the token is read from the environment variable ${env}`,
      )
    : mapped(
        path,
        `remote MCP server ${name}; the ${tool.auth.scheme} secret is sent from ${env} as a bearer token, adjust the headers in src/agent.ts if the server expects another`,
      );
}

/** The files of the skills an agent uses, placed under `directory/<name>/`. */
export function skillFiles(
  project: PortableProject,
  names: ReadonlySet<string>,
  directory: string,
): PlatformFile[] {
  return project.skills
    .filter((skill) => names.has(skill.name))
    .flatMap((skill) =>
      skill.files.map((file) => ({
        path: `${directory}/${skill.name}/${file.path}`,
        content: file.content,
      })),
    );
}

/**
 * `src/main.ts` of an eject whose `createAgent()` returns `{ agent, close }`: the prompt from argv,
 * `run` (the lines that use `agent` and print the answer), and `close()` whatever happens.
 */
export function agentMainSource(imports: readonly string[], run: readonly string[]): string {
  return [
    ...(imports.length === 0 ? [] : [...imports, '']),
    'import { createAgent } from "./agent.ts";',
    '',
    ...MAIN_PROMPT_LINES,
    'let close: (() => Promise<void>) | undefined;',
    'try {',
    '  const created = await createAgent();',
    '  close = created.close;',
    '  const { agent } = created;',
    ...run.map((line) => `  ${line}`),
    '} catch (error) {',
    '  console.error(error instanceof Error ? error.message : String(error));',
    '  process.exitCode = 1;',
    '} finally {',
    '  await close?.();',
    '}',
    '',
  ].join('\n');
}

/**
 * The provider of a model whose id Mastra and the AI SDK route by provider: the one the model names,
 * or else the one its id says. `undefined` when it is neither Anthropic nor OpenAI.
 */
export function modelProvider(model: {
  readonly provider?: string | undefined;
  readonly id: string;
}): 'anthropic' | 'openai' | undefined {
  if (model.provider === 'anthropic' || model.provider === 'openai') return model.provider;
  if (model.provider !== undefined) return undefined;
  if (model.id.startsWith('claude-')) return 'anthropic';
  return /^(?:gpt-|o\d)/u.test(model.id) ? 'openai' : undefined;
}

export interface ToolBuild extends McpBuild {
  /** The code tools the agents use, in first-use order. */
  readonly codeToolNames: string[];
}

/**
 * The verdicts of an agent's MCP and code tools; an openapi tool is `sharedVerdicts`' and a builtin
 * one is the target's own (`builtin`).
 */
export function mapTools(
  agent: PortableAgent,
  isRoot: boolean,
  build: ToolBuild,
  shape: McpShape,
  builtin: (tool: Extract<PortableTool, { kind: 'builtin' }>, path: string) => FieldVerdict,
): FieldVerdict[] {
  const verdicts: FieldVerdict[] = [];
  agent.tools.forEach((tool, index) => {
    const path = `${agent.name}.tools.${index}`;
    switch (tool.kind) {
      case 'mcp':
        verdicts.push(mapMcpTool(tool, path, agent.name, build, shape));
        break;
      case 'code': {
        if (!build.codeToolNames.includes(tool.name)) build.codeToolNames.push(tool.name);
        const where =
          'wrapped in-process from src/code-tools.ts; copy the project’s tools/ directory (aw platforms export does this)';
        verdicts.push(
          native(path, isRoot ? where : `${where}; its run context names the root agent`),
        );
        break;
      }
      case 'openapi':
        break;
      case 'builtin':
        verdicts.push(builtin(tool, path));
        break;
    }
  });
  return verdicts;
}

/** Verdicts the ejects share: knowledge, OpenAPI tools and non-empty extensions.engines blocks. */
export function sharedVerdicts(agent: PortableAgent, path: string): readonly FieldVerdict[] {
  const verdicts: FieldVerdict[] = [];
  agent.knowledge.forEach((source, index) =>
    verdicts.push(
      dropped(
        `${path}.knowledge.${index}`,
        'knowledge_unsupported',
        `no SDK of an ejected project has a retrieval slot for a ${source.kind} source; project.knowledgeFiles are not copied`,
      ),
    ),
  );
  agent.tools.forEach((tool, index) => {
    if (tool.kind !== 'openapi') return;
    verdicts.push(
      dropped(
        `${path}.tools.${index}`,
        'code_tool_needs_public_mcp',
        'an openapi tool runs in the Agent Workspace gateway; an ejected project has none',
      ),
    );
  });
  for (const [id, block] of Object.entries(agent.extensions?.engines ?? {})) {
    const at = `${path}.extensions.engines.${id}`;
    verdicts.push(
      Object.keys(block).length === 0
        ? mapped(at, 'the block is empty, so there is nothing to eject')
        : dropped(at, 'field_unsupported', 'engine options are not ejected'),
    );
  }
  return verdicts;
}

export interface EjectShellInput {
  readonly engine: EjectEngine;
  readonly packageName: string;
  readonly description: string | undefined;
  /** The engine's runtime dependencies; the shell adds the code-tool ones. */
  readonly dependencies: Readonly<Record<string, string>>;
  /** Names for `.env.example`, in the order they are written. Names only, never values. */
  readonly envNames: readonly string[];
  readonly hasCodeTools: boolean;
  /** Markdown blocks the target adds to the README after the common ones. */
  readonly readmeSections: readonly string[];
}

function sortedRecord(record: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function readme(input: EjectShellInput): string {
  const title = input.description ?? '';
  return [
    `# ${input.packageName}${title === '' ? '' : `\n${title}`}`,
    [
      '## Run',
      '',
      '```sh',
      'npm install',
      'cp .env.example .env   # then fill in the values',
      'node --env-file=.env src/main.ts "your prompt"',
      '```',
    ].join('\n'),
    ...(input.hasCodeTools
      ? [
          [
            '## Code tools',
            '',
            "Copy your project's `tools/` directory next to `src/` and add any package your run files import.",
            '`src/code-tools.ts` loads the declarations from it.',
          ].join('\n'),
        ]
      : []),
    ...input.readmeSections,
    [
      '## What was not carried over',
      '',
      'The platform report that came with this project gives every field a verdict and says why a field could not be carried. An ejected project is not importable back into Agent Workspace.',
    ].join('\n'),
  ]
    .join('\n\n')
    .concat('\n');
}

/** The files every eject writes: package.json, tsconfig.json, .gitignore, .env.example, README.md and code-tools.ts. */
export function ejectShellFiles(input: EjectShellInput): readonly PlatformFile[] {
  const dependencies = sortedRecord({
    ...input.dependencies,
    ...(input.hasCodeTools
      ? { '@indx-workspace/sdk': CONTRACTS_VERSION, zod: EJECT_PINS.zod }
      : {}),
  });
  const manifest = {
    name: input.packageName,
    version: '0.1.0',
    private: true,
    type: 'module',
    ...(input.description === undefined ? {} : { description: input.description }),
    engines: { node: '>=24' },
    scripts: { start: 'node src/main.ts', typecheck: 'tsc --noEmit' },
    dependencies,
    devDependencies: sortedRecord({
      typescript: EJECT_PINS.typescript,
      '@types/node': EJECT_PINS['@types/node'],
    }),
  };
  const tsconfig = {
    compilerOptions: {
      target: 'ES2023',
      lib: ['ES2023'],
      module: 'nodenext',
      moduleResolution: 'nodenext',
      strict: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      erasableSyntaxOnly: true,
      verbatimModuleSyntax: true,
      types: ['node'],
      skipLibCheck: true,
    },
    include: ['src', 'tools'],
  };
  const names = [...new Set(input.envNames)];
  return [
    { path: 'package.json', content: json(manifest) },
    { path: 'tsconfig.json', content: json(tsconfig) },
    { path: '.gitignore', content: 'node_modules\n.env\n' },
    {
      path: '.env.example',
      content: names.length === 0 ? '' : `${names.map((name) => `${name}=`).join('\n')}\n`,
    },
    { path: 'README.md', content: readme(input) },
    ...(input.hasCodeTools ? [{ path: 'src/code-tools.ts', content: CODE_TOOLS_SOURCE }] : []),
  ];
}
