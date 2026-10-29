/** Dependency-free POSIX ustar hydration and collection for runtime workspaces. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open as fsOpen,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

/** The most bytes of files one run moves in either direction (the storage design, §04 "Size limits"). */
export const RUN_FILES_MAX_BYTES = 128 * 1024 * 1024;
/** The most archive members one `POST /files` creates, so a headers-only archive stays bounded. */
export const RUN_FILES_MAX_MEMBERS = 100_000;

const BLOCK = 512;
const ZERO_TRAILER = BLOCK * 2;

/**
 * The most wire bytes of one `POST /files` archive: the payload limit plus each member's header
 * and payload padding (at most one block each) and the trailer. The extractor still enforces
 * {@link RUN_FILES_MAX_BYTES} and {@link RUN_FILES_MAX_MEMBERS} on what the archive holds.
 */
export const RUN_FILES_MAX_ARCHIVE_BYTES =
  RUN_FILES_MAX_BYTES + RUN_FILES_MAX_MEMBERS * 2 * BLOCK + ZERO_TRAILER;

export type TarEntry = Readonly<{
  path: string;
  type: 'file' | 'directory';
  mode: number;
  data?: Uint8Array;
}>;

/** One member of a streamed archive. A file is opened only when its turn comes. */
export type StreamTarEntry =
  | Readonly<{ path: string; type: 'directory'; mode: number }>
  | Readonly<{
      path: string;
      type: 'file';
      mode: number;
      size: number;
      open(): Promise<ReadableStream<Uint8Array>>;
    }>;

/** Every refusal of the codec. The runner answers it with a 400; filesystem errors stay plain. */
export class ArchiveValidationError extends Error {
  override readonly name: string = 'ArchiveValidationError';
}

/** The collected files exceed the caller's byte budget. A validation error the runner answers 413. */
export class ArchiveTooLargeError extends ArchiveValidationError {
  override readonly name: string = 'ArchiveTooLargeError';
}

function unsafePath(value: string, reason = ''): ArchiveValidationError {
  return new ArchiveValidationError(`unsafe archive path ${JSON.stringify(value)}${reason}`);
}

/** The value, then each percent-decoding of it (at most three). Decoding stops at a malformed `%`. */
function percentSpellings(value: string): { spellings: string[]; malformed: boolean } {
  const spellings = [value];
  let current = value;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return { spellings, malformed: true };
    }
    if (next === current) break;
    spellings.push(next);
    current = next;
  }
  return { spellings, malformed: false };
}

/** Refuse one spelling of a path that is empty, absolute or climbs out. Returns it with `\` folded. */
function assertSafeSpelling(spelling: string, original: string): string {
  const folded = spelling.replaceAll('\\', '/');
  if (folded.length === 0 || folded.includes('\0')) throw unsafePath(original);
  if (folded.startsWith('/') || /^[A-Za-z]:/u.test(folded)) {
    throw unsafePath(original, ': absolute paths are forbidden');
  }
  if (folded.split('/').some((segment) => segment === '..')) {
    throw unsafePath(original, ': parent traversal is forbidden');
  }
  return folded;
}

function tidyPath(candidate: string, original: string): string {
  const normalized = path.posix.normalize(candidate).replace(/^\.\//u, '').replace(/\/$/u, '');
  if (normalized.length === 0 || normalized === '.' || normalized.startsWith('../')) {
    throw unsafePath(original);
  }
  return normalized;
}

/**
 * Normalize an untrusted request path (a `?path=` parameter) and prove that it stays relative.
 * It percent-decodes and folds `\`, so it must not be applied to a real on-disk file name.
 */
// @story US-STO-06
export function normalizeArchivePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw unsafePath(value);
  }
  const { spellings, malformed } = percentSpellings(value);
  if (malformed) throw unsafePath(value, ': malformed percent encoding');
  const tidied = tidyPath(assertSafeSpelling(spellings.at(-1) ?? value, value), value);
  // Tidying can expose a drive letter (`./C:/x`), and a `%` that survives the last decoding means
  // the encoding is nested deeper than decoded, so a consumer decoding once more could climb out.
  assertSafeSpelling(tidied, value);
  if (tidied.includes('%')) throw unsafePath(value, ': percent encoding nested too deeply');
  return tidied;
}

