/** Dependency-free POSIX ustar hydration and collection for runtime workspaces. */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BLOCK = 512;
const ZERO_TRAILER = BLOCK * 2;

export type TarEntry = Readonly<{
  path: string;
  type: 'file' | 'directory';
  mode: number;
  data?: Uint8Array;
}>;

function decodePath(value: string): string {
  let decoded = value;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new Error(`unsafe archive path ${JSON.stringify(value)}: malformed percent encoding`);
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decoded;
}

/** Normalize a tar member or requested path and prove that it stays relative. */
export function normalizeArchivePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`unsafe archive path ${JSON.stringify(value)}`);
  }
  const decoded = decodePath(value).replaceAll('\\', '/');
  if (decoded.length === 0 || decoded.includes('\0')) {
    throw new Error(`unsafe archive path ${JSON.stringify(value)}`);
  }
  if (decoded.startsWith('/') || /^[A-Za-z]:/u.test(decoded)) {
    throw new Error(`unsafe archive path ${JSON.stringify(value)}: absolute paths are forbidden`);
  }
  const segments = decoded.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`unsafe archive path ${JSON.stringify(value)}: parent traversal is forbidden`);
  }
  const normalized = path.posix.normalize(decoded).replace(/^\.\//u, '').replace(/\/$/u, '');
  if (normalized.length === 0 || normalized === '.' || normalized.startsWith('../')) {
    throw new Error(`unsafe archive path ${JSON.stringify(value)}`);
  }
  return normalized;
}

function writeText(block: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength > length) throw new Error(`ustar field is too long: ${value}`);
  bytes.copy(block, offset);
}

function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length >= length)
    throw new Error(`ustar numeric field is too large: ${String(value)}`);
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
  throw new Error(`archive path exceeds the POSIX ustar name limit: ${memberPath}`);
}

function headerFor(entry: TarEntry): Buffer {
  const memberPath = normalizeArchivePath(entry.path);
  const { name, prefix } = splitName(entry.type === 'directory' ? `${memberPath}/` : memberPath);
  const block = Buffer.alloc(BLOCK);
  writeText(block, 0, 100, name);
  writeOctal(block, 100, 8, entry.mode & 0o7777);
  writeOctal(block, 108, 8, 1000);
  writeOctal(block, 116, 8, 1000);
  writeOctal(block, 124, 12, entry.type === 'file' ? (entry.data?.byteLength ?? 0) : 0);
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
    chunks.push(headerFor(entry), data);
    const padding = paddedLength(data.byteLength) - data.byteLength;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(ZERO_TRAILER));
  return Buffer.concat(chunks);
}

function readText(block: Uint8Array, offset: number, length: number): string {
  const raw = Buffer.from(block.subarray(offset, offset + length));
  const end = raw.indexOf(0);
  return raw
    .subarray(0, end === -1 ? raw.length : end)
    .toString('utf8')
    .trimEnd();
}

function readOctal(block: Uint8Array, offset: number, length: number, field: string): number {
  const value = readText(block, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error(`invalid ustar ${field}: ${JSON.stringify(value)}`);
  return Number.parseInt(value, 8);
}

export function decodeUstar(bytes: Uint8Array): readonly TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + BLOCK <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) return entries;
    if (readText(header, 257, 6) !== 'ustar') throw new Error('archive is not POSIX ustar');
    const storedChecksum = readOctal(header, 148, 8, 'checksum');
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== actualChecksum) throw new Error('invalid ustar header checksum');
    const name = readText(header, 0, 100);
    const prefix = readText(header, 345, 155);
    const memberPath = normalizeArchivePath(prefix.length > 0 ? `${prefix}/${name}` : name);
    const mode = readOctal(header, 100, 8, 'mode');
    const size = readOctal(header, 124, 12, 'size');
    const type = header[156];
    offset += BLOCK;
    if (offset + size > bytes.byteLength) throw new Error(`truncated ustar member ${memberPath}`);
    if (type !== 0 && type !== 0x30 && type !== 0x35) {
      throw new Error(`unsupported ustar member type ${String(type)} for ${memberPath}`);
    }
    entries.push({
      path: memberPath,
      type: type === 0x35 ? 'directory' : 'file',
      mode,
      ...(type === 0x35 ? {} : { data: bytes.slice(offset, offset + size) }),
    });
    offset += paddedLength(size);
  }
  throw new Error('ustar archive has no zero-block terminator');
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

function targetPath(root: string, memberPath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...normalizeArchivePath(memberPath).split('/'));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`archive member escapes workspace: ${memberPath}`);
  }
  return resolved;
}

async function refuseSymlinkParents(root: string, target: string): Promise<void> {
  const relative = path.relative(path.resolve(root), target);
  const segments = relative.split(path.sep).slice(0, -1);
  let current = path.resolve(root);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        const relativeParent = path.relative(path.resolve(root), current).split(path.sep).join('/');
        throw new Error(`symlink parent is forbidden: ${relativeParent}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function refuseLeafSymlink(target: string): Promise<void> {
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new Error(`symlink archive target is forbidden`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function existingRegularFile(target: string): Promise<boolean> {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`symlink archive target is forbidden`);
    if (!stat.isFile()) throw new Error(`archive file target is not a regular file`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function requireMissingLeaf(target: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`archive target appeared while it was being materialized`);
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
      throw new Error(`symlink archive target is forbidden`);
    }
    if (!moved.isFile()) throw new Error(`archive file target is not a regular file`);
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
  data: Uint8Array,
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

export async function extractUstar(
  archive: ReadableStream<Uint8Array>,
  workspaceRoot: string,
): Promise<readonly string[]> {
  const entries = decodeUstar(await readStream(archive));
  const written: string[] = [];
  await mkdir(workspaceRoot, { recursive: true });
  for (const entry of entries) {
    const target = targetPath(workspaceRoot, entry.path);
    await refuseSymlinkParents(workspaceRoot, target);
    if (entry.type === 'directory') {
      await refuseLeafSymlink(target);
      await mkdir(target, { recursive: true, mode: entry.mode });
    } else {
      await writeArchiveFile(workspaceRoot, target, entry.data ?? new Uint8Array(), entry.mode);
    }
    written.push(entry.path);
  }
  return written;
}

async function collectEntry(
  root: string,
  relativePath: string,
  entries: TarEntry[],
): Promise<void> {
  const normalized = normalizeArchivePath(relativePath);
  const absolute = targetPath(root, normalized);
  // A linked parent (`outputs -> /etc`) would export files from outside the workspace.
  await refuseSymlinkParents(root, absolute);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink())
    throw new Error(`symlink archive entries are forbidden: ${normalized}`);
  if (stat.isDirectory()) {
    entries.push({ path: normalized, type: 'directory', mode: stat.mode & 0o7777 });
    const children = await readdir(absolute);
    children.sort();
    for (const child of children) await collectEntry(root, `${normalized}/${child}`, entries);
    return;
  }
  if (!stat.isFile()) throw new Error(`unsupported workspace entry: ${normalized}`);
  entries.push({
    path: normalized,
    type: 'file',
    mode: stat.mode & 0o7777,
    data: await readFile(absolute),
  });
}

export async function archiveWorkspacePaths(
  workspaceRoot: string,
  paths: readonly string[],
): Promise<ReadableStream<Uint8Array>> {
  if (paths.length === 0) throw new Error('at least one workspace path is required');
  const entries: TarEntry[] = [];
  for (const requested of paths) await collectEntry(workspaceRoot, requested, entries);
  return bytesToStream(encodeUstar(entries));
}
