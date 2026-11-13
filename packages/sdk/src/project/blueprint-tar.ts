/**
 * The tar half of reading an app blueprint (ADR-0166 D4): {@link readRegularFiles} walks the ustar
 * entries `npm pack` writes, with their pax extended headers for long paths, and returns the
 * regular files of `package/` by path, refusing every other kind of entry before a byte of it is
 * used. What the files mean (the manifest, `package.json`) is `./blueprint-archive.ts`'s business.
 *
 * Pure: bytes in, bytes out. Nothing is read from or written to a file system.
 */
import { BLUEPRINT_MAX_FILES } from './blueprint.js';
import { ProjectRenderError } from './errors.js';

/** The most bytes the files of one blueprint hold together (ADR-0166 D4). */
export const BLUEPRINT_ARCHIVE_MAX_BYTES = 5 * 1024 * 1024;

/** The root directory `npm pack` puts every file of a package under. */
const PACKAGE_ROOT = 'package/';

/** The files a blueprint carries beside its parts: `package.json` and `blueprint.json`. */
const FILES_BESIDE_THE_PARTS = 2;

const BLOCK = 512;
const ARCHIVE = '(archive)';

/** The ustar header fields this reader uses, by byte offset and width. */
const NAME = { start: 0, length: 100 } as const;
const SIZE = { start: 124, length: 12 } as const;
const CHECKSUM = { start: 148, length: 8 } as const;
const TYPE_OFFSET = 156;
const PREFIX = { start: 345, length: 155 } as const;

/** What a refusal names as its subject. */
export const BLUEPRINT_PACKAGE_SUBJECT = 'the blueprint package';

/** The refusal every part of reading a blueprint package throws, naming the offending path. */
export function archiveRefusal(path: string, message: string): ProjectRenderError {
  return new ProjectRenderError(BLUEPRINT_PACKAGE_SUBJECT, [{ path, message }]);
}

/** The refusal for the archive as a whole rather than one entry of it. */
function refusedArchive(message: string): ProjectRenderError {
  return archiveRefusal(ARCHIVE, message);
}

const lenient = new TextDecoder('utf-8');
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** A NUL-terminated header field. */
function field(header: Uint8Array, { start, length }: { start: number; length: number }): string {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return lenient.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** An octal number field; a base-256 one (only for sizes far over the limit) is refused. */
function octal(
  header: Uint8Array,
  { start, length }: { start: number; length: number },
  what: string,
): number {
  if (((header[start] ?? 0) & 0x80) !== 0) throw refusedArchive(`${what} is too large`);
  const text = field(header, { start, length }).trim();
  if (!/^[0-7]*$/u.test(text)) throw refusedArchive(`has a malformed ${what}`);
  return text === '' ? 0 : Number.parseInt(text, 8);
}

/** Whether the header's checksum (the byte sum, the checksum field read as spaces) is right. */
function checksumMatches(header: Uint8Array): boolean {
  const checksumEnd = CHECKSUM.start + CHECKSUM.length;
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= CHECKSUM.start && index < checksumEnd ? 0x20 : (header[index] ?? 0);
  }
  return sum === octal(header, CHECKSUM, 'checksum');
}

/**
 * The `path` of a pax extended header's records (`<length> <key>=<value>\n`), if it has one.
 * A record's length counts bytes, so the data is walked as bytes and only a record's own text is
 * decoded: measuring in UTF-16 units of the decoded text rejected every non-ASCII path.
 */
function paxPath(data: Uint8Array): string | undefined {
  let found: string | undefined;
  let offset = 0;
  while (offset < data.length) {
    let space = offset;
    while (space < data.length && data[space] !== 0x20) space += 1;
    const digits = new TextDecoder('latin1').decode(data.subarray(offset, space));
    const length = /^\d+$/u.test(digits) ? Number.parseInt(digits, 10) : Number.NaN;
    if (!Number.isSafeInteger(length) || space >= data.length || offset + length > data.length) {
      throw refusedArchive('has a malformed pax header');
    }
    let record: string;
    try {
      record = utf8.decode(data.subarray(space + 1, offset + length));
    } catch {
      throw refusedArchive('has a pax header that is not UTF-8');
    }
    offset += length;
    if (record.startsWith('path=')) found = record.slice('path='.length).replace(/\n$/u, '');
  }
  return found;
}