/**
 * Validate the name of a tar member and return it literally: `50%.txt` and `a%2Eb` are real file
 * names. The name is refused when it, or any percent-decoded or `\`-folded spelling of it, is
 * unsafe, so a consumer that decodes it later still cannot be walked out of the workspace.
 */
function archiveMemberPath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw unsafePath(value);
  }
  for (const spelling of percentSpellings(value).spellings) assertSafeSpelling(spelling, value);
  return tidyPath(value, value);
}

/** One entry name read from a directory: a literal that must be a single path segment. */
function assertSegment(name: string, parent: string): void {
  if (name.length === 0 || name === '.' || name === '..' || /[/\0]/u.test(name)) {
    throw unsafePath(`${parent}/${name}`);
  }
}

function writeText(block: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength > length)
    throw new ArchiveValidationError(`ustar field is too long: ${value}`);
  bytes.copy(block, offset);
}

function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length >= length)
    throw new ArchiveValidationError(`ustar numeric field is too large: ${String(value)}`);
  writeText(block, offset, length, `${encoded}\0`);
}

function splitName(memberPath: string): { name: string; prefix: string } {
  if (Buffer.byteLength(memberPath) <= 100) return { name: memberPath, prefix: '' };
  for (
    let index = memberPath.lastIndexOf('/');
    index > 0;
    index = memberPath.lastIndexOf('/', index - 1)
  ) {
    const prefix = memberPath.slice(0, index);
    const name = memberPath.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new ArchiveValidationError(
    `archive path exceeds the POSIX ustar name limit: ${memberPath}`,
  );
}

function headerFor(entry: Pick<TarEntry, 'path' | 'type' | 'mode'>, size: number): Buffer {
  const memberPath = archiveMemberPath(entry.path);
  const { name, prefix } = splitName(entry.type === 'directory' ? `${memberPath}/` : memberPath);
  const block = Buffer.alloc(BLOCK);
  writeText(block, 0, 100, name);
  writeOctal(block, 100, 8, entry.mode & 0o7777);
  writeOctal(block, 108, 8, 1000);
  writeOctal(block, 116, 8, 1000);
  writeOctal(block, 124, 12, entry.type === 'file' ? size : 0);
  writeOctal(block, 136, 12, Math.floor(Date.now() / 1000));
  block.fill(0x20, 148, 156);
  block[156] = entry.type === 'directory' ? 0x35 : 0x30;
  writeText(block, 257, 6, 'ustar\0');
  writeText(block, 263, 2, '00');
  writeText(block, 265, 32, 'agent-workspace');
  writeText(block, 297, 32, 'agent-workspace');
  writeText(block, 345, 155, prefix);
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  writeText(block, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

function paddedLength(length: number): number {
  return Math.ceil(length / BLOCK) * BLOCK;
}

export function encodeUstar(entries: readonly TarEntry[]): Uint8Array {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const data =
      entry.type === 'file' ? Buffer.from(entry.data ?? new Uint8Array()) : Buffer.alloc(0);
    chunks.push(headerFor(entry, data.byteLength), data);
    const padding = paddedLength(data.byteLength) - data.byteLength;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(ZERO_TRAILER));
  return Buffer.concat(chunks);
}

/** Every byte before the NUL terminator: `report.txt ` and `report.txt` are different names. */
function readText(block: Uint8Array, offset: number, length: number): string {
  const raw = Buffer.from(block.subarray(offset, offset + length));
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function readOctal(block: Uint8Array, offset: number, length: number, field: string): number {
  const value = readText(block, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) {
    throw new ArchiveValidationError(`invalid ustar ${field}: ${JSON.stringify(value)}`);
  }
  return Number.parseInt(value, 8);
}

type UstarHeader = Readonly<{
  path: string;
  type: 'file' | 'directory';
  mode: number;
  size: number;
}>;

/** Validate one 512-byte header block: magic, checksum, member name and type. */
function parseHeader(header: Uint8Array): UstarHeader {
  // POSIX writes `ustar\0`; GNU tar writes `ustar ` (its version field follows).
  if (!['ustar', 'ustar '].includes(readText(header, 257, 6)))
    throw new ArchiveValidationError('archive is not POSIX ustar');
  const storedChecksum = readOctal(header, 148, 8, 'checksum');
  const checksumHeader = Buffer.from(header);
  checksumHeader.fill(0x20, 148, 156);
  const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
  if (storedChecksum !== actualChecksum)
    throw new ArchiveValidationError('invalid ustar header checksum');
  const name = readText(header, 0, 100);
  const prefix = readText(header, 345, 155);
  const memberPath = archiveMemberPath(prefix.length > 0 ? `${prefix}/${name}` : name);
  const mode = readOctal(header, 100, 8, 'mode');
  const size = readOctal(header, 124, 12, 'size');
  const type = header[156];
  if (type !== 0 && type !== 0x30 && type !== 0x35) {
    throw new ArchiveValidationError(
      `unsupported ustar member type ${String(type)} for ${memberPath}`,
    );
  }
  return { path: memberPath, type: type === 0x35 ? 'directory' : 'file', mode, size };
}

/** Decode a whole archive. `maxBytes` and `maxMembers` budget its payload, not its wire bytes. */
export function decodeUstar(
  bytes: Uint8Array,
  options: { readonly maxBytes?: number; readonly maxMembers?: number } = {},
): readonly TarEntry[] {
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const maxMembers = options.maxMembers ?? Number.POSITIVE_INFINITY;
  const entries: TarEntry[] = [];
  let offset = 0;
  let total = 0;
  while (offset + BLOCK <= bytes.byteLength) {
    const block = bytes.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) return entries;
    if (entries.length >= maxMembers) {
      throw new ArchiveTooLargeError(`the archive has more than ${String(maxMembers)} members.`);
    }
    const header = parseHeader(block);
    total += header.size;
    if (total > maxBytes) {
      throw new ArchiveTooLargeError(`the archived files exceed ${String(maxBytes)} bytes.`);
    }
    offset += BLOCK;
    if (offset + header.size > bytes.byteLength) {
      throw new ArchiveValidationError(`truncated ustar member ${header.path}`);
    }
    entries.push({
      path: header.path,
      type: header.type,
      mode: header.mode,
      ...(header.type === 'directory' ? {} : { data: bytes.slice(offset, offset + header.size) }),
    });
    offset += paddedLength(header.size);
  }
  throw new ArchiveValidationError('ustar archive has no zero-block terminator');
}

export async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

type PreparedMember = Readonly<{ entry: StreamTarEntry; header: Buffer }>;

/** Build every header and sum the declared sizes, so a bad name or a total over the cap fails first. */
function prepareMembers(entries: readonly StreamTarEntry[], maxBytes: number): PreparedMember[] {
  let total = 0;
  const members = entries.map((entry): PreparedMember => {
    if (entry.type === 'file') {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
        throw new ArchiveValidationError(`invalid size for archive member ${entry.path}`);
      }
      total += entry.size;
    }
    return { entry, header: headerFor(entry, entry.type === 'file' ? entry.size : 0) };
  });
  if (total > maxBytes) {
    throw new ArchiveTooLargeError(`the archived files exceed ${String(maxBytes)} bytes.`);
  }
  return members;
}

/**
 * Stream a ustar archive, pulling one file at a time: memory is one chunk plus one header (the
 * storage design, §04 "Giving files to a run"). `maxBytes` caps the sum of declared file sizes; an
 * array source throws `ArchiveTooLargeError` before any byte, an async source errors the stream
 * before its first chunk. A file whose bytes differ from its declared size errors the stream.
 */
// @story US-STO-06
export function encodeUstarStream(
  entries: AsyncIterable<StreamTarEntry> | Iterable<StreamTarEntry>,
  options: {
    readonly maxBytes: number;
    /** Called with a file member's SHA-256 once its bytes ended at exactly its declared size. */
    readonly onEntryDigest?: (path: string, sha256: string) => void;
  },
): ReadableStream<Uint8Array> {
  const isAsync = Symbol.asyncIterator in entries;
  let members: PreparedMember[] = isAsync ? [] : prepareMembers([...entries], options.maxBytes);
  let index = 0;
  let open: { reader: ReadableStreamDefaultReader<Uint8Array>; member: PreparedMember } | null =
    null;
  let seen = 0;
  let hash = createHash('sha256');
  // Set by `cancel`, which can arrive while a file's `open()` is still pending.
  let cancelled: { readonly reason: unknown } | null = null;

  async function closeOpen(reason?: unknown): Promise<void> {
    const current = open;
    open = null;
    await current?.reader.cancel(reason).catch(() => undefined);
  }

  return new ReadableStream<Uint8Array>(
    {
      async start() {
        if (!isAsync) return;
        const collected: StreamTarEntry[] = [];
        for await (const entry of entries) collected.push(entry);
        members = prepareMembers(collected, options.maxBytes);
      },
      async pull(controller) {
        try {
          for (;;) {
            if (open === null) {
              const member = members[index];
              index += 1;
              if (member === undefined) {
                controller.enqueue(Buffer.alloc(ZERO_TRAILER));
                controller.close();
                return;
              }
              controller.enqueue(member.header);
              // An empty file is opened too, so its EOF proves it is still empty.
              if (member.entry.type === 'file') {
                seen = 0;
                hash = createHash('sha256');
                open = { reader: (await member.entry.open()).getReader(), member };
                // The source arrived after `cancel` ran: nothing else will cancel it.
                if (cancelled !== null) await closeOpen(cancelled.reason);
                return;
              }
              continue;
            }
            const { member, reader } = open;
            const size = member.entry.type === 'file' ? member.entry.size : 0;
            const { done, value } = await reader.read();
            if (done) {
              open = null;
              if (seen !== size) {
                throw new ArchiveValidationError(
                  `${member.entry.path} changed size while streaming`,
                );
              }
              options.onEntryDigest?.(member.entry.path, hash.digest('hex'));
              const padding = paddedLength(size) - size;
              if (padding > 0) controller.enqueue(Buffer.alloc(padding));
              else continue;
              return;
            }
            seen += value.byteLength;
            if (seen > size) {
              throw new ArchiveValidationError(`${member.entry.path} changed size while streaming`);
            }
            hash.update(value);
            controller.enqueue(value);
            return;
          }
        } catch (error) {
          await closeOpen(error);
          throw error;
        }
      },
      async cancel(reason) {
        cancelled = { reason };
        await closeOpen(reason);
      },
    },
    // Pull only on demand: the default high-water mark opens the first file at construction,
    // before the consumer reads, so a change made in between would escape the size check.
    { highWaterMark: 0 },
  );
}

/** Resolve an already-validated relative path under `root` and prove it did not escape. */
function resolveWithin(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relativePath.split('/'));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new ArchiveValidationError(`archive member escapes workspace: ${relativePath}`);
  }
  return resolved;
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function refuseSymlinkParents(root: string, target: string): Promise<void> {
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
  try {
    await writeFile(temporary, data, { flag: 'wx', mode });
    // Re-check after the potentially asynchronous write. `rename` replaces a leaf directory
    // entry rather than following it, but an already-present symlink is rejected explicitly so
    // hydration never mutates the caller's workspace structure unexpectedly.
    await refuseSymlinkParents(root, target);
    await refuseLeafSymlink(target);
    await installTemporaryFile(temporary, target);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // Preserve the materialization error; a cleanup failure must not replace its diagnosis.
    }
    throw error;
  }
}

