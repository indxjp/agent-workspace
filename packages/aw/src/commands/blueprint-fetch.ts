/**
 * Fetching an app blueprint's npm package (ADR-0166 D4) for `aw blueprint add`, `diff` and
 * `update`: `npm pack <spec> --json --ignore-scripts` into a new temporary directory, so the
 * package's install scripts never run, then the tarball's sha512 is compared with the integrity
 * npm reported before a single entry is read. The developer's `.npmrc` (registry, scope,
 * authentication) applies, because npm runs in the project directory; `aw`'s own keys never reach
 * it, and neither does `NODE_OPTIONS`.
 *
 * {@link unpackBlueprint} gunzips the verified bytes with `node:zlib` and hands them to the SDK's
 * pure `readBlueprintArchive`, which refuses links, unsafe paths and unlisted files.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
  BLUEPRINT_ARCHIVE_MAX_BYTES,
  ProjectRenderError,
  readBlueprintArchive,
  type BlueprintArchive,
} from '@indx-workspace/sdk/project';
import { z } from 'zod';

import { appKitEnvironment } from '../generate/app-kit.js';
import { CommandRefusedError, UsageError } from '../io.js';
import { errorCode } from '../local-runtime/project.js';

/** A fetched package whose tarball matched its integrity. */
export interface FetchedBlueprint {
  /** The npm package name and the exact version npm resolved the spec to. */
  readonly package: string;
  readonly version: string;
  /** npm's `sha512-<base64>` integrity of the tarball, verified. */
  readonly integrity: string;
  /** The gzipped tarball's bytes. */
  readonly tarball: Uint8Array;
}

/** What one `npm` run printed and how it ended. */
interface NpmRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** How `npm` is started: the arguments, the directory and the (allowlisted) environment. */
export type NpmRunner = (
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  },
) => Promise<NpmRun>;

/** Where a fetch runs, and what it inherits. */
export interface BlueprintFetchOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
}

/**
 * The port the `blueprint` commands fetch through. The real one is {@link fetchBlueprint} over
 * {@link spawnNpm}; command tests pass one that returns an in-memory tarball.
 */
export type BlueprintFetch = (
  spec: string,
  options: BlueprintFetchOptions,
) => Promise<FetchedBlueprint>;

/** The most bytes the gzipped tarball, and the tar inside it, may hold. */
const TARBALL_MAX_BYTES = BLUEPRINT_ARCHIVE_MAX_BYTES;
const TAR_MAX_BYTES = BLUEPRINT_ARCHIVE_MAX_BYTES + 2 * 1024 * 1024;

/** How long one `npm pack` may take, and how much output `aw` keeps from it. */
const NPM_TIMEOUT_MS = 120_000;
const OUTPUT_MAX = 1024 * 1024;

/**
 * The variables npm needs beyond {@link appKitEnvironment}: its own configuration (`npm_config_*`,
 * which names the registry and the cache), the tokens an `.npmrc` refers to by `${...}`, a proxy
 * and extra certificate authorities.
 */
const NPM_ENV = [
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
];

/** `env` reduced to what `npm pack` needs; never `AGENT_WORKSPACE_API_KEY` or `NODE_OPTIONS`. */
export function npmEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result = appKitEnvironment(env);
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    const allowed = upper.startsWith('NPM_CONFIG_') || NPM_ENV.includes(upper);
    if (value !== undefined && allowed) result[name] = value;
  }
  return result;
}

/** Runs `npm <args>` with no shell: the spec is one argument, never parsed by a shell. */
const spawnNpm: NpmRunner = (args, options) =>
  new Promise((resolve, reject) => {
    // shortcut: `npm` from the PATH, which on Windows is `npm.cmd` and needs a shell; upgrade to
    // resolving npm's own `npm-cli.js` when Windows developers install blueprints.
    const child = spawn('npm', [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
      timeout: NPM_TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < OUTPUT_MAX) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < OUTPUT_MAX) stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });

/**
 * The four fields `aw` reads from `npm pack --json`, which prints many others, so the objects are
 * deliberately not strict. The file name is a plain name inside the pack directory.
 */