/** The path inside `package/`, refused when it is unsafe or outside it; `''` is the root itself. */
function packagePath(raw: string): string {
  const name = raw.replace(/\/+$/u, '');
  const unsafe =
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/u.test(name) ||
    name.split('/').some((segment) => segment === '..' || segment === '.' || segment === '');
  if (unsafe) throw archiveRefusal(name, 'is not a plain relative path inside the package');
  if (name === PACKAGE_ROOT.slice(0, -1)) return '';
  if (!name.startsWith(PACKAGE_ROOT)) throw archiveRefusal(name, `is outside ${PACKAGE_ROOT}`);
  return name.slice(PACKAGE_ROOT.length);
}

/** The tar type flags: a regular file is `0` (or NUL in old archives), a directory `5`, a pax header `x`. */
const TYPE_PAX_HEADER = 'x';
const TYPE_DIRECTORY = '5';

function isRegularFileType(type: string): boolean {
  return type === '0' || type === '\0';
}

/** One entry of the archive: its header's name and type, and its data. */
interface TarEntry {
  readonly header: Uint8Array;
  readonly type: string;
  readonly data: Uint8Array;
  /** Where the next entry's header starts. */
  readonly next: number;
}

/** The entry whose header starts at `offset`, or `undefined` at the end-of-archive marker. */
function readEntry(tar: Uint8Array, offset: number): TarEntry | undefined {
  const header = tar.subarray(offset, offset + BLOCK);
  if (header.every((byte) => byte === 0)) return undefined;
  if (!checksumMatches(header)) throw refusedArchive('is not a tar archive');
  const size = octal(header, SIZE, 'size');
  const start = offset + BLOCK;
  const data = tar.subarray(start, start + size);
  if (data.length !== size) throw refusedArchive('is truncated');
  return {
    header,
    type: String.fromCharCode(header[TYPE_OFFSET] ?? 0),
    data,
    next: start + Math.ceil(size / BLOCK) * BLOCK,
  };
}

/** The entry's name: the pax long path that preceded it, else the ustar prefix and name. */
function entryName(header: Uint8Array, longPath: string | undefined): string {
  if (longPath !== undefined) return longPath;
  const prefix = field(header, PREFIX);
  return (prefix === '' ? '' : `${prefix}/`) + field(header, NAME);
}

/** Refuses a blueprint that holds more files, or more bytes in all, than ADR-0166 D4 allows. */
function assertWithinLimits(fileCount: number, totalBytes: number): void {
  if (
    fileCount >= BLUEPRINT_MAX_FILES + FILES_BESIDE_THE_PARTS ||
    totalBytes > BLUEPRINT_ARCHIVE_MAX_BYTES
  ) {
    throw refusedArchive(
      `holds more than ${String(BLUEPRINT_MAX_FILES)} files or ${String(BLUEPRINT_ARCHIVE_MAX_BYTES)} bytes`,
    );
  }
}

/** The regular files of a tar archive by path inside `package/`, every other entry refused (D4). */
export function readRegularFiles(tar: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let total = 0;
  let longPath: string | undefined;
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const entry = readEntry(tar, offset);
    if (entry === undefined) break;
    offset = entry.next;
    if (entry.type === TYPE_PAX_HEADER) {
      longPath = paxPath(entry.data);
      continue;
    }
    const name = entryName(entry.header, longPath);
    longPath = undefined;
    const path = packagePath(name);
    if (entry.type === TYPE_DIRECTORY) continue;
    if (!isRegularFileType(entry.type)) {
      throw archiveRefusal(
        name,
        'is not a regular file (a link, a device or another special entry)',
      );
    }
    if (files.has(path)) throw archiveRefusal(path, 'is in the package twice');
    total += entry.data.length;
    assertWithinLimits(files.size, total);
    files.set(path, entry.data);
  }
  return files;
}