/** Reads a ustar stream block by block, holding at most the unconsumed rest of one chunk. */
function ustarReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let pending: Uint8Array = new Uint8Array(0);

  async function fill(): Promise<boolean> {
    while (pending.byteLength === 0) {
      const { done, value } = await reader.read();
      if (done) return false;
      pending = value;
    }
    return true;
  }

  return {
    /** The next 512-byte header block, or null when the stream ends before a whole one. */
    async header(): Promise<Uint8Array | null> {
      if (!(await fill())) return null;
      if (pending.byteLength >= BLOCK) {
        const block = pending.subarray(0, BLOCK);
        pending = pending.subarray(BLOCK);
        return block;
      }
      const block = Buffer.alloc(BLOCK);
      for (let have = 0; have < BLOCK;) {
        if (!(await fill())) return null;
        const take = Math.min(BLOCK - have, pending.byteLength);
        block.set(pending.subarray(0, take), have);
        pending = pending.subarray(take);
        have += take;
      }
      return block;
    },
    /** The member body in chunks; its padding is consumed once the body is. */
    async *body(size: number, memberPath: string): AsyncGenerator<Uint8Array> {
      for (let left = size; left > 0;) {
        if (!(await fill())) {
          throw new ArchiveValidationError(`truncated ustar member ${memberPath}`);
        }
        const chunk = pending.subarray(0, left);
        pending = pending.subarray(chunk.byteLength);
        left -= chunk.byteLength;
        yield chunk;
      }
      for (let padding = paddedLength(size) - size; padding > 0;) {
        if (!(await fill())) {
          throw new ArchiveValidationError(`truncated ustar member ${memberPath}`);
        }
        const skipped = Math.min(padding, pending.byteLength);
        pending = pending.subarray(skipped);
        padding -= skipped;
      }
    },
    cancel: (): Promise<void> => reader.cancel().catch(() => undefined),
  };
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
      const block = await source.header();
      if (block === null) {
        throw new ArchiveValidationError('ustar archive has no zero-block terminator');
      }
      if (block.every((byte) => byte === 0)) {
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
      const target = resolveWithin(staging.directory, member.path);
      await refuseSymlinkParents(staging.directory, target);
      if (member.type === 'directory') {
        await refuseLeafSymlink(target);
        // Owner-writable while staged, so later members can land inside; the commit applies the mode.
        await mkdir(target, { recursive: true, mode: 0o700 });
        for await (const skipped of source.body(member.size, member.path)) void skipped;
      } else {
        await writeArchiveFile(
          staging.directory,
          target,
          source.body(member.size, member.path),
          member.mode,
        );
      }
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

/** One member of {@link readUstarStream}; `body` is the member's bytes in chunks, empty for a directory. */
export type UstarMember = Readonly<{
  path: string;
  type: 'file' | 'directory';
  mode: number;
  size: number;
  body: AsyncIterable<Uint8Array>;
}>;

/**
 * Read a ustar stream member by member without touching a disk: the checks of
 * {@link extractUstarStream} (link members, unsafe paths, bad checksums, `maxBytes`, `maxMembers`)
 * run before a member is yielded. A member's `body` may be left unread, or abandoned part-way: the
 * rest of it is skipped before the next header, so a consumer that fails on one file can go on.
 */
// @story US-STO-12
export async function* readUstarStream(
  archive: ReadableStream<Uint8Array>,
  options: { readonly maxBytes: number; readonly maxMembers?: number },
): AsyncGenerator<UstarMember> {
  const maxMembers = options.maxMembers ?? Number.POSITIVE_INFINITY;
  const source = ustarReader(archive);
  let skip: AsyncGenerator<Uint8Array> | null = null;
  let members = 0;
  let total = 0;
  try {
    for (;;) {
      if (skip !== null) for await (const rest of skip) void rest;
      const block = await source.header();
      if (block === null) {
        throw new ArchiveValidationError('ustar archive has no zero-block terminator');
      }
      if (block.every((byte) => byte === 0)) return;
      members += 1;
      if (members > maxMembers) {
        throw new ArchiveTooLargeError(`the archive has more than ${String(maxMembers)} members.`);
      }
      const member = parseHeader(block);
      total += member.size;
      if (total > options.maxBytes) {
        throw new ArchiveTooLargeError(
          `the archived files exceed ${String(options.maxBytes)} bytes.`,
        );
      }
      const chunks = source.body(member.size, member.path);
      skip = chunks;
      // `return` is a no-op: abandoning the body must not finish the generator the reader shares.
      const body: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: () => ({
          next: () => chunks.next(),
          return: () => Promise.resolve({ done: true, value: undefined }),
        }),
      };
      yield { ...member, body };
    }
  } finally {
    await source.cancel();
  }
}

