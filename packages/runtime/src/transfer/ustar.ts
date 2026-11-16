import {
  BLOCK,
  ZERO_TRAILER,
  type TarEntry,
  ArchiveValidationError,
  ArchiveTooLargeError,
} from './model.js';
import { archiveMemberPath } from './paths.js';

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

export function headerFor(entry: Pick<TarEntry, 'path' | 'type' | 'mode'>, size: number): Buffer {
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

export function paddedLength(length: number): number {
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

export type UstarHeader = Readonly<{
  path: string;
  type: 'file' | 'directory';
  mode: number;
  size: number;
}>;

/** Validate one 512-byte header block: magic, checksum, member name and type. */
export function parseHeader(header: Uint8Array): UstarHeader {
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
