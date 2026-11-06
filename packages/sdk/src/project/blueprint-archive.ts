/**
 * Reading an app blueprint's npm tarball (ADR-0166 D4): {@link readBlueprintArchive} takes the
 * tar bytes, already gunzipped by the caller (`aw` uses `node:zlib`, so no dependency is added),
 * and returns the package's `blueprint.json` and the text of every part and migration it lists.
 *
 * It reads the ustar format `npm pack` writes, with its pax extended headers for long paths, and
 * refuses anything else before a file is returned: a symbolic or hard link, a device, a FIFO or any
 * other entry that is not a regular file or a directory; an absolute path, a `..` or `.` segment,
 * a backslash or a NUL; a file outside `package/`; a file the manifest does not list (beside
 * `package.json`, `blueprint.json` and a top-level `README*`, `LICENSE*` or `CHANGELOG*`); a listed
 * part that is missing; a file that is not UTF-8 text; and more than 200 files or 5 MiB in all.
 *
 * Pure: bytes in, text out. Nothing is read from or written to a file system.
 */
import {
  BLUEPRINT_MANIFEST_FILE,
  BLUEPRINT_MAX_FILES,
  parseBlueprintManifest,
  type BlueprintManifest,
} from './blueprint.js';
import { ProjectRenderError, type ProjectRenderIssue } from './errors.js';
import type { ProjectFile } from './template.js';

/** The most bytes the files of one blueprint hold together (ADR-0166 D4). */
export const BLUEPRINT_ARCHIVE_MAX_BYTES = 5 * 1024 * 1024;

/** The root directory `npm pack` puts every file of a package under. */
const PACKAGE_ROOT = 'package/';
const PACKAGE_JSON = 'package.json';
/** The keyword every blueprint package carries in its `package.json` (ADR-0166 D4). */
export const BLUEPRINT_PACKAGE_KEYWORD = 'indx-workspace-blueprint';

/** The top-level files npm adds to every package, which a blueprint may carry and never writes. */
const PACKAGE_DOCUMENT = /^(?:README|LICENSE|LICENCE|CHANGELOG)(?:\.[^/]*)?$/iu;

const BLOCK = 512;
const SUBJECT = 'the blueprint package';

/** One blueprint package, read: its manifest, its npm name and version, and its listed files. */
export interface BlueprintArchive {
  readonly manifest: BlueprintManifest;
  /** The `name` and `version` of the package's `package.json`. */
  readonly packageName: string;
  readonly packageVersion: string;
  /** Every part and then every migration `blueprint.json` lists, in its order, as text. */
  readonly files: readonly ProjectFile[];
}

function refused(path: string, message: string): ProjectRenderError {
  return new ProjectRenderError(SUBJECT, [{ path, message }]);
}

const lenient = new TextDecoder('utf-8');
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** A NUL-terminated header field. */
function field(header: Uint8Array, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return lenient.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** An octal number field; a base-256 one (only for sizes far over the limit) is refused. */
function octal(header: Uint8Array, start: number, length: number, what: string): number {
  if (((header[start] ?? 0) & 0x80) !== 0) throw refused('(archive)', `${what} is too large`);
  const text = field(header, start, length).trim();
  if (!/^[0-7]*$/u.test(text)) throw refused('(archive)', `has a malformed ${what}`);
  return text === '' ? 0 : Number.parseInt(text, 8);
}

/** Whether the header's checksum (the byte sum, the checksum field read as spaces) is right. */
function checksumMatches(header: Uint8Array): boolean {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  return sum === octal(header, 148, 8, 'checksum');
}

/** The `path` of a pax extended header's records (`<length> <key>=<value>\n`), if it has one. */
function paxPath(data: Uint8Array): string | undefined {
  let text: string;
  try {
    text = utf8.decode(data);
  } catch {
    throw refused('(archive)', 'has a pax header that is not UTF-8');
  }
  let found: string | undefined;
  let rest = text;
  while (rest.length > 0) {
    const match = /^(\d+) /u.exec(rest);
    const length = match === null ? Number.NaN : Number.parseInt(match[1] ?? '', 10);
    if (match === null || !Number.isSafeInteger(length) || length > rest.length) {
      throw refused('(archive)', 'has a malformed pax header');
    }
    const record = rest.slice(match[0].length, length);
    rest = rest.slice(length);
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
  if (unsafe) throw refused(name, 'is not a plain relative path inside the package');
  if (name === PACKAGE_ROOT.slice(0, -1)) return '';
  if (!name.startsWith(PACKAGE_ROOT)) throw refused(name, `is outside ${PACKAGE_ROOT}`);
  return name.slice(PACKAGE_ROOT.length);
}

/** The regular files of a tar archive by path, every other entry refused (D4). */
function regularFiles(tar: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let total = 0;
  let longPath: string | undefined;
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (!checksumMatches(header)) throw refused('(archive)', 'is not a tar archive');
    const size = octal(header, 124, 12, 'size');
    const type = String.fromCharCode(header[156] ?? 0);
    const start = offset + BLOCK;
    const data = tar.subarray(start, start + size);
    if (data.length !== size) throw refused('(archive)', 'is truncated');
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      longPath = paxPath(data);
      continue;
    }
    const prefix = field(header, 345, 155);
    const name = longPath ?? (prefix === '' ? '' : `${prefix}/`) + field(header, 0, 100);
    longPath = undefined;
    const path = packagePath(name);
    if (type === '5') continue;
    if (type !== '0' && type !== '\0') {
      throw refused(name, 'is not a regular file (a link, a device or another special entry)');
    }
    if (files.has(path)) throw refused(path, 'is in the package twice');
    total += size;
    if (files.size >= BLUEPRINT_MAX_FILES + 2 || total > BLUEPRINT_ARCHIVE_MAX_BYTES) {
      throw refused(
        '(archive)',
        `holds more than ${String(BLUEPRINT_MAX_FILES)} files or ${String(BLUEPRINT_ARCHIVE_MAX_BYTES)} bytes`,
      );
    }
    files.set(path, data);
  }
  return files;
}

