/**
 * The store + catalog sequence behind `GET`/`POST /api/skills` and `GET`/`PATCH /api/skills/:name`.
 *
 * The route files under `apps/web/app/api/skills/` only check access, read the body, call one
 * function from here and convert the result to a `Response`. Nothing here touches `Request` or
 * `Response`, so each function is testable with a store and a catalog and no Next.js involved.
 */
import type { CatalogSkillRevision, ResourceCatalogRepository } from '@agent-workspace/core/db';
import {
  MAX_SKILL_REQUEST_BODY_BYTES,
  SKILL_IMPORT_MULTIPART,
  SKILL_MD_FILENAME,
  type SkillRevision,
} from '@indx-workspace/contracts/skills';

import {
  existingSkillProblem,
  getSkill,
  importSkill,
  listSkills,
  patchSkill,
  recordImportedSkill,
  replaceSkillFiles,
  saveRefusedProblem,
  skillMdText,
  unreadableSkillMdProblem,
  utf8Text,
  writeRefusedProblem,
  type SkillDetail,
} from './handlers';
import {
  createCaseFoldGuard,
  isAdmissibleRelativePath,
  isValidSkillName,
  skillMetaKey,
} from './keys';
import { withSkillMetaColumn } from './meta-column';
import type { MultipartReader } from './multipart';
import { readBytes } from '@agent-workspace/core/storage/streams';
import type { SkillObjects } from '../storage/store';
import { skillSyncContext, syncSkillCatalogRow } from './pending-delete';
import type { ApiResult } from '../http/result';
import { log } from '../telemetry/logger';
import { json, problem, type ApiProblem } from './result';
import {
  skillWriter,
  SkillSaveRefusedError,
  type SkillRows,
  type SkillRowsAccess,
  type SkillRowsWriter,
} from './tree';
import { validateImportBody } from './validate';

/** The part of the authenticated principal a catalog write is stamped with. */
export interface SkillPrincipal {
  readonly ownerPrincipalId: string;
  readonly userId: string | null;
}

/**
 * K-4: every `SkillDetail` now carries a required `id`, and an id comes only from a catalog row. A
 * route with no catalog wired can no longer answer 200 without one — that would be handing out a
 * body the published contract says cannot exist. See `docs/sdk/04-api-specification.md` and the
 * K-4 unit's implementation plan, Impact & risks. Every route that would answer a `SkillDetail`
 * refuses with this first; `POST` and `PATCH` do so before the store is written to.
 */
export function catalogNotConfigured(): ApiResult {
  return problem(
    503,
    'skills_runtime_not_configured',
    'The skills catalog is not configured for this deployment; every skill needs a catalog ' +
      'id, and none can be produced without one.',
  );
}

// The handlers built this body themselves (`describeSkill` inside `getSkill`, `patchSkill` and
// `importSkill`) and the callers have checked the status, so it is a `{ skill: SkillDetail }`.
function skillOf(result: ApiResult): SkillDetail {
  return (result.body as { skill: SkillDetail }).skill;
}

// The handlers build every non-2xx body with `problem`, so it is an `ApiProblem` when there is one.
export function problemCode(result: ApiResult): string | undefined {
  return (result.body as Partial<ApiProblem> | null)?.error?.code;
}

