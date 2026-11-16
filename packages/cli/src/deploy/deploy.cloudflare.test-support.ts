import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseStorageUrl } from '@indx-workspace/contracts/storage-url';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { z } from 'zod';

import { parseEnvironment } from '../deployment.js';
import { databaseUrl, project, type Respond } from './deploy.test-support.js';
import type { ToolInvocation, ToolResult } from './runner.js';

export const token = 'cfat_secret_token_value_0123456789';
export const cloudflareEnvironment = {
  CLOUDFLARE_API_TOKEN: token,
  CLOUDFLARE_ACCOUNT_ID: 'acct123',
  CLOUDFLARE_WORKERS_SUBDOMAIN: 'acme',
  CONTROL_PLANE_URL: 'https://app.example.com',
};

// No test of this target reaches a real network: the control plane answers /setup unless it says otherwise.
beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

export const bridgeUrl = 'https://acme-ai-bridge.acme.workers.dev';
export const e2bTemplate = 'acme-runtime:123e4567-e89b-42d3-a456-426614174000';

export const registry = (repository: string, character: string) =>
  `registry.cloudflare.com/acct123/agent-workspace-${repository}:sha256-${character.repeat(64)}`;

export async function appendEnv(target: string, name: string, value: string): Promise<void> {
  const file = path.join(target, '.env');
  await writeFile(file, `${await readFile(file, 'utf8')}${name}=${value}\n`);
}

export async function editEnv(target: string, name: string, value: string): Promise<void> {
  const file = path.join(target, '.env');
  await writeFile(
    file,
    (await readFile(file, 'utf8')).replace(new RegExp(`^${name}=.*$`, 'mu'), `${name}=${value}`),
  );
}

/** Select `cloudflare-sandbox` in the profile and `.env`, as a project created before BH061-029 has it. */
async function selectNativeSandbox(target: string): Promise<void> {
  const profile = path.join(target, 'agent-workspace.yaml');
  const yaml = await readFile(profile, 'utf8');
  expect(yaml).toContain('default: external');
  await writeFile(profile, yaml.replace('default: external', 'default: cloudflare-sandbox'));
  const file = path.join(target, '.env');
  const env = await readFile(file, 'utf8');
  const external = '# Runtime: external\nRUNTIME_DRIVER=external\nEXTERNAL_PROVIDER=e2b\n';
  expect(env).toContain(external);
  await writeFile(
    file,
    env.replace(external, '# Runtime: cloudflare-sandbox\nRUNTIME_DRIVER=cloudflare-sandbox\n'),
  );
}

/** Select E2B in the profile only, as an operator does: `.env` keeps the driver it was created with. */
export async function selectExternalRuntime(target: string): Promise<void> {
  const file = path.join(target, 'agent-workspace.yaml');
  const text = await readFile(file, 'utf8');
  expect(text).toContain('default: cloudflare-sandbox');
  await writeFile(file, text.replace('default: cloudflare-sandbox', 'default: external'));
}

/**
 * A project an apply can run: the `DATABASE_URL` and sandbox bridge the operator fills, on the
 * native `cloudflare-sandbox` driver the operator chose over the E2B default (BH061-029).
 */
export async function cloudflareProject(): Promise<string> {
  const target = await project('cloudflare');
  await selectNativeSandbox(target);
  const file = path.join(target, '.env');
  const text = await readFile(file, 'utf8');
  expect(text).toContain('\nDATABASE_URL=\n');
  await writeFile(
    file,
    `${text.replace('\nDATABASE_URL=\n', `\nDATABASE_URL=${databaseUrl}\n`)}CLOUDFLARE_SANDBOX_BRIDGE_URL=${bridgeUrl}\n`,
  );
  await editEnv(target, 'OBJECT_STORAGE_ACCESS_KEY_ID', 'r2-access-key');
  await editEnv(target, 'OBJECT_STORAGE_SECRET_ACCESS_KEY', 'r2-secret-key');
  return target;
}

const wranglerConfiguration = z.object({
  name: z.string().min(1).optional(),
  main: z.string().min(1),
  containers: z
    .array(
      z.object({
        name: z.string().min(1).optional(),
        class_name: z.string().min(1).optional(),
        image: z.string().min(1),
      }),
    )
    .default([]),
  durable_objects: z
    .object({ bindings: z.array(z.object({ name: z.string(), class_name: z.string() })) })
    .optional(),
  migrations: z.array(z.object({ new_sqlite_classes: z.array(z.string()).optional() })).default([]),
});

/**
 * The rules of Wrangler 4.147's configuration validation that the Container Workers' files can
 * break (`validateContainerApp` and the Durable Object checks). Wrangler is not a dependency of
 * this repository, so its own reader cannot run here; the live journey runs the real one.
 */
function wranglerProblems(configuration: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const parsed = wranglerConfiguration.safeParse(configuration);
  if (!parsed.success) return [parsed.error.message];
  const { name, containers, durable_objects: objects, migrations } = parsed.data;
  for (const container of containers) {
    if (
      container.name === undefined &&
      (name === undefined || container.class_name === undefined)
    ) {
      problems.push('containers need a top level "name" and "class_name", or their own "name"');
    }
    const className = container.class_name ?? '';
    if (!objects?.bindings.some((binding) => binding.class_name === className)) {
      problems.push(`${className} has no Durable Object binding`);
    }
    if (!migrations.some((migration) => migration.new_sqlite_classes?.includes(className))) {
      problems.push(`${className} has no Durable Object migration`);
    }
  }
  return problems;
}

