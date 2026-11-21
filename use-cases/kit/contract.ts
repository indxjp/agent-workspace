/**
 * The contract tier's checks beyond loading (SSOT §5.1, §5.3): each is pure, takes what
 * `loadGalleryProject` read, and returns the problems it finds; empty means the check passes.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';
import type { EvalCaseFile } from '@indx-workspace/contracts/evaluations';
import { needsApproval } from '@indx-workspace/contracts/agents';

import type { CatalogEntry } from '../../examples/store/catalog/define.ts';

/**
 * The four kinds of eval case every entry ships (SSOT §5.3), each named by a case's `tags`: its
 * suggested prompt, a prompt in the other language, an out-of-scope prompt it must decline, and
 * one that exercises the safety property it claims.
 */
const EVAL_KINDS = ['suggested', 'other-language', 'out-of-scope', 'safety'] as const;
const MIN_EVAL_CASES = 4;
/** The promotion bar, `policy.promotion.minEvalScore` in the project file. */
const PROMOTION_BAR = 0.9;

/** The part of a defined agent these checks read. */
interface AgentShape {
  readonly name: string;
  readonly files?: readonly { readonly path: string }[] | undefined;
}

/** Why the eval file of the entry's agent falls short of SSOT §5.3; `minEvalScore` is the project's bar. */
export function evalProblems(
  slug: string,
  evals: EvalCaseFile | null,
  minEvalScore: number | undefined,
): string[] {
  if (evals === null) return [`${slug}: no evals/${slug}.yaml`];
  const problems: string[] = [];
  if (evals.cases.length < MIN_EVAL_CASES) {
    problems.push(
      `${slug}: evals/${slug}.yaml has ${String(evals.cases.length)} cases, fewer than ${String(MIN_EVAL_CASES)}`,
    );
  }
  const tags = new Set(evals.cases.flatMap((evalCase) => evalCase.tags ?? []));
  const missing = EVAL_KINDS.filter((kind) => !tags.has(kind));
  if (missing.length > 0) {
    problems.push(`${slug}: no eval case tagged ${missing.join(', ')}`);
  }
  if (minEvalScore === undefined || minEvalScore < PROMOTION_BAR) {
    problems.push(
      `${slug}: agent-workspace.yaml policy.promotion.minEvalScore is ${String(minEvalScore)}, below ${String(PROMOTION_BAR)}`,
    );
  }
  return problems;
}

/** What the catalog check reads of a loaded project. */
export interface SourceShape {
  readonly dir: string;
  readonly name: string;
  readonly agents: readonly AgentShape[];
}

/**
 * Why the catalog entry for `slug` and the source in `source.dir` disagree: no entry, a project
 * named otherwise, or, for a live entry, another source or kind, a demo agent the project does not
 * define, or a seed folder the demo agent is not granted or the source does not hold. A coming-soon
 * entry has no source yet, so its folder is the one being built.
 */
export function catalogEntryProblems(
  slug: string,
  source: SourceShape,
  catalog: readonly CatalogEntry[],
): string[] {
  const entry = catalog.find((candidate) => candidate.slug === slug);
  if (entry === undefined) return [`${slug}: no catalog entry`];
  const problems: string[] = [];
  if (source.name !== slug) {
    problems.push(`${slug}: agent-workspace.yaml is named ${source.name}`);
  }
  if (entry.status !== 'live') return problems;
  if (entry.source !== `use-cases/${slug}`) {
    problems.push(`${slug}: the entry's source is ${entry.source}`);
  }
  if (entry.kind !== 'agent') problems.push(`${slug}: the entry's kind is ${entry.kind}`);
  const agent = source.agents.find((candidate) => candidate.name === entry.demo.agent);
  if (agent === undefined) {
    return [...problems, `${slug}: no agent ${entry.demo.agent} for the demo`];
  }
  const granted = new Set((agent.files ?? []).map((grant) => grant.path));
  for (const { collection, from } of entry.demo.seed) {
    if (!granted.has(collection)) {
      problems.push(`${slug}: seeds ${collection}, which ${agent.name} is not granted`);
    }
    const folder = path.join(source.dir, from);
    if (!existsSync(folder) || !statSync(folder).isDirectory()) {
      problems.push(`${slug}: no seed folder ${from}`);
    }
  }
  return problems;
}

/** The suffix of an entry's output folder, `<slug>-reports`; no catalog slug ends in it. */
export const OUTPUT_SUFFIX = '-reports';

/**
 * Why an agent of the entry `slug` is granted a folder that is not the entry's own. Every folder an
 * entry reads or writes is named from its slug: the slug itself (`nda`, with subfolders such as
 * `nda/inbox`) or its output folder `<slug>-reports` (and its subfolders). No slug ends in
 * `-reports` (`tests/store/catalog.test.ts`), so two entries never share a seed collection or an
 * output folder in one visitor's workspace (the catalog refuses a shared seed collection), and a
 * second entry of an archetype keeps the template's agent file unedited.
 */
export function folderProblems(slug: string, agents: readonly AgentShape[]): string[] {
  const output = `${slug}${OUTPUT_SUFFIX}`;
  const own = (folder: string): boolean =>
    [slug, output].some((root) => folder === root || folder.startsWith(`${root}/`));
  return agents.flatMap((agent) =>
    (agent.files ?? [])
      .filter((grant) => !own(grant.path))
      .map(
        (grant) =>
          `${agent.name}: grants ${grant.path}, which is not named from ${slug} (${slug}, ${output} or a subfolder of either)`,
      ),
  );
}

