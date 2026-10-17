import { readdir } from 'node:fs/promises';
import path from 'node:path';

import type { PlatformId } from '@indx-workspace/contracts/platforms';
import type { PortableProject } from '@indx-workspace/contracts/portable-agent';
import type { ProjectDocument } from '@indx-workspace/contracts/project-file';
import { SecretNameSchema } from '@indx-workspace/contracts/secret-reference';
import type { PlatformTarget } from '@indx-workspace/platforms';
import { PROJECT_FILE_NAME } from '@indx-workspace/sdk/project';
import {
  loadPortableProject,
  PortableProjectError,
  type PortableCodeToolDeclaration,
  type PortableDrop,
} from '@indx-workspace/sdk/portable';
import { z } from 'zod';

import type { LocalCommandContext } from '../command.js';
import { projectOptions } from '../commands/project.js';
import { CommandRefusedError, UsageError } from '../io.js';
import { notice } from '../output.js';
import { formatProblem, loadProject, problemCount } from '../project/index.js';
import type { LoadedCodeTool } from '../project/index.js';
import { nodePortableProjectSource } from './source.js';

export interface LoadedPlatformProject {
  readonly project: PortableProject;
  readonly document: ProjectDocument;
  /** `platforms.<id>.options` merged with the `--env` overrides; empty without a `platform`. */
  readonly options: Readonly<Record<string, unknown>>;
  /** Everything the conversion of a TS agent could not carry, as `<agent>.<path>: <reason>`. */
  readonly dropped: readonly PortableDrop[];
}

const AGENT_MARKDOWN_SUFFIX = '.agent.md';

/** `platforms.<id>.options` merged with `environments.<name>` (shallow), as `--env` selects. */
function platformOptions(
  document: ProjectDocument,
  platform: PlatformId,
  environment: string | undefined,
): Readonly<Record<string, unknown>> {
  const entry = document.platforms?.[platform];
  if (environment === undefined) return entry?.options ?? {};
  const known = Object.entries(entry?.environments ?? {});
  const chosen = known.find(([name]) => name === environment);
  if (chosen === undefined) {
    throw new UsageError(
      `platforms.${platform}.environments has no ${environment}`,
      known.length === 0
        ? 'it has no environments'
        : `it has: ${known.map(([name]) => name).join(', ')}`,
    );
  }
  return { ...entry?.options, ...chosen[1] };
}

const ToolEndpointOptionsSchema = z.strictObject({
  publicBaseUrl: z.url({ protocol: /^https$/u }),
  toolAuth: z.strictObject({
    scheme: z.enum(['bearer', 'oauth2']),
    secretRef: SecretNameSchema,
  }),
});

/**
 * The project's public MCP tool endpoint (brief A1, T1b) from `publicBaseUrl` and `toolAuth`. Only
 * the secret's *name* is carried; aw never reads a secret value. Absent when `toolAuth` is.
 */
function toolEndpointFrom(
  platform: PlatformId,
  document: ProjectDocument,
  options: Readonly<Record<string, unknown>>,
): PortableProject['toolEndpoint'] {
  if (!Object.hasOwn(options, 'toolAuth')) return undefined;
  const parsed = ToolEndpointOptionsSchema.safeParse({
    publicBaseUrl: options['publicBaseUrl'],
    toolAuth: options['toolAuth'],
  });
  if (!parsed.success) {
    throw new CommandRefusedError(
      [
        `platform_options_invalid: platforms.${platform}.options cannot name a tool endpoint`,
        ...parsed.error.issues.map(
          (issue) =>
            `platforms.${platform}.options.${issue.path.map(String).join('.')}: ${issue.message}`,
        ),
      ].join('\n  '),
    );
  }
  const base = parsed.data.publicBaseUrl.replace(/\/+$/u, '');
  return { url: `${base}/mcp/projects/${document.name}`, auth: parsed.data.toolAuth };
}

function declaration(tool: LoadedCodeTool): PortableCodeToolDeclaration[] {
  const pinned = tool.pinned;
  if (pinned?.description === undefined || pinned.inputSchema === undefined) return [];
  return [
    {
      name: tool.name,
      description: pinned.description,
      inputSchema: pinned.inputSchema,
      outputSchema: pinned.outputSchema,
      timeoutMs: pinned.timeoutMs,
      secrets: pinned.secrets,
      allowedDomains: pinned.allowedDomains,
    },
  ];
}

async function hasTypeScriptAgents(root: string): Promise<boolean> {
  try {
    return (await readdir(path.join(root, 'agents'))).some(
      (name) => name.endsWith('.ts') && !name.endsWith('.d.ts'),
    );
  } catch {
    return false;
  }
}