interface ResponderOptions {
  readonly listed?: readonly string[];
  readonly echo?: string;
  readonly registryTags?: string;
  readonly failRun?: boolean;
  /** What `r2 bucket info` answers: the bucket is missing, or the call fails for another reason. */
  readonly bucket?: 'missing' | 'denied';
}

/** One answer of the fake Wrangler and Docker; `undefined` leaves the call to the next route. */
type Route = (invocation: ToolInvocation) => Partial<ToolResult> | undefined;

const bucketRoute =
  (bucket: ResponderOptions['bucket']): Route =>
  ({ args }) => {
    if (args[0] !== 'r2' || args[2] !== 'info' || bucket === undefined) return undefined;
    return {
      status: 1,
      stderr:
        bucket === 'missing'
          ? 'The specified bucket does not exist. [code: 10006]'
          : 'Authentication error [code: 10000]',
    };
  };

const secretListRoute =
  (exists: boolean, listed: readonly string[], echo: string): Route =>
  ({ args }) => {
    if (args[0] !== 'secret' || args[1] !== 'list') return undefined;
    return exists
      ? { stdout: JSON.stringify(listed.map((name) => ({ name, type: 'secret_text' }))) }
      : { status: 1, stderr: `A request to the Cloudflare API failed. Worker not found. ${echo}` };
  };

const imagesRoute =
  (registryTags: string): Route =>
  ({ args }) =>
    args[0] === 'containers' && args[1] === 'images' ? { stdout: registryTags } : undefined;

const migrationRoute =
  (failRun: boolean): Route =>
  ({ tool, args }) =>
    tool === 'docker' && args[0] === 'run' && failRun
      ? { status: 1, stderr: 'migration failed' }
      : undefined;

/** `deploy --config <file> --name <worker>` and `secret bulk --name <worker> --config <file>`. */
function wranglerConfigurationOf({ args }: ToolInvocation) {
  const isDeploy = args[0] === 'deploy' && args[1] === '--config';
  const isBulk = args[0] === 'secret' && args[1] === 'bulk';
  const file = isDeploy ? args[2] : isBulk ? args[5] : undefined;
  if (file === undefined) return undefined;
  return { file, isDeploy, worker: (isDeploy ? args[4] : args[3]) ?? '' };
}

/** The configuration a Wrangler call is handed, read now because the file is removed afterwards. */
const configurationRoute =
  (deployed: Map<string, Record<string, unknown>>, echo: string): Route =>
  (invocation) => {
    const found = wranglerConfigurationOf(invocation);
    if (found !== undefined) {
      const { file, isDeploy, worker } = found;
      const configuration = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(readFileSync(file, 'utf8')));
      if ('containers' in configuration) {
        expect(configuration['name']).toBe(worker);
        expect(wranglerProblems(configuration)).toEqual([]);
      }
      if (isDeploy) deployed.set(worker, configuration);
      else expect(configuration).toEqual(deployed.get(worker));
    }
    return { stdout: echo, stderr: echo };
  };

/**
 * `secret list` answers: the Worker is absent, or present with `listed` secret names.
 * `containers images list` answers with `registryTags`. The configuration each `wrangler deploy`
 * is handed is read as it runs, because it is a temporary file removed afterwards.
 */
export function cloudflareResponder(
  exists: boolean,
  options: ResponderOptions = {},
): { respond: Respond; deployed: Map<string, Record<string, unknown>> } {
  const { listed = [], echo = '', registryTags = '', failRun = false, bucket } = options;
  const deployed = new Map<string, Record<string, unknown>>();
  const routes: Route[] = [
    bucketRoute(bucket),
    secretListRoute(exists, listed, echo),
    imagesRoute(registryTags),
    migrationRoute(failRun),
    configurationRoute(deployed, echo),
  ];
  const respond: Respond = (invocation) => {
    for (const route of routes) {
      const answer = route(invocation);
      if (answer !== undefined) return answer;
    }
    return {};
  };
  return { respond, deployed };
}

export const putsOf = (calls: readonly ToolInvocation[]) =>
  calls
    .filter(({ args }) => args[0] === 'secret' && args[1] === 'put')
    .map(({ args, input }) => [args[2], input, args[4]]);
export const retentionPuts = (calls: readonly ToolInvocation[]) =>
  putsOf(calls)
    .filter(([, , name]) => name === 'acme-ai')
    .map(([name, input]) => [name, input]);
export const bulksOf = (calls: readonly ToolInvocation[]) =>
  calls.filter(({ args }) => args[0] === 'secret' && args[1] === 'bulk');
/** The secrets one Worker received, as the one `wrangler secret bulk` call reads them from stdin. */
export const bulkFor = (calls: readonly ToolInvocation[], worker: string): Record<string, string> =>
  z
    .record(z.string(), z.string())
    .parse(JSON.parse(bulksOf(calls).find(({ args }) => args[3] === worker)?.input ?? 'null'));
export const controlPlanePuts = (calls: readonly ToolInvocation[]) =>
  Object.entries(bulkFor(calls, 'acme-ai-control-plane'));
export const summary = (calls: readonly ToolInvocation[]) =>
  calls.map(({ tool, args }) => `${tool} ${args.slice(0, 2).join(' ')}`);

export const masterKey = async (target: string) =>
  parseEnvironment(await readFile(path.join(target, '.env'), 'utf8'))['MASTER_ENCRYPTION_KEY'];

/** The location the control plane received in `AW_STORAGE_URL`. */
export const pushedLocation = (calls: readonly ToolInvocation[]) => {
  const parsed = parseStorageUrl(bulkFor(calls, 'acme-ai-control-plane')['AW_STORAGE_URL'] ?? '');
  return parsed.ok ? parsed.location : null;
};
