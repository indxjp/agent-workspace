/** Skill reads, imports, revisions and file exports over the storage ports. */
import { SKILL_MD_FILENAME } from '@indx-workspace/contracts/skills';
import { createCaseFoldGuard } from './keys';
import type { SkillObjects } from '../storage-and-sharing';
import type { ApiResult } from '../http/result';
import { json, problem } from './result';
import { ensureSkillRows, skillWriter, type SkillRowsWriter, type SkillWriter } from './tree';
import { decodeSkillFiles, type ReplacedFile } from './skill-content';
import { describeSkill } from './skill-description';
import { readSkillMeta, writeSkillMeta, type SkillMetaRecord } from './skill-metadata';
import { systemClock, type Clock } from '../clock';
import { writeRefusedProblem } from './skill-write-problems';
import { validatePatchBody, type ImportFileEntry } from './validate';

// ── PATCH /api/skills/:name ────────────────────────────────────────────────────────────────────

/** SKILL.md's bytes as the writer reads them, or `null` when it is missing. */
async function readSkillMd(writer: SkillWriter): Promise<Uint8Array | null> {
  const file = (await writer.files()).find((entry) => entry.relativePath === SKILL_MD_FILENAME);
  return (await file?.read()) ?? null;
}

export async function patchSkill(
  store: SkillObjects,
  name: string,
  rawBody: unknown,
  rows: SkillRowsWriter,
  clock: Clock = systemClock,
): Promise<ApiResult> {
  const meta = await readSkillMeta(store, name);
  if (meta === null) {
    return problem(404, 'skill_not_found', `No skill named ${JSON.stringify(name)}.`);
  }
  const validated = validatePatchBody(rawBody);
  if (!validated.ok) return validated.result;
  const { enabled, files, removeFiles } = validated.value;

  // Admissible paths are ASCII, so case-folding catches every allowed spelling of SKILL.md.
  const removesSkillMdByName =
    removeFiles?.some(
      (relativePath) => relativePath.toLowerCase() === SKILL_MD_FILENAME.toLowerCase(),
    ) === true;
  if (removesSkillMdByName) {
    return problem(
      400,
      'cannot_remove_skill_md',
      `"removeFiles" may not include ${JSON.stringify(SKILL_MD_FILENAME)} — spec §7 requires every ` +
        'skill directory to contain it.',
    );
  }

  // Migrate legacy files before checking aliases against the complete existing file set.
  if ((files?.length ?? 0) + (removeFiles?.length ?? 0) > 0) {
    try {
      await ensureSkillRows(store, rows, name);
    } catch (error) {
      return writeRefusedProblem(error);
    }
  }
  const writer = skillWriter(store, rows, name);
  const pathProblem = await patchPathProblem(writer, files ?? []);
  if (pathProblem !== null) return pathProblem;

  const decoded = decodeSkillFiles(files ?? []);
  if (!decoded.ok) return decoded.result;

  const writeProblem = await applySkillPatch(writer, decoded.files, removeFiles ?? []);
  if (writeProblem !== null) return writeProblem;

  const updated: SkillMetaRecord = {
    name: meta.name,
    enabled: enabled ?? meta.enabled,
    createdAt: meta.createdAt,
    updatedAt: clock.now().toISOString(),
  };
  await writeSkillMeta(store, updated);

  return json(200, { skill: await describeSkill(store, updated, rows) });
}

async function patchPathProblem(
  writer: SkillWriter,
  files: readonly ImportFileEntry[],
): Promise<ApiResult | null> {
  if (files.length > 0) {
    const existingPaths = (await writer.files()).map((file) => file.relativePath);
    const caseFoldGuard = createCaseFoldGuard(existingPaths);
    const seenInThisPatch = new Set<string>();
    for (const [index, file] of files.entries()) {
      if (seenInThisPatch.has(file.path)) {
        return problem(
          400,
          'duplicate_path',
          `files[${index}].path ${JSON.stringify(file.path)} is repeated.`,
        );
      }
      const collidesWith = caseFoldGuard.check(file.path);
      if (collidesWith !== null) {
        return problem(
          409,
          'colliding_paths',
          `files[${index}].path ${JSON.stringify(file.path)} and ${JSON.stringify(collidesWith)} ` +
            'are the same name once case is folded — a filesystem-backed store cannot be relied on ' +
            'to keep them as two files, so this patch is refused rather than silently overwriting ' +
            `one under the other's name. ${JSON.stringify(collidesWith)} may already be part of ` +
            'this skill, or may appear earlier in this same request\'s "files" array.',
        );
      }
      caseFoldGuard.add(file.path);
      seenInThisPatch.add(file.path);
    }
  }

  return null;
}

async function applySkillPatch(
  writer: SkillWriter,
  puts: readonly ReplacedFile[],
  deletes: readonly string[],
): Promise<ApiResult | null> {
  // Capture after puts, before deletes: recovery preserves this request's new manifest.
  let skillMdBeforeDelete: Uint8Array | null = null;

  try {
    for (const file of puts) await writer.put(file.path, file.bytes);
    if (deletes.length > 0) skillMdBeforeDelete = await readSkillMd(writer);
    for (const relativePath of deletes) await writer.remove(relativePath);
  } catch (error) {
    return writeRefusedProblem(error);
  }

  // A backend may alias paths unexpectedly. Restore the post-put manifest before refusing.
  if (deletes.length > 0) {
    if ((await readSkillMd(writer)) === null) {
      if (skillMdBeforeDelete !== null) {
        // Restore what this request itself had just made current (see the capture comment above),
        // so a caller sees a clean rejection rather than a permanently broken skill directory.
        await writer.put(SKILL_MD_FILENAME, skillMdBeforeDelete);
      }
      return problem(
        409,
        'skill_md_removal_rejected',
        `This patch's "removeFiles" would have removed ${JSON.stringify(SKILL_MD_FILENAME)} ` +
          "through a route this task's admission grammar did not predict — spec §7 requires " +
          'every skill directory to contain it. The request is refused' +
          (skillMdBeforeDelete !== null
            ? `; ${SKILL_MD_FILENAME}'s bytes from immediately before this request's own deletes ` +
              'have been restored, and no other file this request touched was rolled back.'
            : `; no prior copy of ${SKILL_MD_FILENAME} was available to restore, so this skill is ` +
              'left without one — re-import it.'),
      );
    }
  }

  return null;
}