function text(path: string, bytes: Uint8Array | undefined): string {
  if (bytes === undefined) throw refused(path, 'is missing from the package');
  try {
    const decoded = utf8.decode(bytes);
    if (!decoded.includes('\0')) return decoded;
  } catch {
    // Not UTF-8: refused below as binary.
  }
  throw refused(path, 'is not a text file; a blueprint carries text only');
}

/** The `name`, `version` and `keywords` of `package.json`, which has many other keys. */
function packageIdentity(json: string): { readonly name: string; readonly version: string } {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw refused(PACKAGE_JSON, 'is not JSON');
  }
  const record = typeof value === 'object' && value !== null ? value : {};
  const name = 'name' in record ? record.name : undefined;
  const version = 'version' in record ? record.version : undefined;
  const keywords = 'keywords' in record ? record.keywords : undefined;
  if (typeof name !== 'string' || typeof version !== 'string') {
    throw refused(PACKAGE_JSON, 'has no name and version');
  }
  if (!Array.isArray(keywords) || !keywords.includes(BLUEPRINT_PACKAGE_KEYWORD)) {
    throw refused(PACKAGE_JSON, `must list the keyword ${BLUEPRINT_PACKAGE_KEYWORD}`);
  }
  return { name, version };
}

/**
 * Reads a blueprint package from its tar bytes (ADR-0166 D4), gunzipped by the caller.
 *
 * @returns The manifest, the package's name and version, and the text of every listed part and
 *   migration, parts first, each in the manifest's order.
 * @throws {ProjectRenderError} at the first entry refused (see the module comment), or naming
 *   every file that is not listed or is missing, and a manifest whose version is not the package's.
 */
export function readBlueprintArchive(tar: Uint8Array): BlueprintArchive {
  const entries = regularFiles(tar);
  const identity = packageIdentity(text(PACKAGE_JSON, entries.get(PACKAGE_JSON)));
  const manifest = parseBlueprintManifest(
    text(BLUEPRINT_MANIFEST_FILE, entries.get(BLUEPRINT_MANIFEST_FILE)),
  );
  const listed = [...manifest.parts.map((part) => part.path), ...manifest.migrations];
  const allowed = new Set([PACKAGE_JSON, BLUEPRINT_MANIFEST_FILE, ...listed]);
  const issues: ProjectRenderIssue[] = [];
  if (identity.version !== manifest.version) {
    issues.push({
      path: `${BLUEPRINT_MANIFEST_FILE}: version`,
      message: `is ${manifest.version}, but ${PACKAGE_JSON} says ${identity.version}`,
    });
  }
  for (const path of entries.keys()) {
    if (!allowed.has(path) && !PACKAGE_DOCUMENT.test(path)) {
      issues.push({ path, message: `is not a part ${BLUEPRINT_MANIFEST_FILE} lists` });
    }
  }
  for (const path of listed) {
    if (!entries.has(path))
      issues.push({ path, message: 'is listed but missing from the package' });
  }
  if (issues.length > 0) throw new ProjectRenderError(SUBJECT, issues);
  return Object.freeze({
    manifest,
    packageName: identity.name,
    packageVersion: identity.version,
    files: Object.freeze(
      listed.map((path) => Object.freeze({ path, contents: text(path, entries.get(path)) })),
    ),
  });
}