/**
 * The titles of `describeUseCase`'s contract tests, under `describe(slug)` and `describe('contract')`:
 * the scoreboard marks Contract done only when every one of them ran and passed.
 */
export const CONTRACT_TESTS = {
  loads: 'loads the way aw check loads it',
  evals: 'ships at least four eval cases of the four kinds, with the promotion bar',
  catalog: 'agrees with its catalog entry',
  writes: 'writes no file without approval',
  folders: 'grants only folders named from its slug',
  imports: 'grants every built-in skill its scripts import',
} as const;

/** The skill that writes Office files (ADR-0167), through `run_skill_script`. */
const OFFICE_WRITER = 'office-writer';
const RUN_SKILL_SCRIPT = ['run_skill_script', 'mcp__agent-workspace__run_skill_script'];
/** The shell tool, which writes outside the engine's `Write`/`Edit` rules. */
const SHELL_TOOL = 'Bash';
/** Permission modes in which a call runs without anyone approving it. */
const UNATTENDED_MODES: ReadonlySet<string> = new Set(['bypassPermissions', 'auto']);

/**
 * ADR-0167 D5, issue #2388: a skill script must not write without a person's approval, so an agent
 * whose scripts can write must not auto-approve `run_skill_script`. A script can write when the
 * agent grants `office-writer`, holds `writeFiles` (its scripts may write `outputs/`) or has a
 * read-write file grant (the engine passes every one to the script's `--allow-fs-write`, so even a
 * reader such as `office-reader`, whose modes can write a file, could overwrite one). Read from the
 * compiled version body (`toAgentVersionBody`), the policy the server stores and the engine runs.
 *
 * An agent that grants `office-writer` is also refused when it auto-approves `Bash`: the engine
 * denies its `Write` and `Edit` under `outputs/` (#2420), but a shell command is outside that deny
 * and is held back only by Bash's own approval gate. Running every call unattended
 * (`bypassPermissions`, `auto`) is already refused above.
 */
export function unattendedWriteProblems(bodies: readonly AgentVersionBody[]): string[] {
  return bodies.flatMap(({ definition }) => {
    const { policy, resources, agent } = definition;
    const officeWriter = resources.skills.includes(OFFICE_WRITER);
    const writers = [
      ...(officeWriter ? [`grants ${OFFICE_WRITER}`] : []),
      ...(agent.permissions.writeFiles ? ['holds writeFiles'] : []),
      ...resources.files
        .filter((grant) => grant.access === 'read-write')
        .map((grant) => `grants ${grant.path} read-write`),
    ];
    const tools = 'tools' in policy ? policy.tools : null;
    const auto =
      tools !== null &&
      (UNATTENDED_MODES.has(tools.permissionMode) ||
        RUN_SKILL_SCRIPT.some((tool) => needsApproval(tools.autoApprove, tool)));
    const shell = officeWriter && tools !== null && needsApproval(tools.autoApprove, SHELL_TOOL);
    return [
      ...(writers.length > 0 && auto
        ? [
            `${agent.name}: ${writers.join(', ')} and auto-approves run_skill_script, so a skill script would write a file without approval (ADR-0167 D5, #2388)`,
          ]
        : []),
      ...(shell
        ? [
            `${agent.name}: grants ${OFFICE_WRITER} and auto-approves Bash, so a shell command could write a file outside the outputs/ deny without approval (ADR-0167 D5, #2420)`,
          ]
        : []),
    ];
  });
}

/** The package path a skill script imports a built-in skill's module by (ADR-0173). */
const BUILTIN_IMPORT = /@indx-workspace\/builtin-skills\/([a-z0-9-]+)\//gu;
const SCRIPT_FILE = /\.(?:[cm]?js|[cm]?ts)$/u;

/** Every script file under `dir`, relative to it with `/` separators; none when it is absent. */
function scriptFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SCRIPT_FILE.test(entry.name))
    .map((entry) =>
      path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
    )
    .sort();
}

/**
 * ADR-0173: a skill script that imports a built-in skill's module (`@indx-workspace/builtin-skills/
 * <name>/…`) runs only when the agent grants that built-in skill, because `run_skill_script`
 * resolves the import to the placed copy. For each agent, each of its own skills (the folders
 * under `<dir>/skills/`) is read for such imports, and a name the agent does not grant is a problem.
 */
export function builtinImportProblems(dir: string, bodies: readonly AgentVersionBody[]): string[] {
  return bodies.flatMap(({ definition }) => {
    const granted = definition.resources.skills;
    return granted.flatMap((skill) => {
      const scripts = path.join(dir, 'skills', skill, 'scripts');
      return scriptFiles(scripts).flatMap((file) => {
        const text = readFileSync(path.join(scripts, file), 'utf8');
        const names = [...new Set([...text.matchAll(BUILTIN_IMPORT)].map((match) => match[1]))];
        return names
          .filter((name) => name !== undefined && !granted.includes(name))
          .map(
            (name) =>
              `${definition.agent.name}: skills/${skill}/scripts/${file} imports @indx-workspace/builtin-skills/${String(name)}/, so the agent grants builtinSkill('${String(name)}') (ADR-0173)`,
          );
      });
    });
  });
}