/** `GET /api/skills` — every skill, each with the id of its catalog row. */
export async function listSkillsWithIds(
  objects: SkillObjects,
  catalog: ResourceCatalogRepository,
  principal: SkillPrincipal,
  rows?: SkillRows,
): Promise<ApiResult> {
  const store = withSkillMetaColumn(objects, catalog);
  const listed = await listSkills(store, rows);
  if (listed.status !== 200) return listed;
  // `listSkills` already returns each skill's SKILL.md text as `source` (see `SkillDetail`),
  // so the catalog row is upserted from what this response is carrying anyway. Exporting each
  // skill here instead — the first shape of this route — base64-encoded every byte of every
  // supporting file in the workspace on every list request, to recover one string already in
  // hand.
  // `source: string`, not `string | null`: `listSkills` already refused (above) the one case
  // that would have made it null, so every summary here has SKILL.md text to upsert.
  const body = listed.body as {
    skills: Array<{ name: string; enabled: boolean; source: string }>;
  };
  // Resolved once per request: `putSkill`'s `created_by` is stamped only on the first sync of
  // a name (issue #117 — its `onConflictDoUpdate` never touches the column again), so every
  // later sync of the same row passes this and it is simply ignored.
  //
  // K-4: `listSkills` itself now refuses (500 store_inconsistent) the moment any row has
  // `source === null`, so every summary reaching this map has SKILL.md text to upsert — the
  // `summary.source === null` branch this loop used to carry is unreachable and was removed.
  //
  // ADR-0077 D3: a skill with a delete pending gets no new row — a list must not resurrect a
  // half-deleted skill, nor hand it to the caller as owner — and it is left out of the list.
  const syncContext = await skillSyncContext(store, catalog);
  const synced = await Promise.all(
    body.skills.map(async (summary) => {
      const id = await syncSkillCatalogRow(
        store,
        catalog,
        {
          name: summary.name,
          skillMd: summary.source,
          enabled: summary.enabled,
          ownerPrincipalId: principal.ownerPrincipalId,
          createdBy: principal.userId,
        },
        syncContext,
      );
      return id === null ? null : { ...summary, id };
    }),
  );
  const skills = synced.filter((skill) => skill !== null);
  return { ...listed, body: { skills } };
}

/** `rows` stamped with the owner of the rows a save creates. */
function rowsWriter(rows: SkillRowsAccess, principal: SkillPrincipal): SkillRowsWriter {
  return {
    ...rows,
    principal: { principalId: principal.ownerPrincipalId, userId: principal.userId },
  };
}

/** Remove what `importSkill` just wrote. Meta first: a crash part-way leaves invisible bytes. */
async function removeImportedSkill(
  store: SkillObjects,
  name: string,
  rows: SkillRowsWriter,
): Promise<void> {
  await store.delete(skillMetaKey(name));
  await skillWriter(store, rows, name).clear();
}

// @story US-STO-08
/**
 * `POST /api/skills` — reserve the name in the catalog, then write the skill's bytes; undo the
 * bytes and release the name on failure.
 *
 * The object store has no conditional create, so the catalog row decides which of two servers owns
 * a name (the storage design, §04 "Saving a file"): the loser answers 409 before it writes a byte,
 * so its rollback can never delete the winner's files. A crash between the reservation and the end
 * of the import leaves a row with no files; `DELETE /api/skills/:name` clears it, and a built-in
 * install of the name completes into it (`builtin.ts`).
 */
export async function importSkillWithId(
  objects: SkillObjects,
  catalog: ResourceCatalogRepository,
  principal: SkillPrincipal,
  rawBody: unknown,
  rows: SkillRowsAccess,
): Promise<ApiResult> {
  const store = withSkillMetaColumn(objects, catalog);
  const validated = validateImportBody(rawBody);
  if (!validated.ok) return validated.result;
  const { name, files } = validated.value;
  const text = skillMdText(files);
  // `importSkill` refuses this body before it writes anything, so there is no name to reserve.
  if (text === null) return importSkill(store, rawBody, rowsWriter(rows, principal));
  if (text.trim() === '') {
    return problem(400, 'malformed_content', 'SKILL.md must not be blank.');
  }
  const reserved = await catalog.createSkill({
    name,
    skillMd: text,
    enabled: true,
    ownerPrincipalId: principal.ownerPrincipalId,
    createdBy: principal.userId,
  });
  if (reserved === null) {
    return problem(
      409,
      'skill_already_exists',
      `A skill named ${JSON.stringify(name)} already exists.`,
    );
  }
  let imported = false;
  // `importSkill`'s 409 means a pre-catalog skill already has files under this name: not ours.
  let keepFiles = false;
  try {
    const result = await importReserved(store, catalog, principal, rawBody, rows);
    imported = result.status === 201;
    keepFiles = problemCode(result) === 'skill_already_exists';
    return result;
  } finally {
    if (!imported) {
      await releaseReservation(store, catalog, reserved, keepFiles, rowsWriter(rows, principal));
    }
  }
}

