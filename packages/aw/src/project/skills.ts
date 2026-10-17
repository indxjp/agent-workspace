import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  SKILL_MD_FILENAME,
  SKILL_NAME_PATTERN,
  type SkillFile,
} from '@indx-workspace/contracts/skills';
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';
import {
  planProjectSkills,
  ProjectFileError,
  readProjectFileText,
  type ProjectSkill,
} from '@indx-workspace/sdk/project';

import { readSkillDirectory, uploadSkill } from '../commands/skills.js';
import { UsageError } from '../io.js';
import { localProblem, problemsFromError, type ProjectProblem } from './problems.js';

/** The project directory whose folders are skills, one `skills/<name>/` each. */
const SKILLS_DIRECTORY = 'skills';

/** `sha256:<hex>` over the file paths and bytes in the order {@link readSkillDirectory} returns them (by code unit), so a path or content change changes it. */
function skillHash(files: readonly SkillFile[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${file.path}\0${file.contentBase64}\0`);
  }
  return `sha256:${hash.digest('hex')}`;
}

/** What {@link readProjectSkills} found under `skills/`. */
export interface ProjectSkills {
  /** Every folder's name, valid or not, so a reference to a refused folder is not also "missing". */
  readonly names: ReadonlySet<string>;
  /** Whether `skills/` exists at all, so an emptied one still lists what only the workspace has. */
  readonly present: boolean;
  /** The folders that passed the import checks, ready for `planProjectResources`. */
  readonly skills: readonly ProjectSkill[];
  readonly problems: readonly ProjectProblem[];
}

/** Where and why a `SKILL.md`'s frontmatter is refused; `line` and `column` are one-based. */
interface FrontmatterRefusal {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

/**
 * The first reason `SKILL.md` (`text`, in folder `name`) is not a skill an engine can load, or
 * `undefined`: a `---` frontmatter block first, valid YAML, with `name` equal to the folder and a
 * non-empty `description` (the Agent Skills format). The server stores whatever it is given, so
 * this is the only place a broken one is caught before an agent runs without it (BH061-021).
 */
function skillMdRefusal(name: string, text: string): FrontmatterRefusal | undefined {
  const lines = (text.startsWith('\uFEFF') ? text.slice(1) : text).split(/\r\n|\r|\n/u);
  const fence = (line: string | undefined): boolean => line?.trim() === '---';
  const at = (line: number, message: string): FrontmatterRefusal => ({ line, column: 1, message });
  if (!fence(lines[0])) {
    return at(
      1,
      `${SKILL_MD_FILENAME} must start with frontmatter: ---, name: ${name}, description: <when to use it>, ---`,
    );
  }
  const end = lines.findIndex((line, index) => index > 0 && fence(line));
  if (end < 0) return at(1, 'the frontmatter opened on line 1 has no closing ---');
  const label = 'frontmatter';
  let reading;
  try {
    reading = readProjectFileText(lines.slice(1, end).join('\n'), label);
  } catch (error) {
    if (!(error instanceof ProjectFileError)) throw error;
    const prefix = `${label} line ${String(error.line)}, column ${String(error.column)}: `;
    const message = error.message.startsWith(prefix)
      ? error.message.slice(prefix.length)
      : error.message;
    return { line: error.line + 1, column: error.column, message };
  }
  const { value, locate } = reading;
  const fields = new Map<string, unknown>(
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.entries(value)
      : [],
  );
  const where = (key: string, message: string): FrontmatterRefusal => {
    const position = locate([key]);
    return { line: position.line + 1, column: position.column, message };
  };
  if (!fields.has('name')) return at(1, `the frontmatter has no name: add name: ${name}`);
  if (fields.get('name') !== name) return where('name', `name must be the folder's name, ${name}`);
  const description = fields.get('description');
  if (typeof description === 'string' && description.trim() !== '') return undefined;
  return fields.has('description')
    ? where('description', 'description must be a non-empty string')
    : at(1, 'the frontmatter has no description: add description: <when to use it>');
}

/**
 * Read `skills/*` and hold each folder to what `aw skills import` and the server hold it to: a
 * skill-name folder with a UTF-8 `SKILL.md`, and to the frontmatter {@link skillMdRefusal} checks,
 * which the server stores without reading.
 */
export async function readProjectSkills(root: string): Promise<ProjectSkills> {
  let entries;
  try {
    entries = await readdir(path.join(root, SKILLS_DIRECTORY), { withFileTypes: true });
  } catch {
    return { names: new Set(), present: false, skills: [], problems: [] };
  }
  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const skills: ProjectSkill[] = [];
  const problems: ProjectProblem[] = [];
  for (const name of folders) {
    const file = `${SKILLS_DIRECTORY}/${name}`;
    const refuse = (detail: string): void => {
      problems.push(localProblem(file, 'invalid_skill', [detail]));
    };
    if (!SKILL_NAME_PATTERN.test(name)) {
      refuse('the folder name must be lower-case letters, digits and inner hyphens, at most 64');
      continue;
    }
    let files: SkillFile[];
    try {
      files = await readSkillDirectory(path.join(root, file));
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      refuse(error.message.replace(path.join(root, file), file));
      continue;
    }
    const skillMd = files.find((candidate) => candidate.path === SKILL_MD_FILENAME);
    if (skillMd === undefined) {
      refuse(`${SKILL_MD_FILENAME} is missing`);
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.from(skillMd.contentBase64, 'base64'),
      );
    } catch {
      refuse(`${SKILL_MD_FILENAME} is not valid UTF-8`);
      continue;
    }
    const refusal = skillMdRefusal(name, text);
    if (refusal !== undefined) {
      const skillFile = `${file}/${SKILL_MD_FILENAME}`;
      problems.push({
        ...localProblem(skillFile, 'invalid_skill', [refusal.message]),
        location: { file: skillFile, line: refusal.line, column: refusal.column },
      });
      continue;
    }
    skills.push({ name, files, hash: skillHash(files) });
  }
  return { names: new Set(folders), present: true, skills, problems };
}

