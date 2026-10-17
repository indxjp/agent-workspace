import { z } from 'zod';

import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';
import {
  PortableProjectSchema,
  PortableRelativePathSchema,
  type PortableAgent,
  type PortableProject,
} from '@indx-workspace/contracts/portable-agent';
import { AW_DEV_TOOLS_CONNECTOR } from '@indx-workspace/contracts/tool-connectors';
import type { ProjectDocument } from '@indx-workspace/contracts/project-file';

import { issuesFromZod } from '../define/errors.js';
import type { ToolDefinition } from '../define/version-body.js';
import { ProjectFileError } from '../project/reader.js';
import {
  portableFromAgentVersionBody,
  type PortableCodeToolDeclaration,
  type PortableDrop,
} from './convert.js';
import { AGENT_MARKDOWN_SUFFIX, parseAgentMarkdown } from './markdown.js';

/** Project-relative POSIX file access, injected by the caller (aw passes node:fs, a test an in-memory map). */
export interface PortableProjectSource {
  /** The file's bytes, or null when it does not exist. Must refuse a path that escapes the root. */
  readFile(path: string): Promise<Uint8Array | null>;
  /** Every file path under `directory`, recursive, sorted by code unit; [] when the directory is absent. */
  listFiles(directory: string): Promise<readonly string[]>;
}

export interface LoadPortableProjectInput {
  /** The connectors and models the bodies refer to; a parsed `agent-workspace.yaml` satisfies it. */
  readonly project: Pick<ProjectDocument, 'connectors' | 'models'>;
  /** The bodies aw's loader produced for `agents/*.ts`, in any order. */
  readonly bodies: readonly AgentVersionBody[];
  /** The catalog tools of the whole project. */
  readonly catalogTools: readonly ToolDefinition[];
  /** Every code tool declaration of the whole project. An agent gets only the ones it names in `codeToolNames`. */
  readonly codeTools?: readonly PortableCodeToolDeclaration[] | undefined;
  /**
   * The code tool names each TS agent lists, by agent name. A body alone cannot say which code tools
   * an agent uses, and handing it all of `codeTools` would give every agent every tool. When absent,
   * each body's own recorded `toolBundles` declarations are used (a stored version has no project
   * to list them from).
   */
  readonly codeToolNames?: Readonly<Record<string, readonly string[]>> | undefined;
  /** The agent to export; the caller chose it. */
  readonly root: string;
  readonly source: PortableProjectSource;
  /** The project's public MCP tool endpoint, built by the caller; absent when none is configured. */
  readonly toolEndpoint?: PortableProject['toolEndpoint'] | undefined;
}

export interface PortableProjectLoad {
  readonly project: PortableProject;
  /** Every conversion drop, each prefixed with its agent: `<agent>.<path>`. */
  readonly dropped: readonly PortableDrop[];
}

type PortableProjectErrorCode =
  | 'portable_agent_duplicate'
  | 'portable_root_unknown'
  | 'portable_markdown_invalid'
  | 'portable_project_invalid';

/**
 * A project that cannot be assembled. `details` hold agent names, project-relative paths and the
 * parsers' own position messages; never file contents, and never a secret value.
 */
export class PortableProjectError extends Error {
  override readonly name = 'PortableProjectError';
  readonly code: PortableProjectErrorCode;
  readonly details: readonly string[];

  constructor(code: PortableProjectErrorCode, details: readonly string[]) {
    super(`${code}: ${details.join('; ')}`);
    this.code = code;
    this.details = Object.freeze([...details]);
  }
}

const AGENTS_DIRECTORY = 'agents';
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const BytesAnswerSchema = z.instanceof(Uint8Array).nullable();
const PathsAnswerSchema = z.array(PortableRelativePathSchema);

