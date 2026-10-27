/**
 * The skills operations, as functions of an `ObjectStore` and an already-JSON-parsed body.
 *
 * Mirrors `apps/web/server/files/handlers.ts`'s split: nothing here touches `Request` or
 * `Response` (that is `http.ts`), and nothing here is a Next.js route file (that is
 * `apps/web/app/api/skills/**`). A handler is testable by calling it with a fake store.
 *
 * ## What spec §7 asks for, and what this task's `Owns` globs let it deliver
 *
 * §7's exact bullets: *"create a skill · edit a skill · upload supporting files · enable/disable
 * it · assign it to agents · export it · import an existing Claude skill directory."* Four routes
 * below cover six of the seven:
 *
 *   - `POST /api/skills` is both "create" and "import" — a skill created from scratch is a
 *     directory of exactly one file (`SKILL.md`); an imported one is a directory of more. The two
 *     bullets are one operation at this layer, which is also why this task adds no second route
 *     for "import" (§34: "expose a very small control-plane API").
 *   - `PATCH /api/skills/:name` is both "edit" and "upload supporting files" and "enable/disable
 *     it" — all three change the same two things (the file set, the `enabled` flag), so one route
 *     carries all three rather than three routes each doing a third of the job.
 *   - `GET /api/skills/:name` is "selecting a skill" (plain) and "export it" (`?export=true`) —
 *     one route, two response shapes, chosen so this task never depends on a classification
 *     `apps/web/server/rbac/permissions.ts` (W2-CP-06's) would otherwise have to add for a fifth,
 *     `/:name/export`-shaped route. `apps/web/app/api/skills/[name]/route.ts`'s own header has the
 *     full reasoning; `docs/adr/W2-CP-04-skill-storage-keys.md`'s Decision 6 is the record.
 *
 * **Declared gap — "assign it to agents" is not implemented anywhere in this task.** That is a
 * grant between an agent and a skill (`agent_skills`, `packages/core/src/db/schema/agent-skills.ts`
 * — already migrated on `main` by W2-DB-01), and reading or writing it needs a repository this task
 * cannot add: `packages/core/src/db/repositories/**` is outside this task's `Owns` globs, and no
 * `AgentSkillRepository` is exported from `@agent-workspace/core/db` today. `docs/adr/
 * W2-CP-04-skill-storage-keys.md`, "Why this does not touch Postgres", is the full account.
 * `GET /api/skills/:name` therefore reports no `assignedAgents` field at all rather than an empty
 * array that would misstate "no agent uses this skill" as an established fact.
 *
 * ## Everything here is `ObjectStore`-only, on purpose
 *
 * `packages/core/src/db/schema/skills.ts` already models a `skills` table with a `skill_md` column
 * and an `enabled` column, and its own header says a *repository* over it is what a task like this
 * one would use. No such repository is reachable from `apps/web` (see the gap above), so this task
 * keeps `SKILL.md`'s bytes, every supporting file, and the platform's own `enabled`/timestamp
 * record all inside the workspace's `ObjectStore` — never a second storage layer, exactly the one
 * the task brief names. `keys.ts` is the write-up of how those two kinds of data share one store
 * without one being reachable through the other's keys.
 */
import {
  SKILL_FILE_BASE64_PATTERN,
  SKILL_MD_FILENAME,
  type SkillDetail as ContractSkillDetail,
  type SkillSummary as ContractSkillSummary,
} from '@indx-workspace/contracts/skills';

import {
  createCaseFoldGuard,
  isValidSkillName,
  skillFilesPrefix,
  skillMetaKey,
  skillNameFromMetaKey,
  skillRowFolder,
  SKILL_META_PREFIX,
} from './keys';
import { extractSkillInstructions, parseSkillFrontmatter } from './frontmatter';
import { UnsafeObjectKeyError } from '@agent-workspace/core/storage/keys';
import type { SkillObjects } from '../storage/store';
import type { ApiResult } from '../http/result';
import { json, problem } from './result';
import {
  ensureSkillRows,
  skillFiles,
  skillWriter,
  SkillSaveRefusedError,
  type SkillRows,
  type SkillRowsWriter,
  type SkillWriter,
} from './tree';
import { validateImportBody, validatePatchBody, type ImportFileEntry } from './validate';

export { problem, type ApiProblem } from './result';

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

