import { randomUUID } from 'node:crypto';
import { type Stats } from 'node:fs';
import { chmod, lstat, mkdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ArchiveValidationError, ArchiveTooLargeError } from './model.js';
import { resolveWithin } from './paths.js';
import { type UstarHeader, parseHeader } from './ustar.js';
import { ustarReader, nextHeader } from './read-stream.js';

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function refuseSymlinkParents(root: string, target: string): Promise<void> {
  const relative = path.relative(path.resolve(root), target);
  const segments = relative.split(path.sep).slice(0, -1);
  let current = path.resolve(root);
  for (const segment of segments) {
    current = path.join(current, segment);
    if ((await lstatOrNull(current))?.isSymbolicLink()) {
      const relativeParent = path.relative(path.resolve(root), current).split(path.sep).join('/');
      throw new ArchiveValidationError(`symlink parent is forbidden: ${relativeParent}`);
    }
  }
}

/**
 * Give the owner write permission back on each existing directory above `target`. A run's read
 * grants leave their directories `0o555` (the runner's mode pass), and the next hydrate into the
 * same session cwd must write there; the runner re-applies the grant's mode after it. Runs after
 * {@link refuseSymlinkParents}, so no segment is a symlink.
 */
async function restoreWritableParents(root: string, target: string): Promise<void> {
  let current = path.resolve(root);
  for (const segment of path.relative(current, target).split(path.sep).slice(0, -1)) {
    current = path.join(current, segment);
    const found = await lstatOrNull(current);
    if (found === null || !found.isDirectory()) return;
    if ((found.mode & 0o200) === 0) await chmod(current, (found.mode & 0o7777) | 0o200);
  }
}

async function refuseLeafSymlink(target: string): Promise<void> {
  if ((await lstatOrNull(target))?.isSymbolicLink()) {
    throw new ArchiveValidationError(`symlink archive target is forbidden`);
  }
}

async function existingRegularFile(target: string): Promise<boolean> {
  const stat = await lstatOrNull(target);
  if (stat === null) return false;
  if (stat.isSymbolicLink())
    throw new ArchiveValidationError(`symlink archive target is forbidden`);
  if (!stat.isFile()) throw new ArchiveValidationError(`archive file target is not a regular file`);
  return true;
}

async function requireMissingLeaf(target: string): Promise<void> {
  if ((await lstatOrNull(target)) !== null) {
    throw new ArchiveValidationError(`archive target appeared while it was being materialized`);
  }
}

async function installTemporaryFile(temporary: string, target: string): Promise<void> {
  if (!(await existingRegularFile(target))) {
    await rename(temporary, target);
    return;
  }

  // Windows rename does not portably replace an existing destination. Move the existing regular
  // leaf aside first, verify the directory entry we moved was not swapped for a symlink, install
  // the new file, then remove the backup. All operations address same-directory entries and none
  // opens the untrusted target for writing.
  const backup = path.join(path.dirname(target), `.agent-workspace-${randomUUID()}.bak`);
  await rename(target, backup);
  try {
    const moved = await lstat(backup);
    if (moved.isSymbolicLink()) {
      throw new ArchiveValidationError(`symlink archive target is forbidden`);
    }
    if (!moved.isFile()) {
      throw new ArchiveValidationError(`archive file target is not a regular file`);
    }
    await requireMissingLeaf(target);
    await rename(temporary, target);
  } catch (error) {
    try {
      await rename(backup, target);
    } catch {
      // Preserve the materialization error. The backup remains beside the target for recovery.
    }
    throw error;
  }
  await unlink(backup);
}

/**
 * Materialize a file without ever opening the caller-controlled leaf path for writing. A normal
 * `writeFile(target)` follows an existing symlink. Writing an exclusive sibling and renaming its
 * directory entry over the leaf keeps the write inside the already-checked parent even if the
 * leaf is swapped after the explicit symlink check.
 */
async function writeArchiveFile(
  root: string,
  target: string,
  data: Uint8Array | AsyncIterable<Uint8Array>,
  mode: number,
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await refuseSymlinkParents(root, target);
  await refuseLeafSymlink(target);
  const temporary = path.join(path.dirname(target), `.agent-workspace-${randomUUID()}.tmp`);
  // The staging directory owns temporary files and is discarded by the extractor on failure.
  await writeFile(temporary, data, { flag: 'wx', mode });
  // Re-check after the potentially asynchronous write. `rename` replaces a leaf directory
  // entry rather than following it, but an already-present symlink is rejected explicitly so
  // hydration never mutates the caller's workspace structure unexpectedly.
  await refuseSymlinkParents(root, target);
  await refuseLeafSymlink(target);
  await installTemporaryFile(temporary, target);
}

