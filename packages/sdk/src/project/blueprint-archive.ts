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
  parseBlueprintManifest,
  type BlueprintManifest,
} from './blueprint.js';
import { BLUEPRINT_PACKAGE_SUBJECT, archiveRefusal, readRegularFiles } from './blueprint-tar.js';
import { ProjectRenderError, type ProjectRenderIssue } from './errors.js';
import type { ProjectFile } from './template.js';

export { BLUEPRINT_ARCHIVE_MAX_BYTES } from './blueprint-tar.js';

const PACKAGE_JSON = 'package.json';
/** The keyword every blueprint package carries in its `package.json` (ADR-0166 D4). */
export const BLUEPRINT_PACKAGE_KEYWORD = 'indx-workspace-blueprint';

/** The top-level files npm adds to every package, which a blueprint may carry and never writes. */
const PACKAGE_DOCUMENT = /^(?:README|LICENSE|LICENCE|CHANGELOG)(?:\.[^/]*)?$/iu;

/** One blueprint package, read: its manifest, its npm name and version, and its listed files. */
export interface BlueprintArchive {
  readonly manifest: BlueprintManifest;
  /** The `name` and `version` of the package's `package.json`. */
  readonly packageName: string;
  readonly packageVersion: string;
  /** Every part and then every migration `blueprint.json` lists, in its order, as text. */
  readonly files: readonly ProjectFile[];
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The text of a package file; a missing, non-UTF-8 or NUL-holding file is refused. */
function text(path: string, bytes: Uint8Array | undefined): string {
  if (bytes === undefined) throw archiveRefusal(path, 'is missing from the package');
  try {
    const decoded = utf8.decode(bytes);
    if (!decoded.includes('\0')) return decoded;
  } catch {
    // Not UTF-8: refused below as binary.
  }
  throw archiveRefusal(path, 'is not a text file; a blueprint carries text only');
}

/** The `name`, `version` and `keywords` of `package.json`, which has many other keys. */
function packageIdentity(json: string): { readonly name: string; readonly version: string } {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw archiveRefusal(PACKAGE_JSON, 'is not JSON');
  }
  const record = typeof value === 'object' && value !== null ? value : {};
  const name = 'name' in record ? record.name : undefined;
  const version = 'version' in record ? record.version : undefined;
  const keywords = 'keywords' in record ? record.keywords : undefined;
  if (typeof name !== 'string' || typeof version !== 'string') {
    throw archiveRefusal(PACKAGE_JSON, 'has no name and version');
  }
  if (!Array.isArray(keywords) || !keywords.includes(BLUEPRINT_PACKAGE_KEYWORD)) {
    throw archiveRefusal(PACKAGE_JSON, `must list the keyword ${BLUEPRINT_PACKAGE_KEYWORD}`);
  }
  return { name, version };
}

/**
 * Every way the package's files disagree with its manifest: a version that is not `package.json`'s,
 * a file the manifest does not list, a listed file that is missing.
 */
function manifestIssues(
  manifest: BlueprintManifest,
  packageVersion: string,
  entries: ReadonlyMap<string, Uint8Array>,
  listed: readonly string[],
): ProjectRenderIssue[] {
  const allowed = new Set([PACKAGE_JSON, BLUEPRINT_MANIFEST_FILE, ...listed]);
  const issues: ProjectRenderIssue[] = [];
  if (packageVersion !== manifest.version) {
    issues.push({
      path: `${BLUEPRINT_MANIFEST_FILE}: version`,
      message: `is ${manifest.version}, but ${PACKAGE_JSON} says ${packageVersion}`,
    });
  }
  for (const path of entries.keys()) {
    if (!allowed.has(path) && !PACKAGE_DOCUMENT.test(path)) {
      issues.push({ path, message: `is not a part ${BLUEPRINT_MANIFEST_FILE} lists` });
    }
  }
  for (const path of listed) {
    if (!entries.has(path)) {
      issues.push({ path, message: 'is listed but missing from the package' });
    }
  }
  return issues;
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
  const entries = readRegularFiles(tar);
  const identity = packageIdentity(text(PACKAGE_JSON, entries.get(PACKAGE_JSON)));
  const manifest = parseBlueprintManifest(
    text(BLUEPRINT_MANIFEST_FILE, entries.get(BLUEPRINT_MANIFEST_FILE)),
  );
  const listed = [...manifest.parts.map((part) => part.path), ...manifest.migrations];
  const issues = manifestIssues(manifest, identity.version, entries, listed);
  if (issues.length > 0) throw new ProjectRenderError(BLUEPRINT_PACKAGE_SUBJECT, issues);
  return Object.freeze({
    manifest,
    packageName: identity.name,
    packageVersion: identity.version,
    files: Object.freeze(
      listed.map((path) => Object.freeze({ path, contents: text(path, entries.get(path)) })),
    ),
  });
}