/** The Levenshtein distance between two short names. */
function distance(left: string, right: string): number {
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= right.length; j += 1) {
      next.push(
        Math.min(
          (next[j - 1] ?? 0) + 1,
          (row[j] ?? 0) + 1,
          (row[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1),
        ),
      );
    }
    row = next;
  }
  return row[right.length] ?? 0;
}

/** The candidate closest to `name`, or `undefined` when none is within half its length. */
export function nearestName(name: string, candidates: Iterable<string>): string | undefined {
  let best: { readonly name: string; readonly score: number } | undefined;
  for (const candidate of candidates) {
    const score = distance(name, candidate);
    if (best === undefined || score < best.score) best = { name: candidate, score };
  }
  return best !== undefined && best.score <= Math.ceil(name.length / 2) ? best.name : undefined;
}

/**
 * One problem per `skill('x')` an agent names that is neither a `skills/` folder nor a workspace
 * skill, naming it with the nearest known name when there is one.
 */
export function missingSkillProblems(
  agent: { readonly file: string; readonly skills: readonly string[] },
  known: ReadonlySet<string>,
): readonly ProjectProblem[] {
  return agent.skills
    .filter((name) => !known.has(name))
    .map((name) => {
      const near = nearestName(name, known);
      return localProblem(agent.file, 'skill_not_found', [
        `skill('${name}') is not in skills/ or the workspace` +
          (near === undefined ? '' : ` (did you mean '${near}'?)`),
      ]);
    });
}

/** What `skills/` says about the workspace: one entry per valid folder, and the names only the workspace has. */
export interface SkillSync {
  readonly skills: readonly {
    readonly name: string;
    readonly action: 'create' | 'update' | 'unchanged';
    readonly files: number;
  }[];
  /** Workspace skills with no folder: never deleted from here (deleting needs `--yes`, S2). */
  readonly workspaceOnly: readonly string[];
}

export const NO_SKILL_SYNC: SkillSync = { skills: [], workspaceOnly: [] };

/**
 * Plan each `skills/<name>/` folder against the workspace skill of the same name (the hash the
 * planner expects, over the exported files in path order) and, with `yes`, create or update it
 * through {@link uploadSkill}. Runs before agent versions are saved, which name the skill. A
 * refused list, export or upload is a problem on `skills/` or `skills/<name>`, not a throw.
 */
export async function syncProjectSkills(options: {
  readonly client: AgentWorkspaceClient;
  readonly root: string;
  readonly signal: AbortSignal;
  readonly yes: boolean;
}): Promise<{ readonly skills: SkillSync; readonly problems: readonly ProjectProblem[] }> {
  const { client, signal } = options;
  const folders = await readProjectSkills(options.root);
  if (!folders.present) return { skills: NO_SKILL_SYNC, problems: [] };
  let workspace: Set<string>;
  try {
    workspace = new Set((await client.skills.list({ signal })).map((skill) => skill.name));
  } catch (error) {
    return { skills: NO_SKILL_SYNC, problems: problemsFromError(error, SKILLS_DIRECTORY, []) };
  }
  const problems: ProjectProblem[] = [];
  // The workspace's copy of each same-named folder, hashed over its exported files in path order.
  const existing: { name: string; hash: string; files: SkillFile[] }[] = [];
  for (const { name } of folders.skills) {
    if (!workspace.has(name)) continue;
    try {
      const exported = await client.skills.export(name, { signal });
      const sorted = exported.files.toSorted((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
      existing.push({ name, hash: skillHash(sorted), files: sorted });
    } catch (error) {
      problems.push(...problemsFromError(error, `${SKILLS_DIRECTORY}/${name}`, []));
    }
  }
  const failed = new Set(problems.map((problem) => problem.file));
  const planned = planProjectSkills({
    skills: folders.skills.filter(({ name }) => !failed.has(`${SKILLS_DIRECTORY}/${name}`)),
    existing,
  });
  const skills: SkillSync['skills'][number][] = [];
  for (const { action, name, files } of planned) {
    try {
      if (action !== 'unchanged' && options.yes) {
        const old = existing.find((entry) => entry.name === name)?.files;
        await uploadSkill(
          client,
          { name, files, ...(old === undefined ? {} : { existing: old }) },
          signal,
        );
      }
      skills.push({ name, action, files: files.length });
    } catch (error) {
      problems.push(...problemsFromError(error, `${SKILLS_DIRECTORY}/${name}`, []));
    }
  }
  const workspaceOnly = [...workspace].filter((name) => !folders.names.has(name)).sort();
  return { skills: { skills, workspaceOnly }, problems };
}