// ── The platform's own record about a skill (`skill-meta/<name>.json`) ──────────────────────

interface SkillMetaRecord {
  readonly name: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function isSkillMetaRecord(value: unknown): value is SkillMetaRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['name'] === 'string' &&
    typeof record['enabled'] === 'boolean' &&
    typeof record['createdAt'] === 'string' &&
    typeof record['updatedAt'] === 'string'
  );
}

async function readSkillMeta(store: SkillObjects, name: string): Promise<SkillMetaRecord | null> {
  const object = await store.get(skillMetaKey(name));
  if (object === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8').decode(object.body));
  } catch {
    return null;
  }
  return isSkillMetaRecord(parsed) ? parsed : null;
}

async function writeSkillMeta(store: SkillObjects, record: SkillMetaRecord): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(record));
  await store.put(skillMetaKey(record.name), { body, contentType: 'application/json' });
}

// ── Base64, validated rather than merely decoded (see this module's own `importSkill`) ───────

// `Buffer.from(x, 'base64')` silently drops characters it does not recognise rather than throwing,
// so a caller's malformed value would decode to *some* bytes rather than being refused (ADR-0015: a
// check that cannot run must fail). The positive grammar is checked before any decoding happens.
function decodeBase64(value: string): Uint8Array | null {
  if (!SKILL_FILE_BASE64_PATTERN.test(value)) return null;
  return new Uint8Array(Buffer.from(value, 'base64'));
}

/**
 * The SKILL.md text of an import as `describeSkill` will read it back (BOM stripped), or `null` when
 * its base64 or its UTF-8 is invalid, which `importSkill` refuses before it writes anything.
 */
export function skillMdText(files: readonly ImportFileEntry[]): string | null {
  const entry = files.find((file) => file.path === SKILL_MD_FILENAME);
  const bytes = entry === undefined ? null : decodeBase64(entry.contentBase64);
  return bytes === null ? null : utf8Text(bytes);
}

/** `bytes` as UTF-8 text with a BOM stripped, or `null` when they are not valid UTF-8. */
export function utf8Text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

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

/**
 * K-4 (issue #234): true only for bytes that decode as UTF-8 without loss. `SKILL.md`'s bytes must
 * pass this before `POST`/`PATCH` will write them, so a skill can no longer enter the "exists with
 * an unreadable `SKILL.md`" state that used to make {@link describeSkill}'s `source` (and, before
 * K-4, the catalog `id`) `null`. A pre-existing row in that state is the residual K-4 cannot close
 * retroactively — see {@link listSkills}'s `store_inconsistent` answer.
 */
function isValidUtf8(bytes: Uint8Array): boolean {
  return utf8Text(bytes) !== null;
}

