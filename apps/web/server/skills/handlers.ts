/** Skill reads, imports, revisions and file exports over the storage ports. */

import {
  isValidSkillName,
  SKILL_META_PREFIX,
  skillFilesPrefix,
  skillNameFromMetaKey,
  skillRowFolder,
} from './keys';
import { listAll } from '../storage/objects';
import type { SkillObjects } from '../storage-and-sharing';
import type { ApiResult } from '../http/result';
import { json, problem } from './result';
import {
  ensureSkillRows,
  skillFiles,
  skillWriter,
  type SkillRows,
  type SkillRowsWriter,
} from './tree';
import { decodeSkillFiles, encodeBase64, type ReplacedFile } from './skill-content';
import {
  describeSkill,
  unreadableSkillMdProblem,
  type SkillDetail,
  type SkillSummary,
} from './skill-description';
import { readSkillMeta, writeSkillMeta, type SkillMetaRecord } from './skill-metadata';
import { systemClock, type Clock } from '../clock';
import { writeRefusedProblem } from './skill-write-problems';
import { validateImportBody } from './validate';

/**
 * Validate the `:name` path segment. `false`/not-a-slug is `404`, not `400`: `isValidSkillName` is
 * exactly the grammar `POST /api/skills` requires a name to satisfy before a skill can ever be
 * created (`validateImportBody`, in `validate.ts`), so a name that fails it names nothing this API
 * ever created — the same "this route minted every id it will accept" reasoning
 * `files/handlers.ts`'s `requireFilePath` uses for its own 404.
 */
export function requireSkillName(
  rawName: unknown,
): { ok: true; name: string } | { ok: false; result: ApiResult } {
  if (typeof rawName !== 'string' || !isValidSkillName(rawName)) {
    return { ok: false, result: problem(404, 'skill_not_found', 'No skill has that name.') };
  }
  return { ok: true, name: rawName };
}

// ── GET /api/skills ────────────────────────────────────────────────────────────────────────────

export async function listSkills(store: SkillObjects, rows?: SkillRows): Promise<ApiResult> {
  const entries = await listAll(store, SKILL_META_PREFIX);
  const names = entries
    .filter((entry) => entry.kind === 'file')
    .map((entry) => skillNameFromMetaKey(entry.key))
    .filter((name): name is string => name !== null)
    .sort();

  const skills: SkillSummary[] = [];
  for (const name of names) {
    const meta = await readSkillMeta(store, name);
    if (meta === null) continue; // an entry this module cannot make sense of is skipped, not fatal
    const detail = await describeSkill(store, meta, rows);
    // K-4: one such row hides the whole list rather than being omitted from it or listed with no
    // id — see {@link unreadableSkillMdProblem} for why, and for the repair path.
    if (detail.source === null) return unreadableSkillMdProblem(name);
    skills.push(detail);
  }
  return json(200, { skills });
}

// ── POST /api/skills ───────────────────────────────────────────────────────────────────────────

export async function importSkill(
  store: SkillObjects,
  rawBody: unknown,
  rows: SkillRowsWriter,
): Promise<ApiResult> {
  const validated = validateImportBody(rawBody);
  if (!validated.ok) return validated.result;
  const { name, files } = validated.value;

  const existing = await existingSkillProblem(store, name);
  if (existing !== null) return existing;

  const decoded = decodeSkillFiles(files);
  if (!decoded.ok) return decoded.result;

  const writer = skillWriter(store, rows, name);
  try {
    for (const file of decoded.files) await writer.put(file.path, file.bytes);
  } catch (error) {
    return writeRefusedProblem(error);
  }

  return recordImportedSkill(store, name, rows);
}

/** `409` when a skill of this name already has its record in the store, else `null`. */
export async function existingSkillProblem(
  store: SkillObjects,
  name: string,
): Promise<ApiResult | null> {
  if ((await readSkillMeta(store, name)) === null) return null;
  return problem(
    409,
    'skill_already_exists',
    `A skill named ${JSON.stringify(name)} already exists.`,
  );
}