function decodeStrict(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/** A source that breaks its contract is a caller bug; what it returned is not echoed. */
function invalidAnswer(where: string): PortableProjectError {
  return new PortableProjectError('portable_project_invalid', [
    `${where}: the source returned an invalid answer`,
  ]);
}

async function readBytes(source: PortableProjectSource, path: string): Promise<Uint8Array | null> {
  const answer = BytesAnswerSchema.safeParse(await source.readFile(path));
  if (!answer.success) throw invalidAnswer(path);
  return answer.data;
}

async function listUnder(
  source: PortableProjectSource,
  directory: string,
): Promise<readonly string[]> {
  const answer = PathsAnswerSchema.safeParse(await source.listFiles(directory));
  if (!answer.success || answer.data.some((path) => !path.startsWith(`${directory}/`))) {
    throw invalidAnswer(directory);
  }
  return [...new Set(answer.data)].sort();
}

/** The files at `paths`, each stored relative to `prefix`: text when it is UTF-8, else the bytes. A missing file is skipped. */
async function readFiles(
  source: PortableProjectSource,
  paths: readonly string[],
  prefix: string,
): Promise<{ path: string; content: string | Uint8Array }[]> {
  const files: { path: string; content: string | Uint8Array }[] = [];
  for (const path of paths) {
    const bytes = await readBytes(source, path);
    if (bytes !== null)
      files.push({ path: path.slice(prefix.length), content: decodeStrict(bytes) ?? bytes });
  }
  return files;
}

async function markdownAgents(source: PortableProjectSource): Promise<PortableAgent[]> {
  const agents: PortableAgent[] = [];
  const direct = (await listUnder(source, AGENTS_DIRECTORY)).filter(
    (path) =>
      path.endsWith(AGENT_MARKDOWN_SUFFIX) &&
      !path.slice(AGENTS_DIRECTORY.length + 1).includes('/'),
  );
  for (const path of direct) {
    const bytes = await readBytes(source, path);
    if (bytes === null) continue;
    const text = decodeStrict(bytes);
    if (text === null) throw new PortableProjectError('portable_markdown_invalid', [path]);
    let agent: PortableAgent;
    try {
      agent = parseAgentMarkdown(text, path);
    } catch (error) {
      if (error instanceof ProjectFileError) {
        throw new PortableProjectError('portable_markdown_invalid', [error.message]);
      }
      throw error;
    }
    const expected = `${AGENTS_DIRECTORY}/${agent.name}${AGENT_MARKDOWN_SUFFIX}`;
    if (path !== expected) {
      throw new PortableProjectError('portable_markdown_invalid', [
        path,
        `file name must be ${agent.name}${AGENT_MARKDOWN_SUFFIX}`,
      ]);
    }
    agents.push(agent);
  }
  return agents;
}

/**
 * Assembles the {@link PortableProject} every translator takes: the project's TS agents (from the
 * bodies) and `agents/*.agent.md` agents, the root and its subagents, and the bytes of the skills,
 * knowledge files and OpenAPI documents they reference, read through `input.source`. A skill
 * directory the project lacks, and everything a conversion cannot carry, are reported in `dropped`.
 * Reads are sequential and sorted, so the answer is deterministic.
 *
 * @throws {PortableProjectError} when an agent is defined twice, the root is unknown, an
 *   `.agent.md` file is invalid, or the assembled project (or an answer of the source) is invalid.
 * @throws {DefinitionError} when a body cannot be converted (see `portableFromAgentVersionBody`).
 */
export async function loadPortableProject(
  input: LoadPortableProjectInput,
): Promise<PortableProjectLoad> {
  const { project, source } = input;
  const bodyDrops: PortableDrop[] = [];
  const agents = new Map<string, PortableAgent>();
  const add = (agent: PortableAgent): void => {
    if (agents.has(agent.name)) {
      throw new PortableProjectError('portable_agent_duplicate', [agent.name]);
    }
    agents.set(agent.name, agent);
  };

  for (const agent of await markdownAgents(source)) add(agent);

  const { codeToolNames } = input;
  const declarations = new Map((input.codeTools ?? []).map((tool) => [tool.name, tool]));
  for (const body of input.bodies) {
    const own = body.definition.agent.name;
    const codeTools: PortableCodeToolDeclaration[] = [];
    const listed = codeToolNames !== undefined && Object.hasOwn(codeToolNames, own);
    if (codeToolNames !== undefined && !listed) {
      body.definition.resources.connectors.forEach((connector, index) => {
        if (connector === AW_DEV_TOOLS_CONNECTOR) {
          bodyDrops.push({
            path: `${own}.definition.resources.connectors.${index}`,
            reason: `the code tools of ${own} could not be resolved: codeToolNames has no entry for it`,
          });
        }
      });
    }
    for (const name of listed ? (codeToolNames[own] ?? []) : []) {
      const declaration = declarations.get(name);
      if (declaration === undefined) {
        bodyDrops.push({
          path: `${own}.codeTools.${name}`,
          reason: `no declaration was given for the code tool ${name}`,
        });
      } else {
        codeTools.push(declaration);
      }
    }
    const converted = portableFromAgentVersionBody(body, {
      connectors: project.connectors,
      models: project.models,
      catalogTools: input.catalogTools,
      codeTools: codeToolNames === undefined ? undefined : codeTools,
    });
    for (const drop of converted.dropped) {
      bodyDrops.push({ path: `${converted.value.name}.${drop.path}`, reason: drop.reason });
    }
    add(converted.value);
  }

  const root = agents.get(input.root);
  if (root === undefined) {
    throw new PortableProjectError('portable_root_unknown', [
      input.root,
      ...[...agents.keys()].sort(),
    ]);
  }
  // One level only: a subagent's own subagents are left for the schema to refuse.
  const kept = [root];
  for (const { name } of root.subagents) {
    const subagent = agents.get(name);
    if (subagent !== undefined) kept.push(subagent);
  }
  // An agent outside the export has nothing to warn about; names hold no `.`.
  const keptNames = new Set(kept.map((agent) => agent.name));
  const dropped = bodyDrops.filter((drop) =>
    keptNames.has(drop.path.slice(0, drop.path.indexOf('.'))),
  );

  const skillNames = [
    ...new Set(kept.flatMap((agent) => agent.skills.map((skill) => skill.name))),
  ].sort();
  const skills: { name: string; files: { path: string; content: string | Uint8Array }[] }[] = [];
  const absent = new Set<string>();
  for (const name of skillNames) {
    const directory = `skills/${name}`;
    const files = await readFiles(source, await listUnder(source, directory), `${directory}/`);
    if (files.length === 0) absent.add(name);
    else skills.push({ name, files });
  }
  const resolved = kept.map((agent) => {
    if (!agent.skills.some((skill) => absent.has(skill.name))) return agent;
    agent.skills.forEach((skill, index) => {
      if (absent.has(skill.name)) {
        dropped.push({
          path: `${agent.name}.skills.${index}`,
          reason: `skills/${skill.name}/ is not in the project`,
        });
      }
    });
    return { ...agent, skills: agent.skills.filter((skill) => !absent.has(skill.name)) };
  });

  const knowledgePaths = [
    ...new Set(
      resolved.flatMap((agent) =>
        agent.knowledge.flatMap((entry) => (entry.kind === 'files' ? entry.paths : [])),
      ),
    ),
  ].sort();
  const knowledgeFiles = await readFiles(source, knowledgePaths, '');

  // An https: ref is never fetched; the loader does not touch the network.
  const specRefs = [
    ...new Set(
      resolved.flatMap((agent) =>
        agent.tools.flatMap((tool) =>
          tool.kind === 'openapi' && PortableRelativePathSchema.safeParse(tool.specRef).success
            ? [tool.specRef]
            : [],
        ),
      ),
    ),
  ].sort();
  const openapiSpecs: { ref: string; content: string }[] = [];
  for (const ref of specRefs) {
    const bytes = await readBytes(source, ref);
    if (bytes === null) {
      resolved.forEach((agent) => {
        agent.tools.forEach((tool, index) => {
          if (tool.kind === 'openapi' && tool.specRef === ref) {
            dropped.push({
              path: `${agent.name}.tools.${index}`,
              reason: `the OpenAPI spec file ${ref} is not in the project`,
            });
          }
        });
      });
      continue;
    }
    const content = decodeStrict(bytes);
    if (content === null) {
      throw new PortableProjectError('portable_project_invalid', [`${ref}: must be UTF-8 text`]);
    }
    openapiSpecs.push({ ref, content });
  }

  const parsed = PortableProjectSchema.safeParse({
    root: input.root,
    agents: resolved,
    skills,
    knowledgeFiles,
    openapiSpecs,
    ...(input.toolEndpoint === undefined ? {} : { toolEndpoint: input.toolEndpoint }),
  });
  if (!parsed.success) {
    throw new PortableProjectError(
      'portable_project_invalid',
      issuesFromZod(parsed.error).map((issue) =>
        issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`,
      ),
    );
  }
  return Object.freeze({
    project: parsed.data,
    dropped: Object.freeze(dropped.map((drop) => Object.freeze({ ...drop }))),
  });
}
