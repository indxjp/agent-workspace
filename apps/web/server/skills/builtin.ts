/**
 * Built-in skills (`BUILTIN_SKILL_NAMES`) are installed into a workspace on demand, as ordinary
 * workspace skills: a version resolves its skill names against catalog rows, so a built-in has to
 * be one. Installed on first use, a built-in is refreshed when this platform ships new bytes for it
 * and the workspace copy is still exactly what this platform installed. A skill the user imported
 * under the same name, or edited, is theirs and is never overwritten.
 *
 * The record of what was installed is the digest in the row's `builtin_digest` column. The common
 * path, nothing to do, costs one store read and one catalog read.
 */
import { createHash } from 'node:crypto';

import { builtinSkillFiles } from '@agent-workspace/skills-office';
import { isBuiltinSkillName, SKILL_MD_FILENAME } from '@indx-workspace/contracts/skills';
import type { BuiltinSkillName } from '@indx-workspace/contracts/skills';
import { readWhole } from '@agent-workspace/core/storage/streams';
import type { SkillObjects } from '../storage/store';

import { withSkillMetaColumn } from './meta-column';
import { skillSyncContext } from './pending-delete';
import { applicationContext } from '../application-context';
import { skillBuiltinMarkerKey, skillFilesPrefix, skillMetaKey, skillRowFolder } from './keys';
import {
  importReserved,
  importSkillWithId,
  patchSkillWithId,
  type SkillPrincipal,
} from './service';
import { skillFiles, type SkillFile, type SkillRowsAccess } from './tree';

/** The skills catalog, as the skill service that writes it takes it. */
type SkillCatalog = Parameters<typeof importSkillWithId>[1];

export interface Entry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export function digestOf(entries: readonly Entry[]): string {
  const hash = createHash('sha256');
  for (const entry of [...entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    hash.update(`${entry.path}\0${String(entry.bytes.byteLength)}\0`);
    hash.update(entry.bytes);
  }
  return hash.digest('hex');
}

function shippedEntries(name: BuiltinSkillName): Entry[] {
  return builtinSkillFiles(name).map((file) => ({
    path: file.path,
    bytes: Buffer.from(file.contentBase64, 'base64'),
  }));
}

function storedFiles(
  store: SkillObjects,
  rows: SkillRowsAccess | undefined,
  name: string,
): Promise<SkillFile[]> {
  return skillFiles(store, rows, skillRowFolder(name), skillFilesPrefix(name));
}

async function storedEntries(
  store: SkillObjects,
  rows: SkillRowsAccess | undefined,
  name: string,
): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const file of await storedFiles(store, rows, name)) {
    const bytes = await file.read();
    if (bytes !== null) entries.push({ path: file.relativePath, bytes });
  }
  return entries;
}

/**
 * The digest recorded for the installed built-in: the row's column, else the marker object an
 * earlier release wrote, which is copied to the column (the marker object stays).
 */
async function installedDigest(
  store: SkillObjects,
  catalog: SkillCatalog,
  name: string,
): Promise<string | null> {
  const row = (await catalog.listSkills()).find((skill) => skill.name === name);
  const recorded = row?.builtinDigest ?? null;
  if (recorded !== null) return recorded;
  // storage-bridge(#1699): read `skill-builtin/<name>.json` until the marker objects are removed (#1676)
  const marker = await readWhole(store, skillBuiltinMarkerKey(name));
  if (marker === null) return null;
  let digest: unknown;
  try {
    digest = (JSON.parse(new TextDecoder().decode(marker.body)) as { digest?: unknown } | null)
      ?.digest;
  } catch {
    return null;
  }
  if (typeof digest !== 'string') return null;
  if (row !== undefined) await catalog.setSkillBuiltinDigest(name, digest);
  return digest;
}