/** The end of an import, once every file is written: the skill's record, then its `201` body. */
export async function recordImportedSkill(
  store: SkillObjects,
  name: string,
  rows: SkillRowsWriter,
  clock: Clock = systemClock,
): Promise<ApiResult> {
  const now = clock.now().toISOString();
  const meta: SkillMetaRecord = { name, enabled: true, createdAt: now, updatedAt: now };
  await writeSkillMeta(store, meta);
  return json(201, { skill: await describeSkill(store, meta, rows) });
}

/**
 * SDK-19 (N-1): make `rawFiles` the skill's whole current content — the same admission rules as
 * `POST /api/skills`, files the new set does not name removed — and return the decoded bytes so the
 * caller freezes exactly what was written, not a read-back a concurrent `PATCH` could have changed.
 * Files are written before any is removed, and a file whose name differs only by case from a new one
 * is kept, so a failure part-way never loses the current `SKILL.md`.
 */
export async function replaceSkillFiles(
  store: SkillObjects,
  name: string,
  rawFiles: unknown,
  rows: SkillRowsWriter,
  clock: Clock = systemClock,
): Promise<
  | { ok: true; files: readonly ReplacedFile[]; skill: SkillDetail }
  | { ok: false; result: ApiResult }
> {
  const meta = await readSkillMeta(store, name);
  if (meta === null) {
    return {
      ok: false,
      result: problem(404, 'skill_not_found', `No skill named ${JSON.stringify(name)}.`),
    };
  }
  const validated = validateImportBody({ name, files: rawFiles });
  if (!validated.ok) return validated;

  const decoded = decodeSkillFiles(validated.value.files);
  if (!decoded.ok) return decoded;
  const { files } = decoded;

  const writer = skillWriter(store, rows, name);
  const kept = new Set(files.map((file) => file.path.toLowerCase()));
  try {
    await ensureSkillRows(store, rows, name);
    const existing = await writer.files();
    for (const file of files) await writer.put(file.path, file.bytes);
    for (const old of existing) {
      if (!kept.has(old.relativePath.toLowerCase())) await writer.remove(old.relativePath);
    }
  } catch (error) {
    return { ok: false, result: writeRefusedProblem(error) };
  }

  const updated: SkillMetaRecord = { ...meta, updatedAt: clock.now().toISOString() };
  await writeSkillMeta(store, updated);
  return { ok: true, files, skill: await describeSkill(store, updated, rows) };
}

// ── GET /api/skills/:name ──────────────────────────────────────────────────────────────────────

export async function getSkill(
  store: SkillObjects,
  name: string,
  rows?: SkillRows,
): Promise<ApiResult> {
  const meta = await readSkillMeta(store, name);
  if (meta === null) {
    return problem(404, 'skill_not_found', `No skill named ${JSON.stringify(name)}.`);
  }
  return json(200, { skill: await describeSkill(store, meta, rows) });
}

// ── GET /api/skills/:name/export ──────────────────────────────────────────────────────────────

export interface SkillExportFile {
  readonly path: string;
  readonly contentBase64: string;
}

// @story US-STO-08
export async function exportSkill(
  store: SkillObjects,
  name: string,
  rows?: SkillRows,
): Promise<ApiResult> {
  const meta = await readSkillMeta(store, name);
  if (meta === null) {
    return problem(404, 'skill_not_found', `No skill named ${JSON.stringify(name)}.`);
  }
  const listed = await skillFiles(store, rows, skillRowFolder(name), skillFilesPrefix(name));
  const files: SkillExportFile[] = [];
  for (const file of listed) {
    const body = await file.read();
    if (body === null) {
      // Listed a moment ago, gone now: a concurrent delete raced this export. Reported as an
      // inconsistency rather than silently omitted (ADR-0015: a check that cannot run must fail).
      return problem(
        500,
        'store_inconsistent',
        `${file.relativePath} was listed but could not be read back.`,
      );
    }
    files.push({ path: file.relativePath, contentBase64: encodeBase64(body) });
  }
  return json(200, { skill: { name: meta.name, files } });
}

export { problem, type ApiProblem } from './result';
export { skillMdText, utf8Text } from './skill-content';
export type { ReplacedFile } from './skill-content';
export { unreadableSkillMdProblem } from './skill-description';
export type { SkillDetail, SkillSummary } from './skill-description';
export { patchSkill } from './skill-patch';
export { saveRefusedProblem, writeRefusedProblem } from './skill-write-problems';