async function markdownAgentNames(root: string): Promise<readonly string[]> {
  try {
    return (await readdir(path.join(root, 'agents')))
      .filter((name) => name.endsWith(AGENT_MARKDOWN_SUFFIX))
      .map((name) => name.slice(0, -AGENT_MARKDOWN_SUFFIX.length));
  } catch {
    return [];
  }
}

function chooseRoot(agent: string | undefined, names: readonly string[]): string {
  if (agent !== undefined) return agent;
  const unique = [...new Set(names)].sort();
  const [only] = unique;
  if (only === undefined) {
    throw new CommandRefusedError(
      'no agents/*.ts or agents/*.agent.md in this directory',
      'aw init --yes',
    );
  }
  if (unique.length > 1) {
    throw new UsageError(
      `the project defines ${String(unique.length)} agents; pass --agent <name>`,
      `one of: ${unique.join(', ')}`,
    );
  }
  return only;
}

/**
 * Loads `agents/*.ts` through aw's loader (ADR-0111) and `agents/*.agent.md` through the SDK, and
 * builds the {@link PortableProject} rooted at `agent` (or the sole agent). `platform`, with
 * `environment`, selects the options the tool endpoint is read from. This is the only place aw
 * composes the two loaders.
 */
export async function loadPlatformProject(
  context: LocalCommandContext,
  input: {
    readonly agent?: string | undefined;
    readonly platform?: PlatformId | undefined;
    readonly environment?: string | undefined;
  },
): Promise<LoadedPlatformProject> {
  const { cwd, io, mode, signal } = context;
  if (cwd === undefined) throw new CommandRefusedError('there is no current directory to load');
  const { read, options } = await projectOptions(cwd);
  if (read === null) {
    throw new CommandRefusedError(`no ${PROJECT_FILE_NAME} in this directory`, 'aw init --yes');
  }
  if (read.lifted) {
    throw new CommandRefusedError(
      `${PROJECT_FILE_NAME} is a v1 deployment profile; aw platforms takes a kind: Project file`,
      'agent-workspace deploy',
    );
  }
  const document = read.project;

  const loaded = (await hasTypeScriptAgents(cwd))
    ? await loadProject({ root: cwd, io, signal, ...options })
    : { agents: [], problems: [], secrets: [], tools: [], codeTools: [] };
  if (loaded.problems.length > 0) {
    for (const problem of loaded.problems) notice(io, mode, formatProblem(problem));
    throw new CommandRefusedError(problemCount(loaded.problems.length));
  }

  const root = chooseRoot(input.agent, [
    ...loaded.agents.map((agent) => agent.name),
    ...(await markdownAgentNames(cwd)),
  ]);
  const chosen =
    input.platform === undefined
      ? {}
      : platformOptions(document, input.platform, input.environment);
  const toolEndpoint =
    input.platform === undefined ? undefined : toolEndpointFrom(input.platform, document, chosen);

  try {
    const { project, dropped } = await loadPortableProject({
      project: document,
      bodies: loaded.agents.map((agent) => agent.body),
      catalogTools: loaded.tools.map((tool) => tool.definition),
      codeTools: loaded.codeTools.flatMap(declaration),
      codeToolNames: Object.fromEntries(
        loaded.agents.map((agent) => [agent.name, agent.codeTools.map((tool) => tool.name)]),
      ),
      root,
      source: nodePortableProjectSource(cwd),
      toolEndpoint,
    });
    return { project, document, options: chosen, dropped };
  } catch (error) {
    if (!(error instanceof PortableProjectError)) throw error;
    if (error.code === 'portable_root_unknown') {
      const [, ...names] = error.details;
      throw new CommandRefusedError(
        `platform_agent_not_found: the root agent ${root} is not in the project`,
        names.length === 0 ? undefined : `one of: ${names.join(', ')}`,
      );
    }
    throw new CommandRefusedError(`${error.code}: ${error.details.join('; ')}`);
  }
}

/** The target's options with the keys aw itself reads taken out, so a strict schema accepts them. */
export function targetOptions(
  target: PlatformTarget,
  options: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const without = (record: Readonly<Record<string, unknown>>, key: string) =>
    Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
  const stripped = without(options, 'toolAuth');
  // `publicBaseUrl` is also a platform's own option (Gemini Enterprise); keep it where the schema takes it.
  if (
    !Object.hasOwn(stripped, 'publicBaseUrl') ||
    target.optionsSchema.safeParse(stripped).success
  ) {
    return stripped;
  }
  const bare = without(stripped, 'publicBaseUrl');
  return target.optionsSchema.safeParse(bare).success ? bare : stripped;
}
