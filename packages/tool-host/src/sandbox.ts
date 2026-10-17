/**
 * The tool sandbox's process (ADR-0118 TS2-TS5, TS9; issue #791).
 *
 * The runner starts this container empty and writes `manifest.json` into its workspace: the tools
 * to serve, each with its bundle, and `env`, the secrets the session's tools declared. This
 * process checks every bundle against its digest, writes it down, and starts the same tool host
 * `aw dev` runs, in its hosted form, with exactly that `env` as the host's whole environment (and,
 * for the egress proxy the runner pointed this process at, the proxy variables; and, when the
 * manifest has `stdio` MCP servers, `PATH` and a `HOME` and npm cache inside the workspace so `npx`
 * can run, ADR-0118 TS6). It serves nothing until the runner writes `tokens.json`, and it reports
 * itself ready by writing `ready`. It never imports the database layer: what it can run is only what a version pinned.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startToolHost, type ToolHost } from '@indx-workspace/aw/tools/host';
import {
  ToolSandboxManifestSchema,
  type ToolSandboxManifest,
} from '@indx-workspace/contracts/agent-versions';

export const READY_FILE = 'ready';
export const MANIFEST_FILE = 'manifest.json';
export const TOKENS_FILE = 'tokens.json';

const MANIFEST_POLL_MS = 100;

/** The variables that point an HTTP client at the egress proxy (`egressProxyEnvironment`). */
const PROXY_VARIABLES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
] as const;

/** A proxy or npm configuration name, in any case: the runner's to set, never a declared secret's. */
const PLATFORM_VARIABLE = /^(?:https?_proxy|no_proxy|node_use_env_proxy|npm_config_.*)$/iu;

export class ManifestError extends Error {
  override readonly name = 'ManifestError';
}

/** Parse a manifest; a problem names the path of the field, never a value (a value may be a secret). */
export function parseManifest(raw: string): ToolSandboxManifest {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new ManifestError('the manifest is not JSON');
  }
  const parsed = ToolSandboxManifestSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ManifestError(
      `the manifest is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/** Write each bundle under `directory/<digest>.mjs`, in manifest order, after checking it is the program its digest names. */
export async function writeBundles(
  manifest: ToolSandboxManifest,
  directory: string,
): Promise<readonly string[]> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files: string[] = [];
  for (const tool of manifest.tools) {
    const bytes = Buffer.from(tool.bundleBase64, 'base64');
    if (createHash('sha256').update(bytes).digest('hex') !== tool.digest) {
      throw new ManifestError(`the bundle of ${tool.name} is not the program ${tool.digest} names`);
    }
    const file = path.join(directory, `${tool.digest}.mjs`);
    await writeFile(file, bytes, { mode: 0o600 });
    files.push(file);
  }
  return files;
}

/**
 * The file's text once it is there and, for a JSON file, once it parses: a provider's file API
 * writes in place, so a read can see half an upload. A file that never parses is the runner's to
 * give up on (it removes a sandbox that is not ready in time).
 */
async function waitForFile(file: string, signal: AbortSignal): Promise<string> {
  for (;;) {
    signal.throwIfAborted();
    try {
      const text = await readFile(file, 'utf8');
      JSON.parse(text);
      return text;
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, MANIFEST_POLL_MS));
  }
}

export interface SandboxOptions {
  /** The workspace the runner writes `manifest.json` and `tokens.json` into. */
  readonly directory: string;
  readonly host: string;
  readonly port: number;
  readonly stderr: (text: string) => void;
  readonly signal: AbortSignal;
  /** The environment the proxy variables and `PATH` come from; this process's own by default. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * The tool host's whole environment: the declared secrets, then what the host cannot run without.
 * A secret never stands in for the platform's names: `PATH` and `HOME` are reserved secret names,
 * and a declared proxy (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY`) or
 * `npm_config_*` variable, in any case, is dropped before the runner's is added back.
 */
function hostEnvironment(
  manifest: ToolSandboxManifest,
  directory: string,
  inherited: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(manifest.env).filter(([name]) => !PLATFORM_VARIABLE.test(name)),
  );
  for (const name of PROXY_VARIABLES) {
    const value = inherited[name];
    if (value !== undefined) env[name] = value;
  }
  if (manifest.stdioServers.length > 0) {
    if (inherited['PATH'] !== undefined) env['PATH'] = inherited['PATH'];
    env['HOME'] = path.join(directory, 'home');
    env['npm_config_cache'] = path.join(directory, 'npm-cache');
  }
  return env;
}

/** Wait for the manifest, start the host, and report ready once every tool is served. */
export async function runSandbox(options: SandboxOptions): Promise<ToolHost> {
  const { directory, host, port, stderr, signal, env = process.env } = options;
  const manifestFile = path.join(directory, MANIFEST_FILE);
  const manifest = parseManifest(await waitForFile(manifestFile, signal));
  // The secrets live in the host's environment from here on; no file of them stays behind.
  await rm(manifestFile);
  const files = await writeBundles(manifest, path.join(directory, 'bundles'));
  if (manifest.stdioServers.length > 0) {
    await mkdir(path.join(directory, 'home'), { recursive: true, mode: 0o700 });
  }
  const tokensFile = path.join(directory, TOKENS_FILE);
  // No token is admitted until the runner writes one.
  await writeFile(tokensFile, '[]', { flag: 'wx' }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  const started = await startToolHost({
    root: directory,
    io: { env: hostEnvironment(manifest, directory, env), stderr },
    signal,
    hosted: {
      host,
      port,
      tokensFile,
      tools: manifest.tools.map((tool, index) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        timeoutMs: tool.timeoutMs,
        file: files[index] ?? '',
      })),
      stdioServers: manifest.stdioServers,
    },
  });
  const served = new Set(started.tools());
  const missing = [
    ...manifest.tools.map((tool) => tool.name),
    ...manifest.stdioServers.map((server) => `stdio:${server.name}`),
  ].filter((name) => !served.has(name));
  if (missing.length > 0) {
    throw new ManifestError(`the tool host did not serve ${missing.join(', ')}`);
  }
  const marker = path.join(directory, `${READY_FILE}.tmp`);
  await writeFile(marker, '');
  await rename(marker, path.join(directory, READY_FILE));
  return started;
}