// @story US-STO-08
async function describeSkill(
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

/**
 * A save the catalog service refused, as the 4xx the caller can act on: another push of the skill
 * is still writing (`upload_in_progress`), an older file outside the skill holds one of its paths
 * (`path_taken`), a concurrent delete moved the path (`path_changed`), or a file is too large.
 */
export function saveRefusedProblem(error: SkillSaveRefusedError): ApiResult {
  switch (error.code) {
    case 'upload_in_progress':
      return problem(
        409,
        'upload_in_progress',
        'Another upload of this skill is still writing its files; retry once it finishes.',
      );
    case 'path_taken':
      return problem(
        409,
        'path_taken',
        'A file that is not part of this skill already holds one of its paths.',
      );
    case 'path_changed':
      return problem(
        409,
        'path_changed',
        "One of this skill's files was removed or moved while it was written; retry.",
      );
    case 'too_large':
      return problem(413, 'too_large', 'A file is larger than a skill file may be.');
  }
}

/** A writer's refusal as this route's answer; anything else is rethrown. */
export function writeRefusedProblem(error: unknown): ApiResult {
  if (error instanceof UnsafeObjectKeyError) {
    return problem(400, 'invalid_path', `A file path is not valid: ${error.message}`);
  }
  if (error instanceof SkillSaveRefusedError) return saveRefusedProblem(error);
  throw error;
}

// ── GET /api/skills ────────────────────────────────────────────────────────────────────────────

export async function listSkills(store: SkillObjects, rows?: SkillRows): Promise<ApiResult> {
  const entries = await store.list(SKILL_META_PREFIX);
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

  const decoded: ReplacedFile[] = [];
  for (const file of files) {
    const bytes = decodeBase64(file.contentBase64);
    if (bytes === null) {
      return problem(
        400,
        'malformed_content',
        `files entry ${JSON.stringify(file.path)} is not valid base64.`,
      );
    }
    // K-4: refuse a `SKILL.md` whose bytes are not valid UTF-8 before anything is written, so no
    // new skill can enter the state `describeSkill` reports as `source: null` — see `isValidUtf8`.
    if (file.path === SKILL_MD_FILENAME && !isValidUtf8(bytes)) {
      return problem(400, 'malformed_content', `${SKILL_MD_FILENAME}'s bytes are not valid UTF-8.`);
    }
    // Whether `file.path` is actually a safe relative path (no `..`, no absolute form, no reserved
    // marker) is decided by `key-safety.ts`'s guard when the writer runs below, and the `try` around
    // that loop is what reports its refusal as this route's documented 400 rather than an uncaught
    // 500.
    decoded.push({ path: file.path, bytes });
  }

  const writer = skillWriter(store, rows, name);
  try {
    for (const file of decoded) await writer.put(file.path, file.bytes);
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
): Promise<ApiResult> {
  const now = new Date().toISOString();
  const meta: SkillMetaRecord = { name, enabled: true, createdAt: now, updatedAt: now };
  await writeSkillMeta(store, meta);
  return json(201, { skill: await describeSkill(store, meta, rows) });
}

// ── POST /api/skills/:name/revisions ───────────────────────────────────────────────────────────

export interface ReplacedFile {
  readonly path: string;
  readonly bytes: Uint8Array;
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

  const files: ReplacedFile[] = [];
  for (const file of validated.value.files) {
    const bytes = decodeBase64(file.contentBase64);
    if (bytes === null) {
      return {
        ok: false,
        result: problem(
          400,
          'malformed_content',
          `files entry ${JSON.stringify(file.path)} is not valid base64.`,
        ),
      };
    }
    if (file.path === SKILL_MD_FILENAME && !isValidUtf8(bytes)) {
      return {
        ok: false,
        result: problem(
          400,
          'malformed_content',
          `${SKILL_MD_FILENAME}'s bytes are not valid UTF-8.`,
        ),
      };
    }
    files.push({ path: file.path, bytes });
  }

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

  const updated: SkillMetaRecord = { ...meta, updatedAt: new Date().toISOString() };
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
): Promise<ApiResult> {
  const meta = await readSkillMeta(store, name);
  if (meta === null) {
    return problem(404, 'skill_not_found', `No skill named ${JSON.stringify(name)}.`);
  }
  const validated = validatePatchBody(rawBody);
  if (!validated.ok) return validated.result;
  const { enabled, files, removeFiles } = validated.value;

  // Round 3, B1 (ADR-0044): every entry in `removeFiles` has already passed
  // `isAdmissibleRelativePath` inside `validatePatchBody`, so every character in it is ASCII
  // alphanumeric, `.`, `_` or `-` — an alphabet where case-folding is decidable without exception
  // (see `keys.ts#isAdmissibleRelativePath`'s header for why). `SKILL.md::$DATA` never reaches this
  // line at all any more: it was refused at the door with `inadmissible_path` because `:` and `$`
  // are outside that alphabet. What remains here is the genuinely decidable question — does an
  // *admitted* path name `SKILL.md` once case is folded? — which is a real check now, not the
  // "widen the blocklist" move round 2's identical comment on this line made and lost to.
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

  // Round 4 (ADR-0048, B2-PATCH): `files` is the third place a caller-supplied relative path
  // becomes a `writer.put` path — `validateImportBody`'s `files` and this function's
  // own `removeFiles` (just above) each already ran a case-fold check before this task's round-3
  // repair; this one ran none at all, which is exactly what the confirmer's two probes found: a
  // two-entry `files` array (`SKILL.md`, `skill.md`) answered 200 with one file surviving under the
  // first entry's name and the second entry's bytes, and a *single*-entry `files` array spelled
  // `skill.md` silently overwrote an existing `SKILL.md` the same way — no second entry in the
  // request needed at all. Every entry in `files` has already passed `isAdmissibleRelativePath`
  // inside `validatePatchBody`, so — exactly as the comment above this one argues for `removeFiles`
  // — case-folding over it is decidable without exception; what was missing here was not a weaker
  // check but no check. `createCaseFoldGuard` is seeded with every relative path this skill's
  // directory already has (`SKILL.md` included, via `walkFiles`, read before this request's own
  // writes run below) so a single-entry alias of an existing file is caught with no second entry
  // required, and it is the same function `validateImportBody` calls for `POST` — the two sites
  // cannot drift apart the way they did before this round. See `keys.ts#createCaseFoldGuard`'s own
  // header for the full account, including the declared cost this also imposes on a same-request
  // `removeFiles`+`files` rename.
  // A skill stored as a bare prefix moves whole into rows first, which readers prefer, so the
  // case-fold guard below sees every file it has.
  if ((files?.length ?? 0) + (removeFiles?.length ?? 0) > 0) {
    try {
      await ensureSkillRows(store, rows, name);
    } catch (error) {
      return writeRefusedProblem(error);
    }
  }
  const writer = skillWriter(store, rows, name);
  if (files !== undefined && files.length > 0) {
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

  const puts: ReplacedFile[] = [];
  if (files !== undefined) {
    for (const file of files) {
      const bytes = decodeBase64(file.contentBase64);
      if (bytes === null) {
        return problem(
          400,
          'malformed_content',
          `files entry ${JSON.stringify(file.path)} is not valid base64.`,
        );
      }
      // K-4: same refusal `importSkill` applies, so a PATCH cannot put this skill into the
      // unreadable-SKILL.md state either.
      if (file.path === SKILL_MD_FILENAME && !isValidUtf8(bytes)) {
        return problem(
          400,
          'malformed_content',
          `${SKILL_MD_FILENAME}'s bytes are not valid UTF-8.`,
        );
      }
      // See `importSkill`'s identical comment: the guard's decision is reported by the `try`
      // around the writer calls below.
      puts.push({ path: file.path, bytes });
    }
  }

  const deletes = removeFiles ?? [];

  // Round 3 (ADR-0044, "Verify after write, and capture before a destructive mutation"): captured
  // immediately before the destructive half of this request (`store.delete`) runs, never after —
  // round 2's read-back ran only after `store.delete` had already executed, so by the time it found
  // `SKILL.md` gone there was nothing left to do but report the loss and tell the caller to
  // re-import. That made it a detector, not a guard, and its own comment calling it "structural"
  // was false: nothing was unreachable, it was only observed after the fact. Captured *after* `puts`
  // has run (so an in-flight, legitimate `files` entry that rewrites `SKILL.md` itself is what gets
  // restored to, not a stale pre-request copy) and *before* `deletes` runs, so a restore below puts
  // back exactly what this request itself had just made current.
  let skillMdBeforeDelete: Uint8Array | null = null;

  try {
    for (const file of puts) await writer.put(file.path, file.bytes);
    if (deletes.length > 0) skillMdBeforeDelete = await readSkillMd(writer);
    for (const relativePath of deletes) await writer.remove(relativePath);
  } catch (error) {
    return writeRefusedProblem(error);
  }

  // The read-back stands ALONGSIDE the admission grammar (`validatePatchBody`'s
  // `isAdmissibleRelativePath` checks) and the case-fold checks (the `removesSkillMdByName` check
  // above, over `removeFiles`, and the `createCaseFoldGuard` loop above `puts` is built, over
  // `files`), not instead of any of them — ADR-0044, "What this does not replace." Every alias this
  // task and its three prior verification rounds have found (case fold on either array,
  // `SKILL.md::$DATA`, a same-request `files` entry aliasing `SKILL.md` with or without a second
  // entry in the request) is already refused before this line ever runs, on both `removeFiles` and
  // `files` — round 4 closed the gap ADR-0048 found on the latter (B2-PATCH); what this read-back
  // check is for is a backend behaviour neither the grammar's authors nor this task predicted.
  // Whatever `deletes` just did, `SKILL.md` itself must still be readable, or this patch is rejected
  // and rolled back rather than reported as a 200 that quietly broke the skill.
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

  const updated: SkillMetaRecord = {
    name: meta.name,
    enabled: enabled ?? meta.enabled,
    createdAt: meta.createdAt,
    updatedAt: new Date().toISOString(),
  };
  await writeSkillMeta(store, updated);

  return json(200, { skill: await describeSkill(store, updated, rows) });
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
