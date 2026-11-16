import type { RunSkillReference } from '@agent-workspace/run-protocol';
import { skillRevisionPrefix, skillRevisionRowFolder, skillRowFolder } from '../skills/keys';
import { skillFiles } from '../skills/tree';
import {
  type RunFileSource,
  type AgentRunResourceLoaderDependencies,
} from './resource-loader-contract';
import { referenceOf } from './resource-loader-files';

/** Where the archive puts a granted skill's file, relative to the run's cwd; the runner reads it there. */
function skillInboxPath(skill: string, file: string): string {
  return `.aw-inbox/skills/${skill}/${file}`;
}

/** Each file of each enabled skill as a reference (path, size, checksum); its bytes go to `sources`. */
async function loadSkills(context: {
  readonly workspaceId: string;
  readonly skillIds: readonly string[];
  readonly skillRevisions: Readonly<Record<string, number>>;
  readonly dependencies: AgentRunResourceLoaderDependencies;
  readonly sources: Map<string, RunFileSource>;
}): Promise<readonly RunSkillReference[]> {
  const { workspaceId, skillIds, skillRevisions, dependencies, sources } = context;

  if (skillIds.length === 0) return [];
  if (dependencies.skills === undefined) {
    throw new Error('this agent has assigned skills, but skill storage is not configured');
  }

  const catalog = await dependencies.catalog.forWorkspace(workspaceId);
  const byId = new Map((await catalog.listSkills()).map((skill) => [skill.id, skill]));
  const store = dependencies.skills.forWorkspace(workspaceId);
  const rows =
    dependencies.storage === undefined ? undefined : { storage: dependencies.storage, workspaceId };
  const out: RunSkillReference[] = [];
  for (const skillId of skillIds) {
    const skill = byId.get(skillId);
    if (skill === undefined) {
      throw new Error(`assigned skill ${skillId} disappeared before the run was composed`);
    }
    if (!skill.enabled) continue;
    // A pinned skill is the frozen revision (SDK-19, N-1); an unpinned one follows its current content.
    const pinned = skillRevisions[skillId];
    // @story US-STO-08
    const listed =
      pinned === undefined
        ? await skillFiles(store, rows, skillRowFolder(skill.name), `skills/${skill.name}`)
        : await skillFiles(
            store,
            rows,
            skillRevisionRowFolder(skill.name, pinned),
            skillRevisionPrefix(skill.name, pinned),
          );
    if (!listed.some((entry) => entry.relativePath === 'SKILL.md')) {
      throw new Error(`assigned skill ${JSON.stringify(skill.name)} has no SKILL.md`);
    }
    const files: { path: string; size: number; sha256: string }[] = [];
    for (const entry of listed) {
      if (dependencies.sizesOnly === true) {
        files.push({ path: entry.relativePath, size: entry.sizeBytes, sha256: '' });
        continue;
      }
      const source: RunFileSource = { objectId: null, open: () => entry.open() };
      const reference = await referenceOf(
        { sizeBytes: entry.sizeBytes, sha256: entry.sha256 },
        source,
        `assigned skill file ${JSON.stringify(entry.relativePath)}`,
      );
      sources.set(skillInboxPath(skill.name, entry.relativePath), source);
      files.push({ path: entry.relativePath, ...reference });
    }
    out.push({ name: skill.name, files });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
export { loadSkills, skillInboxPath };