/**
 * Undo a failed import: its partial bytes first, so the next import of the name cannot pick them
 * up, then the row — by its id, so a row another import reserved under the name since is kept. A
 * failure here is logged, never thrown, so the import's own error is the one the caller sees; a
 * row it leaves behind is cleared by `DELETE /api/skills/:name`.
 */
async function releaseReservation(
  store: SkillObjects,
  catalog: ResourceCatalogRepository,
  reserved: { readonly id: string; readonly name: string },
  keepFiles: boolean,
  rows: SkillRowsWriter,
): Promise<void> {
  try {
    if (!keepFiles) await removeImportedSkill(store, reserved.name, rows);
    const outcome = await catalog.deleteSkill(reserved.name, reserved.id);
    if (outcome.kind === 'in-use') {
      log.warn('[skills] a failed import left its reserved catalog row: an agent uses it');
    }
  } catch (error) {
    log.error('[skills] could not release the name reserved by a failed import', { error });
  }
}

/**
 * Write a skill's bytes under a name whose catalog row already exists, then update that row (its id
 * and owner kept). For a row a crashed import left with no files; the caller has checked that.
 */
export async function importReserved(
  objects: SkillObjects,
  catalog: ResourceCatalogRepository,
  principal: SkillPrincipal,
  rawBody: unknown,
  rows: SkillRowsAccess,
): Promise<ApiResult> {
  const store = withSkillMetaColumn(objects, catalog);
  const writer = rowsWriter(rows, principal);
  return completeImport(
    store,
    catalog,
    principal,
    await importSkill(store, rawBody, writer),
    writer,
  );
}

/** A `201` of `importSkill` or `recordImportedSkill`, with its catalog row updated; else as given. */
async function completeImport(
  store: SkillObjects,
  catalog: ResourceCatalogRepository,
  principal: SkillPrincipal,
  imported: ApiResult,
  writer: SkillRowsWriter,
): Promise<ApiResult> {
  if (imported.status !== 201) return imported;
  const skill = skillOf(imported);
  // `source` is the text `importSkill` decoded (BOM stripped), the same text `GET` and `PATCH`
  // store. A 201 always has it: `validateImportBody` requires SKILL.md and `importSkill` refuses
  // bytes that are not valid UTF-8, so this guard only narrows the type.
  const { source } = skill;
  if (source === null) {
    await removeImportedSkill(store, skill.name, writer);
    return unreadableSkillMdProblem(skill.name);
  }
  try {
    const row = await catalog.putSkill({
      name: skill.name,
      skillMd: source,
      enabled: true,
      ownerPrincipalId: principal.ownerPrincipalId,
      createdBy: principal.userId,
    });
    return { ...imported, body: { skill: { ...skill, id: row.id } } };
  } catch (error) {
    await removeImportedSkill(store, skill.name, writer);
    throw error;
  }
}

const TEXT_FIELD_MAX_BYTES = 1024;

/** The `name` field and `SKILL.md` — the two parts an import reads whole, before it reserves. */
async function readImportHead(
  reader: MultipartReader,
): Promise<
  { ok: true; name: string; skillMd: Uint8Array; text: string } | { ok: false; result: ApiResult }