const PackOutputSchema = z
  .array(
    z.object({
      name: z.string().min(1).max(214),
      version: z.string().min(1).max(256),
      filename: z
        .string()
        .min(1)
        .max(512)
        .regex(/^[^/\\]+\.tgz$/u)
        .refine((name) => !name.startsWith('.')),
      integrity: z
        .string()
        .max(256)
        .regex(/^sha512-[A-Za-z0-9+/]+=*$/u),
    }),
  )
  .length(1);

function packOutput(stdout: string): z.infer<typeof PackOutputSchema>[number] {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new CommandRefusedError('npm pack did not print the JSON aw asked for');
  }
  const parsed = PackOutputSchema.safeParse(json);
  const [packed] = parsed.success ? parsed.data : [];
  if (packed === undefined) {
    throw new CommandRefusedError(
      'npm pack did not name exactly one tarball with its sha512 integrity',
    );
  }
  return packed;
}

/** npm's integrity of `bytes`: `sha512-<base64>`. */
export function sha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

async function runPack(
  run: NpmRunner,
  args: readonly string[],
  options: BlueprintFetchOptions,
): Promise<NpmRun> {
  try {
    return await run(args, {
      cwd: options.cwd,
      env: npmEnvironment(options.env),
      signal: options.signal,
    });
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'EINVAL') {
      throw new CommandRefusedError(
        'aw blueprint fetches packages with npm, which is not on the PATH',
        'install Node.js, which ships npm',
      );
    }
    throw error;
  }
}

/**
 * Fetches `spec` with `npm pack` into a new temporary directory and verifies the tarball against
 * the integrity npm reported. The directory is removed whatever happens.
 *
 * @throws {UsageError} for a spec that would be read as an npm flag.
 * @throws {CommandRefusedError} when npm is missing or fails, prints something else than one
 *   tarball, the tarball is too large, or its sha512 is not the reported integrity.
 */
export async function fetchBlueprint(
  spec: string,
  options: BlueprintFetchOptions,
  run: NpmRunner = spawnNpm,
): Promise<FetchedBlueprint> {
  if (spec.trim() === '' || spec.startsWith('-')) {
    throw new UsageError(`${JSON.stringify(spec)} is not an npm package spec`);
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'aw-blueprint-'));
  try {
    const args = ['pack', spec, '--json', '--ignore-scripts', '--pack-destination', directory];
    const result = await runPack(run, args, options);
    if (result.code !== 0) {
      const reason = result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500);
      throw new CommandRefusedError(
        `npm pack ${spec} failed: ${reason || `exit code ${String(result.code)}`}`,
      );
    }
    const packed = packOutput(result.stdout);
    const file = path.join(directory, packed.filename);
    if ((await stat(file)).size > TARBALL_MAX_BYTES) {
      throw new CommandRefusedError(`${packed.name}@${packed.version} is larger than 5 MiB`);
    }
    const tarball = new Uint8Array(await readFile(file));
    if (sha512Integrity(tarball) !== packed.integrity) {
      throw new CommandRefusedError(
        `${packed.name}@${packed.version}: the tarball does not match the integrity npm reported; nothing was read from it`,
      );
    }
    return {
      package: packed.name,
      version: packed.version,
      integrity: packed.integrity,
      tarball,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * The verified tarball, gunzipped (at most a little over 5 MiB) and read by the SDK.
 *
 * @throws {CommandRefusedError} when it is not gzip, is too large, or the reader refuses it.
 */
export function unpackBlueprint(fetched: FetchedBlueprint): BlueprintArchive {
  let tar: Uint8Array;
  try {
    tar = gunzipSync(fetched.tarball, { maxOutputLength: TAR_MAX_BYTES });
  } catch (error) {
    const tooLarge = errorCode(error) === 'ERR_BUFFER_TOO_LARGE';
    throw new CommandRefusedError(
      `${fetched.package}@${fetched.version} ${tooLarge ? 'unpacks to more than 5 MiB' : 'is not a gzipped tarball'}`,
    );
  }
  try {
    return readBlueprintArchive(tar);
  } catch (error) {
    if (error instanceof ProjectRenderError) throw new CommandRefusedError(error.message);
    throw error;
  }
}