/** One distinct member path written to the staging directory, in archive order. */
type StagedMember = { readonly path: string; type: 'file' | 'directory'; mode: number };

/** A change the commit made to the workspace, undone in reverse order if a later member fails. */
type CommitStep =
  | Readonly<{ kind: 'created-directory'; target: string }>
  | Readonly<{ kind: 'installed-file'; target: string; backup: string | null }>;

type Staging = Readonly<{ directory: string; createdRoot: boolean }>;

async function openStaging(workspaceRoot: string): Promise<Staging> {
  const createdRoot = (await lstatOrNull(workspaceRoot)) === null;
  await mkdir(workspaceRoot, { recursive: true });
  // Inside the root, so the commit's renames stay on one filesystem. An archive cannot predict the
  // random name, so no member can address it.
  const directory = path.join(workspaceRoot, `.aw-staging-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  return { directory, createdRoot };
}

/** Remove the staging directory, and the workspace root when this hydrate created it. */
async function discardStaging(staging: Staging, workspaceRoot: string): Promise<void> {
  await rm(staging.directory, { recursive: true, force: true });
  if (staging.createdRoot) await rmdir(workspaceRoot);
}

/** Create each missing directory from `root` down to `directory`, recording each one created. */
async function createParents(root: string, directory: string, steps: CommitStep[]): Promise<void> {
  let current = path.resolve(root);
  for (const segment of path.relative(current, directory).split(path.sep)) {
    if (segment === '') continue;
    current = path.join(current, segment);
    const found = await lstatOrNull(current);
    if (found === null) {
      await mkdir(current);
      steps.push({ kind: 'created-directory', target: current });
    } else if (!found.isDirectory()) {
      throw new ArchiveValidationError(`archive parent is not a directory`);
    }
  }
}

/** Move one staged member into the workspace, with the per-member guards of an in-place write. */
async function commitMember(
  workspaceRoot: string,
  stagingDirectory: string,
  member: StagedMember,
  steps: CommitStep[],
): Promise<void> {
  const target = resolveWithin(workspaceRoot, member.path);
  await refuseSymlinkParents(workspaceRoot, target);
  await createParents(workspaceRoot, path.dirname(target), steps);
  await restoreWritableParents(workspaceRoot, target);
  if (member.type === 'directory') {
    const found = await lstatOrNull(target);
    if (found?.isSymbolicLink() === true) {
      throw new ArchiveValidationError(`symlink archive target is forbidden`);
    }
    if (found === null) {
      await mkdir(target, { mode: member.mode });
      steps.push({ kind: 'created-directory', target });
    } else if (!found.isDirectory()) {
      throw new ArchiveValidationError(`archive directory target is not a directory`);
    }
    return;
  }
  const staged = resolveWithin(stagingDirectory, member.path);
  if (!(await existingRegularFile(target))) {
    await rename(staged, target);
    steps.push({ kind: 'installed-file', target, backup: null });
    return;
  }
  // Keep the replaced file beside it until every member is in, so a refusal can put it back.
  const backup = path.join(path.dirname(target), `.agent-workspace-${randomUUID()}.bak`);
  await rename(target, backup);
  const moved = await lstat(backup);
  if (moved.isSymbolicLink() || !moved.isFile()) {
    await rename(backup, target);
    throw new ArchiveValidationError(`archive file target is not a regular file`);
  }
  steps.push({ kind: 'installed-file', target, backup });
  await requireMissingLeaf(target);
  await rename(staged, target);
}

async function undoStep(step: CommitStep): Promise<void> {
  if (step.kind === 'created-directory') {
    await rmdir(step.target);
    return;
  }
  // Unlink first: Windows rename does not portably replace an existing destination.
  if ((await lstatOrNull(step.target)) !== null) await unlink(step.target);
  if (step.backup !== null) await rename(step.backup, step.target);
}

/**
 * Move every staged member into the workspace, or none: a member the workspace refuses (a symlink,
 * a directory where a file goes) undoes the members already moved and restores each file they
 * replaced. A failed undo is reported together with the refusal, since the workspace then needs an
 * operator.
 */
async function commitStaged(
  workspaceRoot: string,
  stagingDirectory: string,
  members: Iterable<StagedMember>,
): Promise<void> {
  const steps: CommitStep[] = [];
  try {
    for (const member of members) {
      await commitMember(workspaceRoot, stagingDirectory, member, steps);
    }
  } catch (error) {
    const undoFailures: unknown[] = [];
    for (const step of steps.reverse()) {
      try {
        await undoStep(step);
      } catch (undoError) {
        undoFailures.push(undoError);
      }
    }
    if (undoFailures.length === 0) throw error;
    throw new AggregateError([error, ...undoFailures], 'a refused hydrate could not be undone', {
      cause: error,
    });
  }
  for (const step of steps) {
    if (step.kind === 'installed-file' && step.backup !== null) await unlink(step.backup);
  }
}

/**
 * Extract a ustar stream as it arrives. Link members, unsafe paths, bad checksums and a total of
 * member sizes over `maxBytes` or more than `maxMembers` members (`ArchiveTooLargeError`, raised
 * before the member is written) are refused (the storage design, §05 "A harmful archive").
 *
 * A hydrate is all-or-nothing: members stream into a staging directory inside the root and move
 * into place only once the whole archive is accepted. A refusal, in the stream or against the
 * workspace, leaves the workspace as it was and removes a root this call created.
 */
// @story US-STO-06
export async function extractUstarStream(
  archive: ReadableStream<Uint8Array>,
  workspaceRoot: string,
  options: { readonly maxBytes: number; readonly maxMembers?: number },
): Promise<readonly string[]> {
  const maxMembers = options.maxMembers ?? Number.POSITIVE_INFINITY;
  const source = ustarReader(archive);
  const written: string[] = [];
  const members = new Map<string, StagedMember>();
  let total = 0;
  let staging: Staging | null = null;
  try {
    for (;;) {
      const block = await nextHeader(source);
      if (block === null) {
        // Release the body: the trailer and anything after it are not read.
        await source.cancel();
        break;
      }
      if (written.length >= maxMembers) {
        throw new ArchiveTooLargeError(`the archive has more than ${String(maxMembers)} members.`);
      }
      const member = parseHeader(block);
      // After the first header parses, so a body that is not an archive is refused before the disk
      // is touched.
      staging ??= await openStaging(workspaceRoot);
      // Every member counts, so a forged directory body cannot get past the cap either.
      total += member.size;
      if (total > options.maxBytes) {
        throw new ArchiveTooLargeError(
          `the archived files exceed ${String(options.maxBytes)} bytes.`,
        );
      }
      await stageMember(staging.directory, member, source);
      written.push(member.path);
      const seen = members.get(member.path);
      if (seen === undefined) {
        members.set(member.path, { path: member.path, type: member.type, mode: member.mode });
      } else {
        seen.type = member.type;
        seen.mode = member.mode;
      }
    }
  } catch (error) {
    await source.cancel();
    if (staging !== null) await discardStaging(staging, workspaceRoot);
    throw error;
  }
  // An empty archive still leaves the workspace in place.
  if (staging === null) {
    await mkdir(workspaceRoot, { recursive: true });
    return written;
  }
  try {
    await commitStaged(workspaceRoot, staging.directory, members.values());
  } catch (error) {
    await discardStaging(staging, workspaceRoot);
    throw error;
  }
  await rm(staging.directory, { recursive: true, force: true });
  return written;
}

export function extractUstar(
  archive: ReadableStream<Uint8Array>,
  workspaceRoot: string,
): Promise<readonly string[]> {
  return extractUstarStream(archive, workspaceRoot, { maxBytes: Number.POSITIVE_INFINITY });
}

async function stageMember(
  directory: string,
  member: UstarHeader,
  source: ReturnType<typeof ustarReader>,
): Promise<void> {
  const target = resolveWithin(directory, member.path);
  await refuseSymlinkParents(directory, target);
  if (member.type === 'directory') {
    await refuseLeafSymlink(target);
    // Owner-writable while staged, so later members can land inside; the commit applies the mode.
    await mkdir(target, { recursive: true, mode: 0o700 });
    for await (const skipped of source.body(member.size, member.path)) void skipped;
  } else {
    await writeArchiveFile(directory, target, source.body(member.size, member.path), member.mode);
  }
}