> {
  const field = await reader.next();
  if (
    field === null ||
    field.name !== SKILL_IMPORT_MULTIPART.nameField ||
    field.filename !== null
  ) {
    return {
      ok: false,
      result: problem(400, 'missing_name', 'The first part must be the text field "name".'),
    };
  }
  const nameBytes = await readBytes(field.body, TEXT_FIELD_MAX_BYTES);
  if (nameBytes === null) {
    return {
      ok: false,
      result: problem(
        400,
        'invalid_name',
        `"name" is longer than ${String(TEXT_FIELD_MAX_BYTES)} bytes.`,
      ),
    };
  }
  const name = new TextDecoder().decode(nameBytes);
  if (name === '') {
    return {
      ok: false,
      result: problem(400, 'missing_name', '"name" is required and must be non-empty.'),
    };
  }
  if (!isValidSkillName(name)) {
    return {
      ok: false,
      result: problem(
        400,
        'invalid_name',
        `"name" must match ^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$ — got ${JSON.stringify(name)}.`,
      ),
    };
  }

  const part = await reader.next();
  if (
    part === null ||
    part.name !== SKILL_IMPORT_MULTIPART.fileField ||
    part.filename !== SKILL_MD_FILENAME
  ) {
    return {
      ok: false,
      result: problem(
        400,
        'missing_skill_md',
        `The part after "name" must be the file ${JSON.stringify(SKILL_MD_FILENAME)}.`,
      ),
    };
  }
  const skillMd = await readBytes(part.body, MAX_SKILL_REQUEST_BODY_BYTES);
  const text = skillMd === null ? null : utf8Text(skillMd);
  if (skillMd === null || text === null) {
    return {
      ok: false,
      result: problem(
        400,
        'malformed_content',
        `${SKILL_MD_FILENAME}'s bytes are not valid UTF-8.`,
      ),
    };
  }
  if (text.trim() === '') {
    return {
      ok: false,
      result: problem(400, 'malformed_content', `${SKILL_MD_FILENAME} must not be blank.`),
    };
  }
  return { ok: true, name, skillMd, text };
}

// @story US-STO-08
/**
 * `POST /api/skills` as `multipart/form-data`: a `name` field, then `SKILL.md`, then every other file
 * as a `file` part whose filename is its path. Only `SKILL.md` is held whole, since the catalog row
 * needs its text before the first byte is saved; each other part streams straight into
 * `storage.save`. As on the JSON path, the name is reserved first and a refusal at any point — a bad
 * path, a duplicate, the size limit, a failed save — releases it and removes what was saved. A path
 * is checked as its part arrives, so a bad one answers 400 after the parts before it were saved and
 * then removed, not before the first.
 */
export async function importSkillMultipartWithId(
  objects: SkillObjects,
  catalog: ResourceCatalogRepository,
  principal: SkillPrincipal,
  reader: MultipartReader,
  rows: SkillRowsAccess,
): Promise<ApiResult> {
  const store = withSkillMetaColumn(objects, catalog);
  const writer = rowsWriter(rows, principal);
  let reserved: Awaited<ReturnType<ResourceCatalogRepository['createSkill']>> = null;
  let imported = false;
  let keepFiles = false;
  try {
    const head = await readImportHead(reader);
    if (!head.ok) return head.result;
    const { name } = head;
    reserved = await catalog.createSkill({
      name,
      skillMd: head.text,
      enabled: true,
      ownerPrincipalId: principal.ownerPrincipalId,
      createdBy: principal.userId,
    });
    if (reserved === null) {
      return problem(
        409,
        'skill_already_exists',
        `A skill named ${JSON.stringify(name)} already exists.`,
      );
    }
    const existing = await existingSkillProblem(store, name);
    if (existing !== null) {
      keepFiles = true;
      return existing;
    }

    const files = skillWriter(store, writer, name);
    await files.put(SKILL_MD_FILENAME, head.skillMd);
    const seen = new Set([SKILL_MD_FILENAME]);
    const caseFold = createCaseFoldGuard([SKILL_MD_FILENAME]);
    for (let part = await reader.next(); part !== null; part = await reader.next()) {
      const { filename } = part;
      if (part.name !== SKILL_IMPORT_MULTIPART.fileField || filename === null) {
        return problem(
          400,
          'malformed_file_entry',
          `A part after SKILL.md must be a "file" part with a filename, got ${JSON.stringify(part.name)}.`,
        );
      }
      if (!isAdmissibleRelativePath(filename)) {
        return problem(
          400,
          'inadmissible_path',
          `The filename ${JSON.stringify(filename)} is not an admissible file path.`,
        );
      }
      if (seen.has(filename)) {
        return problem(
          400,
          'duplicate_path',
          `The filename ${JSON.stringify(filename)} is repeated.`,
        );
      }
      const collidesWith = caseFold.check(filename);
      if (collidesWith !== null) {
        return problem(
          409,
          'colliding_paths',
          `The filenames ${JSON.stringify(filename)} and ${JSON.stringify(collidesWith)} are the ` +
            'same name once case is folded.',
        );
      }
      seen.add(filename);
      caseFold.add(filename);
      await files.putStream(filename, part.body);
    }

    const result = await completeImport(
      store,
      catalog,
      principal,
      await recordImportedSkill(store, name, writer),
      writer,
    );
    imported = result.status === 201;
    return result;
  } catch (error) {
    // A writer may wrap what a part's stream threw; the reader remembers the refusal itself.
    if (reader.refusal !== null) return reader.refusal;
    return writeRefusedProblem(error);
  } finally {
    await reader.close();
    if (reserved !== null && !imported) {
      await releaseReservation(store, catalog, reserved, keepFiles, writer);
    }
  }
}