async function ensureOne(
  store: SkillObjects,
  catalog: SkillCatalog,
  principal: SkillPrincipal & { readonly workspaceId: string },
  name: BuiltinSkillName,
  rows: SkillRowsAccess,
): Promise<void> {
  const shipped = shippedEntries(name);
  const shippedDigest = digestOf(shipped);
  const body = {
    files: shipped.map((entry) => ({
      path: entry.path,
      contentBase64: Buffer.from(entry.bytes).toString('base64'),
    })),
  };

  // An existence test that reads the record whole: `head` bypasses the meta-column view, so it
  // would miss a record held only in the column.
  if ((await readWhole(store, skillMetaKey(name))) === null) {
    if ((await skillSyncContext(store, catalog)).pendingDeletes.has(name)) return;
    let imported = await importSkillWithId(store, catalog, principal, { name, ...body }, rows);
    // 409 with no SKILL.md: a crashed import left its reserved row and no files. That row must not
    // hide the built-in, so the install completes into it.
    if (
      imported.status === 409 &&
      !(await storedFiles(store, rows, name)).some(
        (file) => file.relativePath === SKILL_MD_FILENAME,
      )
    )
      imported = await importReserved(store, catalog, principal, { name, ...body }, rows);
    // 409: another request installed it between the check and the import.
    // Anything else is a platform fault, not the caller's: throw so the route answers a bare 5xx.
    if (imported.status === 201) await catalog.setSkillBuiltinDigest(name, shippedDigest);
    else if (imported.status !== 409)
      throw new Error(`installing built-in skill ${name} answered ${String(imported.status)}`);
    return;
  }

  const recorded = await installedDigest(store, catalog, name);
  if (recorded === null || recorded === shippedDigest) return;

  const stored = await storedEntries(store, rows, name);
  if (digestOf(stored) !== recorded) return;
  const shippedPaths = new Set(shipped.map((entry) => entry.path));
  const removeFiles = stored
    .map((entry) => entry.path)
    .filter((path) => !shippedPaths.has(path) && path !== SKILL_MD_FILENAME);
  const patched = await patchSkillWithId(
    store,
    catalog,
    principal,
    name,
    { ...body, removeFiles },
    rows,
  );
  if (patched.status !== 200)
    throw new Error(`refreshing built-in skill ${name} answered ${String(patched.status)}`);
  await catalog.setSkillBuiltinDigest(name, shippedDigest);
}

export async function ensureBuiltinSkills(
  objects: SkillObjects,
  catalog: SkillCatalog,
  principal: SkillPrincipal & { readonly workspaceId: string },
  names: readonly string[],
  rows: SkillRowsAccess,
): Promise<void> {
  const store = withSkillMetaColumn(objects, catalog);
  for (const name of new Set(names)) {
    if (isBuiltinSkillName(name)) await ensureOne(store, catalog, principal, name, rows);
  }
}

function skillNamesOf(body: unknown): string[] {
  const skills = (body as { definition?: { resources?: { skills?: unknown } } } | null)?.definition
    ?.resources?.skills;
  return Array.isArray(skills)
    ? skills.filter((name): name is string => typeof name === 'string')
    : [];
}

/**
 * Before a version body is saved: put the built-in skills it names into the caller's workspace, so
 * the save resolves them like any other skill. Does nothing when the body names none or the
 * deployment keeps no skills catalog; the save then answers as it would for any missing skill.
 */
export async function installBuiltinSkillsNamedBy(
  body: unknown,
  principal: SkillPrincipal & { readonly workspaceId: string },
): Promise<void> {
  const names = skillNamesOf(body).filter(isBuiltinSkillName);
  const skills = applicationContext()?.skills;
  const runtime = skills?.kind === 'serving' ? skills.runtime : null;
  if (names.length === 0 || runtime?.catalog === undefined || runtime.storage === undefined) return;
  await ensureBuiltinSkills(
    runtime.store.forWorkspace(principal.workspaceId),
    await runtime.catalog.forWorkspace(principal.workspaceId),
    principal,
    names,
    { storage: runtime.storage, workspaceId: principal.workspaceId },
  );
}
