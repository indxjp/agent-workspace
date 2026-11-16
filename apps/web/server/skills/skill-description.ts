/** Skill reads, imports, revisions and file exports over the storage ports. */
import {
  SKILL_MD_FILENAME,
  type SkillDetail as ContractSkillDetail,
  type SkillSummary as ContractSkillSummary,
} from '@indx-workspace/contracts/skills';
import { skillFilesPrefix, skillRowFolder } from './keys';
import { extractSkillInstructions, parseSkillFrontmatter } from './frontmatter';
import type { SkillObjects } from '../storage-and-sharing';
import type { ApiResult } from '../http/result';
import { problem } from './result';
import { skillFiles, type SkillRows } from './tree';
import { type SkillMetaRecord } from './skill-metadata';

// ── Assembling a response ─────────────────────────────────────────────────────────────────────

export type SkillSummary = Omit<ContractSkillSummary, 'id'>;

/*
 * `source` is the complete UTF-8 SKILL.md text so an editor can preserve unrecognised frontmatter
 * fields. `instructions` is SKILL.md's Markdown body (spec §7 "Instructions"); `null` only when its
 * bytes are not valid UTF-8 — see `frontmatter.ts`'s `extractSkillInstructions`. Round 2, B4.
 * `allowedTools` is parsed from frontmatter's `allowed-tools` (spec §7 "Allowed Tools"); `null` when
 * the field is absent or unrecognised — see `frontmatter.ts`'s module header. Round 2, B4.
 */
export type SkillDetail = Omit<ContractSkillDetail, 'id'>;

// @story US-STO-08
export async function describeSkill(
  store: SkillObjects,
  meta: SkillMetaRecord,
  rows?: SkillRows,
): Promise<SkillDetail> {
  const files = await skillFiles(
    store,
    rows,
    skillRowFolder(meta.name),
    skillFilesPrefix(meta.name),
  );
  const skillMd =
    (await files.find((file) => file.relativePath === SKILL_MD_FILENAME)?.read()) ?? null;
  const frontmatter = skillMd === null ? {} : parseSkillFrontmatter(skillMd);
  const instructions = skillMd === null ? null : extractSkillInstructions(skillMd);
  const source =
    skillMd === null || instructions === null
      ? null
      : new TextDecoder('utf-8', { fatal: true }).decode(skillMd);
  // Sizes come from the `list` that `walkFiles` already performed. Reading each file back with
  // `get` would make describing one skill cost its whole directory in bytes, and `listSkills`
  // calls this once per skill — a workspace's entire skill corpus, read on every list request.
  const sizes = files.map((file) => ({ path: file.relativePath, sizeBytes: file.sizeBytes }));
  return {
    name: meta.name,
    enabled: meta.enabled,
    description: frontmatter.description ?? null,
    source,
    instructions,
    allowedTools: frontmatter.allowedTools ?? null,
    fileCount: files.length,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    files: sizes,
  };
}

/**
 * K-4 (issue #234): the one answer every route that must carry a catalog `id` gives for a row whose
 * `SKILL.md` is missing or not valid UTF-8. `POST`/`PATCH` refuse to create that state, so it can
 * only be a pre-existing row; `id` is required on every `SkillDetail`
 * (`packages/contracts/src/skills.ts`) and no catalog row can be written for a blank `skill_md`
 * (`skills_skill_md_not_blank`), so there is no id to give the row honestly. Answering without the
 * id would be the silent narrowing this repository forbids elsewhere, and a 5xx is the documented
 * standard for an infrastructure inconsistency — the cost, and the repair paths (`PATCH` with a
 * valid `SKILL.md`, or `DELETE`), are recorded in this unit's implementation plan, open
 * question 3. Exported so `GET`/`PATCH /api/skills/:name` answer it in the same words as
 * {@link listSkills} rather than disagreeing about one row.
 */
export function unreadableSkillMdProblem(name: string): ApiResult {
  return problem(
    500,
    'store_inconsistent',
    `The skill ${JSON.stringify(name)} has no readable ${SKILL_MD_FILENAME} (missing or not ` +
      'valid UTF-8), so it cannot be answered with the id every skill now carries. Repair it ' +
      `with PATCH /api/skills/${encodeURIComponent(name)} carrying a valid ${SKILL_MD_FILENAME}.`,
  );
}