/** `GET /api/skills/:name` (not `?export=true`) — the skill with the id of its catalog row. */
export async function getSkillWithId(
  objects: SkillObjects,
  catalog: ResourceCatalogRepository,
  principal: SkillPrincipal,
  name: string,
  rows?: SkillRows,
): Promise<ApiResult> {
  const store = withSkillMetaColumn(objects, catalog);
  const response = await getSkill(store, name, rows);
  if (response.status !== 200) return response;
  const detail = skillOf(response);
  // K-4: the same residual `GET /api/skills` answers `500 store_inconsistent` for. Returning
  // `response` here would answer `200` with no `id` — a body `SkillDetailSchema` rejects — and
  // leave two routes disagreeing about one row. Reachable from a pre-existing row and from
  // `patchSkill`'s rollback path, which can leave a skill without a `SKILL.md` to restore.
  //
  // `source` is null for a *missing* `SKILL.md` **and** for one whose bytes are not valid UTF-8
  // (`describeSkill`); decoding the latter would be lossy (`U+FFFD`), non-blank, and would write
  // mojibake into the catalog.
  if (detail.source === null) return unreadableSkillMdProblem(name);
  // ADR-0077 D3: a skill with a delete pending gets no new row, so it cannot be resurrected
  // or claimed by whoever reads it, and it answers as already gone.
  const id = await syncSkillCatalogRow(
    store,
    catalog,
    {
      name,
      skillMd: detail.source,
      enabled: detail.enabled,
      ownerPrincipalId: principal.ownerPrincipalId,
      createdBy: principal.userId,
    },
    await skillSyncContext(store, catalog),
  );
  if (id === null) return problem(404, 'skill_not_found', 'No skill has that name.');
  const revisions = (await catalog.listSkillRevisions(name)).map(revisionBody);
  return { ...response, body: { skill: { ...detail, id, revisions } } };
}

function revisionBody(revision: CatalogSkillRevision): SkillRevision {
  return {
    number: revision.number,
    fileCount: revision.fileCount,
    publishedAt: revision.publishedAt.toISOString(),
  };
}

/** Thrown inside the publish `write` callback so the catalog records no revision for a refusal. */
class PublishRefused extends Error {
  public constructor(public readonly result: ApiResult) {
    super('skill publish refused');
  }
}

/**
 * `POST /api/skills/:name/revisions` (SDK-19, N-1) — make `files` the skill's current content and
 * freeze it as the next numbered revision.
 *
 * The catalog allocates the revision's number under the lock on the skill row and commits it as
 * pending, so two servers publishing one skill never share a number; both writes then run with no
 * transaction open, and the revision is listed only once the catalog records it complete. A write
 * that fails clears its own revision rows and the number is never served; a crashed publish's
 * number comes back as `abandoned` to a later publish, which clears its rows. No path writes to a
 * number once it is complete: a published revision cannot change.
 */
