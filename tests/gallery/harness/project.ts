/**
 * Load a gallery use case's project directory the way `aw check` sees it, offline.
 *
 * `aw check` loads `agents/*.ts` and `surfaces/*.ts`, reads each agent's instructions file, turns
 * the agent and its surfaces into an `AgentVersionBody` with `toAgentVersionBody` (which applies
 * `AgentVersionBodySchema`, the contract the server applies), and reads `agent-workspace.yaml` and
 * `evals/<agent>.yaml` with the SDK's project reader. This module does the same with the same
 * public functions, so a definition that loads here is one the server's contract accepts. What it
 * cannot prove is the server's own checks beyond the contract (an engine that cannot run a tool,
 * a connector that does not exist yet); those need a workspace, and the benchmark says so.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';
import type { EvalCaseFile } from '@indx-workspace/contracts/evaluations';
import type { ProjectDocument } from '@indx-workspace/contracts/project-file';
import type { ImportSkillInput } from '@indx-workspace/contracts/skills';
import {
  isDefinedAgent,
  isDefinedSurface,
  toAgentVersionBody,
  type DefinedAgent,
  type DefinedSurface,
} from '@indx-workspace/sdk/define';
import { parseProjectFile, readEvalCaseFile } from '@indx-workspace/sdk/project';

const SHARED_SKILLS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'shared',
  'skills',
);

export interface GalleryAgent {
  readonly file: string;
  readonly definition: DefinedAgent;
  readonly body: AgentVersionBody;
  readonly evals: EvalCaseFile | null;
}

export interface GalleryProject {
  readonly dir: string;
  /** `agent-workspace.yaml`, read and validated as a v2 project file. */
  readonly project: ProjectDocument;
  readonly agents: readonly GalleryAgent[];
  readonly surfaces: readonly DefinedSurface[];
  /**
   * Every skill the agents use, as the body `aw.skills.import` sends: the project's own under
   * `skills/`, then any shared one under `tests/gallery/shared/skills/` (such as `office-reader`,
   * which two use cases import once into the same workspace).
   */
  readonly skills: readonly ImportSkillInput[];
}

async function definitionFiles(dir: string, folder: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(dir, folder), { withFileTypes: true });
    return entries
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts'),
      )
      .map((entry) => `${folder}/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
}

async function filesUnder(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? filesUnder(root, full) : [full];
    }),
  );
  return nested.flat().sort();
}

/** Read `skills/<name>/**` into the body `aw.skills.import` sends: relative paths and base64. */
export async function readSkill(dir: string): Promise<ImportSkillInput> {
  const files = await filesUnder(dir);
  return {
    name: path.basename(dir),
    files: await Promise.all(
      files.map(async (file) => ({
        path: path.relative(dir, file).split(path.sep).join('/'),
        contentBase64: (await readFile(file)).toString('base64'),
      })),
    ),
  };
}

async function readSkills(dir: string): Promise<ImportSkillInput[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readSkill(path.join(dir, entry.name))),
    );
  } catch {
    return [];
  }
}

async function readEvals(dir: string, agentName: string): Promise<EvalCaseFile | null> {
  const file = path.join(dir, 'evals', `${agentName}.yaml`);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  return readEvalCaseFile(text, `evals/${agentName}.yaml`);
}

/**
 * The default exports of a project's definition files, keyed by their path in the project
 * (`agents/<name>.ts`, `surfaces/<name>.ts`). The caller imports them statically: the
 * repository's import-boundary gate (`tests/no-sdk-import.test.ts`) refuses a computed
 * `import()`, because no static walk could tell which module it reaches.
 */
export type ProjectDefinitions = Readonly<Record<string, unknown>>;

/**
 * Load and contract-check the project in `dir`. Throws the SDK's own error on any refusal, and
 * refuses `definitions` that do not cover exactly the files `aw check` would load.
 */
export async function loadGalleryProject(
  dir: string,
  definitions: ProjectDefinitions,
): Promise<GalleryProject> {
  const read = parseProjectFile(await readFile(path.join(dir, 'agent-workspace.yaml'), 'utf8'));
  // The SDK lifts a v1 `Deployment` profile for old projects; a gallery project is written as v2.
  if (read.lifted) throw new Error(`${dir}/agent-workspace.yaml is a v1 profile; write it as v2`);
  const { project } = read;

  const agentFiles = await definitionFiles(dir, 'agents');
  const surfaceFiles = await definitionFiles(dir, 'surfaces');
  const expected = [...agentFiles, ...surfaceFiles].sort();
  const given = Object.keys(definitions).sort();
  if (expected.join('\n') !== given.join('\n')) {
    throw new Error(`definitions must be exactly ${expected.join(', ')}; got ${given.join(', ')}`);
  }

  const surfaces: DefinedSurface[] = [];
  for (const file of surfaceFiles) {
    const value = definitions[file];
    if (!isDefinedSurface(value))
      throw new Error(`${file} does not default-export defineSurface()`);
    surfaces.push(value);
  }

  const agents: GalleryAgent[] = [];
  for (const file of agentFiles) {
    const definition = definitions[file];
    if (!isDefinedAgent(definition))
      throw new Error(`${file} does not default-export defineAgent()`);
    const source = definition.instructions;
    const instructions =
      typeof source === 'string'
        ? undefined
        : await readFile(path.join(dir, path.dirname(file), source.file), 'utf8');
    const body = toAgentVersionBody(definition, {
      surfaces: surfaces.filter((surface) => surface.agent === definition.name),
      instructions,
      defaultEngine: project.engine,
    });
    agents.push({ file, definition, body, evals: await readEvals(dir, definition.name) });
  }

  const skills = await readSkills(path.join(dir, 'skills'));
  const used = new Set(
    agents.flatMap((agent) => (agent.definition.skills ?? []).map((entry) => entry.name)),
  );
  for (const name of used) {
    if (skills.some((skill) => skill.name === name)) continue;
    skills.push(await readSkill(path.join(SHARED_SKILLS_DIR, name)));
  }
  return { dir, project, agents, surfaces, skills };
}