export function extractUstar(
  archive: ReadableStream<Uint8Array>,
  workspaceRoot: string,
): Promise<readonly string[]> {
  return extractUstarStream(archive, workspaceRoot, { maxBytes: Number.POSITIVE_INFINITY });
}

type CollectBudget = { remaining: number; readonly limit: number };

/** `relativePath` is already validated; each directory child is a literal checked only as a segment. */
async function collectEntry(
  root: string,
  relativePath: string,
  entries: StreamTarEntry[],
  budget: CollectBudget,
): Promise<void> {
  const absolute = resolveWithin(root, relativePath);
  // A linked parent (`outputs -> /etc`) would export files from outside the workspace.
  await refuseSymlinkParents(root, absolute);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink()) {
    throw new ArchiveValidationError(`symlink archive entries are forbidden: ${relativePath}`);
  }
  if (stat.isDirectory()) {
    entries.push({ path: relativePath, type: 'directory', mode: stat.mode & 0o7777 });
    const children = await readdir(absolute);
    children.sort();
    for (const child of children) {
      assertSegment(child, relativePath);
      await collectEntry(root, `${relativePath}/${child}`, entries, budget);
    }
    return;
  }
  if (!stat.isFile()) {
    throw new ArchiveValidationError(`unsupported workspace entry: ${relativePath}`);
  }
  budget.remaining -= stat.size;
  if (budget.remaining < 0) {
    throw new ArchiveTooLargeError(`the collected files exceed ${String(budget.limit)} bytes.`);
  }
  entries.push({
    path: relativePath,
    type: 'file',
    mode: stat.mode & 0o7777,
    size: stat.size,
    // Opened late, so prove it is still the file checked above: a leaf or parent swapped for a
    // symlink since then would export a host file. Nonblocking, so a leaf swapped for a FIFO is
    // refused below instead of waiting forever for a writer.
    open: async () => {
      const changed = new ArchiveValidationError(
        `workspace entry changed while streaming: ${relativePath}`,
      );
      const handle = await fsOpen(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ).catch((error: unknown) => {
        throw (error as NodeJS.ErrnoException).code === 'ELOOP' ? changed : error;
      });
      try {
        const opened = await handle.stat();
        if (opened.dev !== stat.dev || opened.ino !== stat.ino || !opened.isFile()) throw changed;
      } catch (error) {
        await handle.close();
        throw error;
      }
      return Readable.toWeb(handle.createReadStream());
    },
  });
}

export async function archiveWorkspacePaths(
  workspaceRoot: string,
  paths: readonly string[],
  options: { readonly maxBytes?: number } = {},
): Promise<ReadableStream<Uint8Array>> {
  if (paths.length === 0) {
    throw new ArchiveValidationError('at least one workspace path is required');
  }
  const limit = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const budget: CollectBudget = { remaining: limit, limit };
  const entries: StreamTarEntry[] = [];
  for (const requested of paths) {
    await collectEntry(workspaceRoot, normalizeArchivePath(requested), entries, budget);
  }
  return encodeUstarStream(entries, { maxBytes: limit });
}