// @story US-STO-08
export async function publishSkillRevisionWithId(
  objects: SkillObjects,
  catalog: ResourceCatalogRepository,
  principal: SkillPrincipal,
  name: string,
  rawBody: unknown,
  rows: SkillRowsAccess,
): Promise<ApiResult> {
  const store = withSkillMetaColumn(objects, catalog);
  const writer = rowsWriter(rows, principal);
  if (
    typeof rawBody !== 'object' ||
    rawBody === null ||
    Array.isArray(rawBody) ||
    Object.keys(rawBody).some((key) => key !== 'files')
  ) {
    return problem(400, 'malformed_body', 'The request body must be { files }.');
  }
  const rawFiles = (rawBody as Record<string, unknown>)['files'];
  const validated = validateImportBody({ name, files: rawFiles });
  if (!validated.ok) return validated.result;
  const publish = () =>
    catalog.publishSkillRevision(name, {
      fileCount: validated.value.files.length,
      write: async (number, abandoned) => {
        for (const stale of abandoned) await skillWriter(store, writer, name, stale).clear();
        const replaced = await replaceSkillFiles(store, name, rawFiles, writer);
        if (!replaced.ok) throw new PublishRefused(replaced.result);
        const { source, enabled } = replaced.skill;
        if (source === null) throw new PublishRefused(unreadableSkillMdProblem(name));
        const revision = skillWriter(store, writer, name, number);
        try {
          await revision.clear();
          for (const file of replaced.files) await revision.put(file.path, file.bytes);
        } catch (error) {
          await revision.clear().catch((cleanup: unknown) => {
            log.warn('[skills] could not clear the rows of a failed publish', { error: cleanup });
          });
          throw error;
        }
        // Stamped on the row when the revision completes, unless a newer one completed first, so
        // the row ends on the newest revision's SKILL.md.
        return { skillMd: source, enabled };
      },
    });
  try {
    let revision = await publish();
    if (revision === null) {
      // No row to lock: a skill stored before the catalog had rows is synced once, then published.
      const current = await getSkill(store, name, rows);
      if (current.status !== 200) return current;
      const detail = skillOf(current);
      if (detail.source === null) return unreadableSkillMdProblem(name);
      const id = await syncSkillCatalogRow(
        store,
        catalog,
        {
          name,
          skillMd: detail.source,
          enabled: detail.enabled,
          ownerPrincipalId: principal.ownerPrincipalId,
          createdBy: principal.userId,
        },
        await skillSyncContext(store, catalog),
      );
      if (id !== null) revision = await publish();
    }
    if (revision === null) return problem(404, 'skill_not_found', 'No skill has that name.');
    return json(201, { revision: revisionBody(revision) });
  } catch (error) {
    if (error instanceof PublishRefused) return error.result;
    if (error instanceof SkillSaveRefusedError) return saveRefusedProblem(error);
    throw error;
  }
}

/** `PATCH /api/skills/:name` — apply the edit, then upsert the catalog row from the result. */
export async function patchSkillWithId(
  objects: SkillObjects,
  catalog: ResourceCatalogRepository,
  principal: SkillPrincipal,
  name: string,
  rawBody: unknown,
  rows: SkillRowsAccess,
): Promise<ApiResult> {
  const store = withSkillMetaColumn(objects, catalog);
  const patched = await patchSkill(store, name, rawBody, rowsWriter(rows, principal));
  if (patched.status !== 200) return patched;
  const detail = skillOf(patched);
  // K-4: same refusal as `getSkillWithId`. This patch's own writes are already applied when this
  // is reached, exactly as `patchSkill`'s `skill_md_removal_rejected` rollback leaves them; the
  // refusal reports the row cannot be answered with an id, it does not undo the edit.
  if (detail.source === null) return unreadableSkillMdProblem(name);
  // A failed catalog write is not undone: the patched bytes are the caller's edit; the next GET
  // re-syncs the row.
  const row = await catalog.putSkill({
    name,
    skillMd: detail.source,
    enabled: detail.enabled,
    ownerPrincipalId: principal.ownerPrincipalId,
    createdBy: principal.userId,
  });
  return { ...patched, body: { skill: { ...detail, id: row.id } } };
}
