/**
 * `agent-workspace render [dir] [--check] [--upgrade]` — bring a generated project back in line
 * with its edited `agent-workspace.yaml` (ADR-0090), and with `--upgrade` move its platform image
 * pins to this CLI's release (BH061-026).
 *
 * `render` owns exactly what `create` renders from the profile and an operator never writes:
 * `deploy/` (through `renderDeployArtefacts`, the renderer `create` uses), `compose.yaml` for a
 * `local` profile (the same template `create` copies), and the image lines of `.env` (through
 * `envImageEntries`, the list `renderEnv` writes). Every other `.env` line — the secrets, and
 * anything the operator added — keeps its bytes and its place, and no file outside that set is
 * ever written or deleted. What an earlier profile or generator left behind is listed, not removed.
 *
 * Everything is planned before anything is written, so a refused profile, a malformed `.env`, an
 * image that fails the digest gate or an owned path that is a symbolic link leaves the project as
 * it was. Each changed file is then replaced atomically, so a crash cannot truncate `.env`. Output
 * names paths, statuses and `.env` key names only: `.env` holds the deployment's secrets, so no
 * value read from it is ever printed, and a malformed line is refused by its number, never quoted.
 * The one exception is the image references `--upgrade` moves, which are public configuration (the
 * deploy redactor never masks them either), printed as `KEY: old -> new` so the move is reviewable.
 */
import { lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { TEMPLATES_DIRECTORY } from './create.ts';
import { parseEnvLine, resolveDeploymentImages, type DeploymentImages } from './deployment.ts';
import { COMPOSE_PROJECT_CREATE_COMMAND, parseProfileDocument } from './profile.ts';
import { renderDeployArtefacts, type RenderedArtefact } from './render/artefacts.ts';
import {
  ENV_IMAGE_KEYS,
  ENV_VERSION_KEY,
  envImageEntries,
  type EnvImageEntry,
} from './render/env.ts';
import { findLeftovers, type Leftovers } from './render/leftovers.ts';
import { writeFileAtomically } from './render/write-file.ts';
import { PLATFORM_IMAGE_VERSION } from './release-images.ts';

const PROFILE_FILE = 'agent-workspace.yaml';
const ENV_FILE = '.env';
const COMPOSE_FILE = 'compose.yaml';
const USAGE = 'Usage: agent-workspace render [dir] [--check] [--upgrade]';

/**
 * The images `--upgrade` moves: the four the platform release publishes. PostgreSQL and SeaweedFS
 * keep their pins, because a new major of either is a data migration, not an image swap.
 */
const PLATFORM_IMAGES = ['web', 'gateway', 'runner', 'runtime'] as const;

type RenderStatus = 'created' | 'updated' | 'unchanged';

/** One owned file, and what rendering did (or, with `--check`, would do) to it. */
export interface RenderReport {
  /** Path relative to the project directory. */
  readonly path: string;
  readonly status: RenderStatus;
}

interface PlannedFile extends RenderReport {
  readonly contents: string;
  /** The mode of the file being replaced, which the new one keeps; `null` for a new file. */
  readonly mode: number | null;
}

/** One image pin `--upgrade` moved, by its `.env` key. */
interface MovedImage {
  readonly key: string;
  readonly from: string;
  readonly to: string;
}

interface RenderPlan {
  readonly files: readonly PlannedFile[];
  readonly leftovers: Leftovers;
  readonly moved: readonly MovedImage[];
}

export interface RenderCommandArguments {
  readonly directory: string;
  /** Report drift and exit non-zero instead of writing. */
  readonly check: boolean;
  /** Resolve the platform images from this CLI's release instead of keeping `.env`'s pins. */
  readonly upgrade: boolean;
}

/**
 * Parse `[dir] [--check] [--upgrade]`. An unknown flag is refused rather than ignored: `--chek`
 * silently dropped would write the files a CI job only meant to compare.
 */
export function parseRenderArguments(argv: readonly string[]): RenderCommandArguments {
  let directory: string | null = null;
  let check = false;
  let upgrade = false;
  for (const argument of argv) {
    if (argument === '--check') {
      check = true;
      continue;
    }
    if (argument === '--upgrade') {
      upgrade = true;
      continue;
    }
    if (argument.startsWith('-')) {
      throw new Error(`Unknown option ${JSON.stringify(argument)}. ${USAGE}`);
    }
    if (directory !== null) {
      throw new Error(`Unexpected extra argument ${JSON.stringify(argument)}. ${USAGE}`);
    }
    directory = argument;
  }
  return { directory: path.resolve(directory ?? process.cwd()), check, upgrade };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function refuseOwnedPath(shown: string, problem: string, kind: 'file' | 'directory'): Error {
  return new Error(
    `${shown} ${problem}; render writes only regular files inside the project and does not ` +
      `follow links. Replace it with a regular ${kind}, then re-run agent-workspace render. ` +
      'Nothing was written.',
  );
}

/**
 * The mode of the regular file at `relative` (a `/`-separated path under the project), or `null`
 * when it does not exist yet. Every existing component is `lstat`ed, and a symbolic link at any
 * of them (`deploy`, `deploy/helm`, `.env`, …) is refused while planning, so nothing has been
 * written. The project directory itself may be a link: choosing where it lives is the operator's.
 */
async function inspectOwnedPath(directory: string, relative: string): Promise<number | null> {
  const components = relative.split('/');
  for (const [index] of components.entries()) {
    const reached = components.slice(0, index + 1);
    const isTarget = reached.length === components.length;
    let entry;
    try {
      entry = await lstat(path.join(directory, ...reached));
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    const kind = isTarget ? 'file' : 'directory';
    if (entry.isSymbolicLink())
      throw refuseOwnedPath(reached.join('/'), 'is a symbolic link', kind);
    if (isTarget ? !entry.isFile() : !entry.isDirectory()) {
      throw refuseOwnedPath(reached.join('/'), `is not a regular ${kind}`, kind);
    }
    if (isTarget) return entry.mode & 0o7777;
  }
  return null;
}

/** An owned file as it is on disk, or `null` when it does not exist; see `inspectOwnedPath`. */
async function readOwned(
  directory: string,
  relative: string,
): Promise<{ readonly contents: string; readonly mode: number } | null> {
  const mode = await inspectOwnedPath(directory, relative);
  if (mode === null) return null;
  return { contents: await readFile(path.join(directory, relative), 'utf8'), mode };
}

/** One `\n`-separated segment of `.env`, with its trailing `\r` (if any) kept for writing back. */
interface EnvSegment {
  readonly text: string;
  /** The `NAME` of a `NAME=value` line; `null` for a comment or a blank line. */
  readonly key: string | null;
  readonly value: string;
  /** The bytes before the name (`export `) and after the value (an inline comment). */
  readonly prefix: string;
  readonly suffix: string;
}

/**
 * Split `.env` into its lines, read with `parseEnvLine`, the rule `parseEnvironment` applies:
 * blank lines and `#` comments are skipped, and every other line must be `NAME=value`, optionally
 * after `export ` and before an inline `# comment`. A line that is not is refused by its number
 * only — its text may be a secret.
 */
function readEnvSegments(contents: string): readonly EnvSegment[] {
  return contents.split('\n').map((text, index) => {
    const line = parseEnvLine(text.endsWith('\r') ? text.slice(0, -1) : text);
    if (line.kind === 'invalid') {
      throw new Error(
        `${ENV_FILE} line ${String(index + 1)} is not a comment or NAME=value; fix it, then ` +
          're-run agent-workspace render. Nothing was written.',
      );
    }
    if (line.kind === 'blank') return { text, key: null, value: '', prefix: '', suffix: '' };
    return { text, key: line.key, value: line.value, prefix: line.prefix, suffix: line.suffix };
  });
}

/**
 * The image references `.env` already pins, keyed as `DeploymentImages`. The last occurrence of a
 * key wins, as it does for `parseEnvironment` and for Compose; a blank value pins nothing.
 */
function pinnedImages(segments: readonly EnvSegment[]): Partial<DeploymentImages> {
  const pinned: Partial<Record<keyof DeploymentImages, string>> = {};
  for (const [name, key] of Object.entries(ENV_IMAGE_KEYS) as [keyof DeploymentImages, string][]) {
    for (const segment of segments) {
      if (segment.key === key && segment.value !== '') pinned[name] = segment.value;
    }
  }
  return pinned;
}

/**
 * The policy ceiling `.env` carries as `AW_DEPLOYMENT_POLICY` (which `aw deploy` writes
 * single-quoted), or `undefined` when it carries none. The last occurrence wins.
 */
function deploymentPolicy(segments: readonly EnvSegment[]): string | undefined {
  const value = segments.findLast(({ key }) => key === 'AW_DEPLOYMENT_POLICY')?.value ?? '';
  const json = /^'(.*)'$/u.exec(value)?.[1] ?? value;
  return json === '' ? undefined : json;
}

/**
 * The origin of the `AW_PUBLIC_URL` `.env` carries (which `aw deploy` writes), or `undefined`
 * when blank. A trailing slash or path is dropped because the Terraform modules accept only an
 * origin; a value that is not a parseable URL is kept so the module's own validation rejects it.
 */
function publicUrl(segments: readonly EnvSegment[]): string | undefined {
  const value = segments.findLast(({ key }) => key === 'AW_PUBLIC_URL')?.value.trim() ?? '';
  if (value === '') return undefined;
  const origin = URL.canParse(value) ? new URL(value).origin : 'null';
  return origin === 'null' ? value : origin;
}

/**
 * `.env` with only its image values rewritten. An owned key is rewritten in place, every
 * occurrence of it, keeping an `export ` before it and a comment after it; a missing one is
 * inserted after the last owned line, or at the end when there is none. Every other line keeps
 * its bytes, its place and its line ending. An image key the profile no longer selects
 * (`POSTGRES_IMAGE` after a move off `local`) is not the renderer's to remove, so it is left as
 * it is and reported.
 */
function rewriteEnvImages(
  segments: readonly EnvSegment[],
  entries: readonly EnvImageEntry[],
): string {
  const crlf = segments[0]?.text.endsWith('\r') === true;
  const written = new Set<string>();
  let lastOwned = -1;
  const lines = segments.map(({ text, key, prefix, suffix }, index) => {
    const entry = entries.find(([owned]) => owned === key);
    if (entry === undefined) return text;
    written.add(entry[0]);
    lastOwned = index;
    return `${prefix}${entry[0]}=${entry[1]}${suffix}${text.endsWith('\r') ? '\r' : ''}`;
  });
  const missing = entries
    .filter(([key]) => !written.has(key))
    .map(([key, reference]) => `${key}=${reference}${crlf ? '\r' : ''}`);
  const endsWithNewline = lines.at(-1) === '';
  const insertAt = lastOwned >= 0 ? lastOwned + 1 : lines.length - (endsWithNewline ? 1 : 0);
  lines.splice(insertAt, 0, ...missing);
  return lines.join('\n');
}

export interface RunRenderCommandOptions {
  /** Where `AW_<NAME>_IMAGE` overrides are read; production reads `process.env`. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Where the report goes; `process.stdout` by default. `deploy` passes it through its redactor. */
  readonly out?: (text: string) => void;
  /** Where profile warnings go; `process.stderr` by default. */
  readonly err?: (text: string) => void;
}

/** Everything `render` owns for this profile, with what is on disk now — nothing is written. */
async function planRender(
  directory: string,
  environment: NodeJS.ProcessEnv,
  err: (text: string) => void,
  upgrade: boolean,
): Promise<RenderPlan> {
  const document = await readOptional(path.join(directory, PROFILE_FILE));
  if (document === null) {
    throw new Error(
      `${PROFILE_FILE} was not found in ${directory}. render re-renders the Compose project ` +
        `\`${COMPOSE_PROJECT_CREATE_COMMAND}\` generates; run it in that directory or pass it as ` +
        '[dir].',
    );
  }
  const profile = parseProfileDocument(document, {
    onWarning: (message) => err(`${message}\n`),
  });

  const env = await readOwned(directory, ENV_FILE);
  if (env === null) {
    throw new Error(
      `${ENV_FILE} was not found in ${directory}. render rewrites the image lines of an existing ` +
        `${ENV_FILE} and never generates secrets; restore it, or generate a new project with ` +
        `\`${COMPOSE_PROJECT_CREATE_COMMAND}\`.`,
    );
  }
  const segments = readEnvSegments(env.contents);
  const pinned = pinnedImages(segments);
  const kept: Partial<DeploymentImages> = { ...pinned };
  if (upgrade) for (const name of PLATFORM_IMAGES) delete kept[name];
  const images = resolveDeploymentImages(profile.cloud, environment, kept);
  const imageEntries = envImageEntries(profile, images);
  const moved = PLATFORM_IMAGES.flatMap((name): MovedImage[] => {
    const from = pinned[name];
    const to = images[name];
    return upgrade && from !== undefined && from !== to
      ? [{ key: ENV_IMAGE_KEYS[name], from, to }]
      : [];
  });
  // A Vercel project names the release its digests were resolved for (ENV_VERSION_KEY). `render`
  // leaves that line alone, except when `--upgrade` has just resolved them for this CLI's release.
  const envEntries: readonly EnvImageEntry[] =
    upgrade && segments.some(({ key }) => key === ENV_VERSION_KEY)
      ? [...imageEntries, [ENV_VERSION_KEY, PLATFORM_IMAGE_VERSION]]
      : imageEntries;

  const desired: RenderedArtefact[] = [
    ...renderDeployArtefacts(profile, images, {
      deploymentPolicy: deploymentPolicy(segments),
      publicUrl: publicUrl(segments),
    }),
  ];
  if (profile.cloud === 'local') {
    desired.push({
      path: COMPOSE_FILE,
      contents: await readFile(new URL(COMPOSE_FILE, TEMPLATES_DIRECTORY), 'utf8'),
    });
  }
  desired.push({ path: ENV_FILE, contents: rewriteEnvImages(segments, envEntries) });

  const files = await Promise.all(
    desired.map(async ({ path: file, contents }): Promise<PlannedFile> => {
      const current = file === ENV_FILE ? env : await readOwned(directory, file);
      const status: RenderStatus =
        current === null ? 'created' : current.contents === contents ? 'unchanged' : 'updated';
      return { path: file, status, contents, mode: current?.mode ?? null };
    }),
  );
  const leftovers = await findLeftovers(directory, {
    renderedFiles: files.map(({ path: file }) => file),
    envKeys: segments.flatMap(({ key }) => (key === null ? [] : [key])),
    renderedEnvKeys: imageEntries.map(([key]) => key),
  });
  return { files, leftovers, moved };
}

const CHECK_WORDING: Readonly<Record<RenderStatus, string>> = {
  created: 'would create',
  updated: 'would update',
  unchanged: 'unchanged',
};

/** The lines naming what `render` leaves in place, or `''` when nothing is left over. */
function describeLeftovers({ files, envKeys }: Leftovers): string {
  const entries = [...files, ...envKeys.map((key) => `${ENV_FILE} key ${key}`)];
  if (entries.length === 0) return '';
  return (
    'Left in place (render no longer writes these and never deletes them; remove them once ' +
    'nothing uses them):\n' +
    entries.map((entry) => `  ${entry}\n`).join('')
  );
}

/** `agent-workspace render [dir] [--check]`. */
export async function runRenderCommand(
  argv: readonly string[] = [],
  options: RunRenderCommandOptions = {},
): Promise<readonly RenderReport[]> {
  const out = options.out ?? ((text: string) => void process.stdout.write(text));
  const err = options.err ?? ((text: string) => void process.stderr.write(text));
  const { directory, check, upgrade } = parseRenderArguments(argv);
  const {
    files: planned,
    leftovers,
    moved,
  } = await planRender(directory, options.environment ?? process.env, err, upgrade);
  const changed = planned.filter(({ status }) => status !== 'unchanged');

  if (!check) {
    for (const { path: file, contents, mode } of changed) {
      const target = path.join(directory, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFileAtomically(target, contents, mode);
    }
  }

  const label = (status: RenderStatus) => (check ? CHECK_WORDING[status] : status);
  const width = Math.max(...planned.map(({ status }) => label(status).length));
  out(
    planned.map(({ path: file, status }) => `${label(status).padEnd(width)}  ${file}\n`).join(''),
  );
  if (upgrade) {
    out(
      moved.length === 0
        ? `Every platform image already pins release ${PLATFORM_IMAGE_VERSION}.\n`
        : `${check ? 'Would move' : 'Moved'} the platform images to release ` +
            `${PLATFORM_IMAGE_VERSION}:\n` +
            moved.map(({ key, from, to }) => `  ${key}: ${from} -> ${to}\n`).join(''),
    );
  }
  const left = describeLeftovers(leftovers);
  if (left !== '') out(left);

  const count = `${String(changed.length)} file${changed.length === 1 ? '' : 's'}`;
  if (changed.length === 0) {
    out(`Nothing to change: every rendered file matches ${PROFILE_FILE}.\n`);
  } else if (check) {
    throw new Error(
      `${count} would change to match ${PROFILE_FILE}; run agent-workspace render to write ` +
        `${changed.length === 1 ? 'it' : 'them'}. Nothing was written.`,
    );
  } else {
    out(`Rendered ${count} from ${PROFILE_FILE}.\n`);
  }
  return planned.map(({ path: file, status }) => ({ path: file, status }));
}
