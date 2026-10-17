/**
 * Produces the probe artefact each provider lane needs, inside the run, from `probe.Dockerfile` and
 * `probe.mjs` (issue #832, E7 slice 2). A non-empty override variable (`E2B_PROBE_TEMPLATE`,
 * `VERCEL_PROJECT_ID`, `VERCEL_PROBE_IMAGE`, `CLOUDFLARE_PROBE_IMAGE`) is used as is and nothing is
 * built; otherwise the artefact is derived with the provider's own mechanism and cached under a
 * fixed name, tagged `p-<content hash>` so a daily run rebuilds only when the probe changed.
 * `prepare` never throws: a build or push failure comes back as `{ failure }` and the lane records
 * every row `fail` (a missing credential stays `skipped`, decided before this runs).
 *
 * Tokens reach the provider tools through the step environment, stdin or a header, never argv, and
 * every message carries the operation and status only; `prepare` redacts whatever is left.
 *
 * Vendor facts (checked 2026-10-08):
 * - E2B, over REST with `fetch` and `X-API-Key` like the E2 driver (`e2b` is on `denyByName`):
 *   `POST /v3/templates {name}` answers 202 `{templateID, buildID}`
 *   (https://docs.e2b.dev/api-reference/templates/create-template-v3), `POST
 *   /v2/templates/{templateID}/builds/{buildID} {fromImage, steps[{type, args}]}`
 *   starts it (https://docs.e2b.dev/api-reference/templates/start-build-v2), and `GET
 *   /templates/{templateID}/builds/{buildID}/status` reports `building|waiting|ready|error|uploaded`
 *   (https://docs.e2b.dev/api-reference/templates/get-build-status). The template has no start
 *   command: a build-time start would not get the sandbox's bearer, so the provider starts the probe
 *   after create (packages/runtime/src/external/e2b.ts).
 *   Tags are listed with `GET /templates/{template}/tags` (404 = unknown template) and assigned with
 *   `POST /templates/tags {target, tags}` (https://docs.e2b.dev/template/tags,
 *   https://docs.e2b.dev/api-reference/tags/list-template-tags,
 *   https://docs.e2b.dev/api-reference/tags/assign-tags). `<template>:<build_id>` is a valid reference.
 * - Vercel Sandbox runs images from Vercel Container Registry, which is project-scoped, created by
 *   the first push, logged into with `docker login vcr.vercel.com --username <team id>` and the
 *   token on stdin, and answers `image_not_ready` until it prepared a linux/amd64 build
 *   (https://vercel.com/docs/container-registry, https://vercel.com/docs/sandbox/concepts/images).
 *   Projects: https://vercel.com/docs/rest-api/projects/find-a-project-by-id-or-name (GET /v9/projects),
 *   https://vercel.com/docs/rest-api/projects/create-a-new-project (POST /v11/projects); team slug:
 *   https://vercel.com/docs/rest-api/teams/get-a-team (GET /v2/teams/{teamId}).
 * - Cloudflare: `wrangler containers build -p -t <name:tag>` builds and pushes to
 *   `registry.cloudflare.com/<account>/<name>:<tag>`, and the digest reference comes from
 *   `docker image inspect` RepoDigests (https://developers.cloudflare.com/containers/platform-details/image-management/,
 *   https://developers.cloudflare.com/workers/wrangler/commands/containers/).
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WRANGLER } from './cloudflare-bridge.mjs';
import { redact } from './support.mjs';

export const E2B_TEMPLATE = 'aw-providers-probe';
export const VERCEL_PROJECT = 'aw-providers-live';
export const IMAGE_REPOSITORY = 'aw-providers-probe';

const E2B_API = 'https://api.e2b.app';
const VERCEL_API = 'https://api.vercel.com';
const VCR = 'vcr.vercel.com';
const CLOUDFLARE_REGISTRY = 'registry.cloudflare.com';
const TEMPLATE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const BUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const READY_TIMEOUT_MS = 300_000;
const READY_POLL_MS = 10_000;
const BUILD_TIMEOUT_MS = 900_000;

const here = path.dirname(fileURLToPath(import.meta.url));

/** The content that decides whether a cached artefact is current. */
export async function readProbeFiles() {
  return {
    dockerfile: await readFile(path.join(here, 'probe.Dockerfile'), 'utf8'),
    probe: await readFile(path.join(here, 'probe.mjs'), 'utf8'),
  };
}

export function probeKey({ dockerfile, probe }) {
  return createHash('sha256').update(dockerfile).update('\0').update(probe).digest('hex').slice(0, 16);
}

function run(command, args, { input, cwd, env, label = command } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: env ?? process.env,
    ...(input === undefined ? {} : { input }),
    timeout: 900_000,
  });
  if (result.error !== undefined) throw new Error(`${label} could not run: ${result.error.code ?? 'error'}`);
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${String(result.status)}: ${`${result.stdout}\n${result.stderr}`.slice(-2_000)}`);
  }
  return result.stdout;
}

export const defaultDeps = {
  fetch: globalThis.fetch,
  run,
  readFiles: readProbeFiles,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

const statusError = (operation, status) => new Error(`${operation} failed with status ${String(status)}`);

/** One REST call: `{ status, body }`, the body parsed when it is JSON. A transport error names the operation only. */
async function call(deps, operation, url, { method = 'GET', headers, body } = {}) {
  let response;
  try {
    response = await deps.fetch(url, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(`${operation} failed`);
  }
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

async function withContext(files, dockerfile, body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'aw-probe-'));
  try {
    await writeFile(path.join(dir, 'Dockerfile'), dockerfile);
    await writeFile(path.join(dir, 'probe.mjs'), files.probe);
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** E2B's Dockerfile reader gets the base image inline: the `ARG` default before `FROM` is resolved here. */
export function inlineBaseImage(dockerfile) {
  const match = /^ARG NODE_IMAGE=(\S+)$/mu.exec(dockerfile);
  if (match === null) throw new Error('probe.Dockerfile has no ARG NODE_IMAGE default');
  return dockerfile.replace(match[0], '').replace('${NODE_IMAGE}', match[1]);
}

/**
 * The v2 build of `probe.Dockerfile`: `FROM` is the image, `RUN`/`USER`/`WORKDIR` map one to one,
 * `COPY probe.mjs` becomes a `RUN` that writes it from base64 (no upload link), and `CMD` is dropped:
 * the E2B provider starts the probe after create through envd, with the bearer. Steps start as root, as a Dockerfile does.
 */
export function e2bBuild({ dockerfile, probe }) {
  const steps = [{ type: 'USER', args: ['root'] }];
  let fromImage;
  const lines = inlineBaseImage(dockerfile).replace(/\s*\\\n\s*/gu, ' ').split('\n');
  for (const line of lines.map((text) => text.trim()).filter((text) => text !== '' && !text.startsWith('#'))) {
    const [, keyword, rest] = /^(\S+)\s+(.*)$/u.exec(line) ?? [];
    if (keyword === 'FROM') fromImage = rest;
    else if (keyword === 'RUN' || keyword === 'USER' || keyword === 'WORKDIR') steps.push({ type: keyword, args: [rest] });
    else if (keyword === 'COPY' && rest.split(/\s+/u)[0] === 'probe.mjs') {
      const encoded = Buffer.from(probe).toString('base64');
      steps.push({ type: 'RUN', args: [`printf %s '${encoded}' | base64 -d > ${rest.split(/\s+/u)[1]}`] });
    } else if (keyword !== 'EXPOSE' && keyword !== 'CMD') throw new Error(`probe.Dockerfile line has no E2B step: ${String(keyword)}`);
  }
  if (fromImage === undefined) throw new Error('probe.Dockerfile has no FROM');
  return { fromImage, steps, force: false };
}

async function deriveE2bTemplate({ env, deps, files, tag }) {
  const headers = { 'x-api-key': env.E2B_API_KEY };
  const pin = (buildId) => {
    if (typeof buildId !== 'string' || !BUILD_ID.test(buildId)) throw new Error('e2b reported no build id');
    return `${E2B_TEMPLATE}:${buildId}`;
  };
  const lookup = async () => {
    const { status, body } = await call(deps, 'e2b tag lookup', `${E2B_API}/templates/${E2B_TEMPLATE}/tags`, { headers });
    if (status === 404) return undefined;
    if (status !== 200 || !Array.isArray(body)) throw statusError('e2b tag lookup', status);
    return body.find((entry) => entry?.tag === tag)?.buildID;
  };
  const cached = await lookup();
  if (cached !== undefined) return pin(cached);

  const build = e2bBuild(files);
  // An existing template of this team answers 202 with its own id and a new build.
  const created = await call(deps, 'e2b template create', `${E2B_API}/v3/templates`, {
    method: 'POST',
    headers,
    body: { name: E2B_TEMPLATE },
  });
  if (created.status === 409) {
    // Another run created it in between: its build is reused once it carries this tag.
    const raced = await lookup();
    if (raced !== undefined) return pin(raced);
  }
  if (created.status !== 202) throw statusError('e2b template create', created.status);
  const templateId = created.body?.templateID;
  const buildId = created.body?.buildID;
  if (typeof templateId !== 'string' || !TEMPLATE_ID.test(templateId)) throw new Error('e2b reported no template id');
  pin(buildId);
  const buildPath = `${E2B_API}/templates/${templateId}/builds/${buildId}`;

  const started = await call(deps, 'e2b template build', `${E2B_API}/v2/templates/${templateId}/builds/${buildId}`, {
    method: 'POST',
    headers,
    body: build,
  });
  if (started.status !== 202) throw statusError('e2b template build', started.status);
  const deadline = deps.now() + BUILD_TIMEOUT_MS;
  for (;;) {
    const { status, body } = await call(deps, 'e2b build status', `${buildPath}/status`, { headers });
    if (status !== 200) throw statusError('e2b build status', status);
    if (body?.status === 'ready') break;
    // The reason is provider text; only the operation and state are reported.
    if (body?.status === 'error') throw new Error('e2b template build failed');
    if (deps.now() >= deadline) throw new Error('e2b template build timed out');
    await deps.sleep(READY_POLL_MS);
  }

  const assigned = await call(deps, 'e2b tag assign', `${E2B_API}/templates/tags`, {
    method: 'POST',
    headers,
    body: { target: `${E2B_TEMPLATE}:default`, tags: [tag] },
  });
  if (assigned.status !== 201) throw statusError('e2b tag assign', assigned.status);
  // `default` moved to a concurrent build: do not cache another build under this probe's tag.
  if (assigned.body?.buildID !== buildId) throw new Error('e2b tag assign did not tag this build');
  return pin(buildId);
}

const vercelHeaders = (env) => ({ authorization: `Bearer ${env.VERCEL_TOKEN}` });
const teamQuery = (env) => `teamId=${encodeURIComponent(env.VERCEL_TEAM_ID)}`;

/** The project by its override, else by the fixed name, created when it does not exist. */
async function resolveVercelProject({ env, deps }) {
  const override = env.VERCEL_PROJECT_ID ?? '';
  const idOrName = override === '' ? VERCEL_PROJECT : override;
  const headers = vercelHeaders(env);
  let { status, body } = await call(
    deps,
    'vercel project lookup',
    `${VERCEL_API}/v9/projects/${encodeURIComponent(idOrName)}?${teamQuery(env)}`,
    { headers },
  );
  if (status === 404 && override === '') {
    ({ status, body } = await call(deps, 'vercel project create', `${VERCEL_API}/v11/projects?${teamQuery(env)}`, {
      method: 'POST',
      headers,
      body: { name: VERCEL_PROJECT },
    }));
  }
  if (status !== 200 || typeof body?.id !== 'string' || typeof body?.name !== 'string') {
    throw statusError('vercel project resolve', status);
  }
  return { id: body.id, name: body.name };
}

/** VCR prepares a fresh push asynchronously; a throwaway sandbox from the image is the only readiness signal. */
async function waitForVercelImage({ env, deps }, projectId, image) {
  const headers = vercelHeaders(env);
  const deadline = deps.now() + READY_TIMEOUT_MS;
  for (;;) {
    const name = `aw-ready-${randomBytes(6).toString('hex')}`;
    const created = await call(deps, 'vercel image readiness', `${VERCEL_API}/v4/sandboxes?${teamQuery(env)}`, {
      method: 'POST',
      headers,
      body: { name, projectId, image, persistent: false, timeout: 60_000 },
    });
    if (created.status >= 200 && created.status < 300) {
      const query = `${teamQuery(env)}&projectId=${encodeURIComponent(projectId)}`;
      const removed = await call(deps, 'vercel readiness sandbox delete', `${VERCEL_API}/v2/sandboxes/${name}?${query}`, {
        method: 'DELETE',
        headers,
      });
      if (removed.status >= 300 && removed.status !== 404) throw statusError('vercel readiness sandbox delete', removed.status);
      return;
    }
    if (!JSON.stringify(created.body ?? '').includes('image_not_ready') || deps.now() >= deadline) {
      throw statusError('vercel image readiness', created.status);
    }
    await deps.sleep(READY_POLL_MS);
  }
}

async function deriveVercelImage(ctx, project) {
  const { env, deps, files, tag } = ctx;
  const team = await call(deps, 'vercel team lookup', `${VERCEL_API}/v2/teams/${encodeURIComponent(env.VERCEL_TEAM_ID)}`, {
    headers: vercelHeaders(env),
  });
  if (team.status !== 200 || typeof team.body?.slug !== 'string') throw statusError('vercel team lookup', team.status);
  const repository = `${VCR}/${team.body.slug}/${project.name}/${IMAGE_REPOSITORY}`;
  const tagged = `${repository}:${tag}`;
  const dockerConfig = await mkdtemp(path.join(tmpdir(), 'aw-docker-'));
  // Only the credentials are isolated: buildx keeps the builder setup-buildx-action registered.
  const dockerEnv = {
    ...process.env,
    DOCKER_CONFIG: dockerConfig,
    BUILDX_CONFIG: process.env.BUILDX_CONFIG ?? path.join(process.env.DOCKER_CONFIG ?? path.join(homedir(), '.docker'), 'buildx'),
  };
  try {
    deps.run('docker', ['login', VCR, '--username', env.VERCEL_TEAM_ID, '--password-stdin'], {
      input: env.VERCEL_TOKEN,
      env: dockerEnv,
      label: 'docker login',
    });
    let manifest;
    try {
      manifest = JSON.parse(
        deps.run('docker', ['buildx', 'imagetools', 'inspect', tagged, '--format', '{{json .Manifest}}'], {
          env: dockerEnv,
          label: 'docker buildx imagetools inspect',
        }),
      );
    } catch {
      manifest = undefined;
    }
    let digest = manifest?.digest;
    if (typeof digest !== 'string') {
      digest = await withContext(files, files.dockerfile, async (dir) => {
        const metadata = path.join(dir, 'metadata.json');
        const output = `type=image,name=${tagged},push=true,oci-mediatypes=true,compression=zstd,compression-level=3,force-compression=true`;
        deps.run(
          'docker',
          ['buildx', 'build', '--platform', 'linux/amd64', '--provenance=false', '--sbom=false', '--metadata-file', metadata, '--output', output, dir],
          { cwd: dir, env: dockerEnv, label: 'docker buildx build' },
        );
        return JSON.parse(await readFile(metadata, 'utf8'))['containerimage.digest'];
      });
    }
    if (typeof digest !== 'string' || !DIGEST.test(digest)) throw new Error('vercel image has no readable digest');
    const image = `${team.body.slug}/${project.name}/${IMAGE_REPOSITORY}@${digest}`;
    await waitForVercelImage(ctx, project.id, image);
    return image;
  } finally {
    await rm(dockerConfig, { recursive: true, force: true });
  }
}

async function deriveCloudflareImage({ env, deps, files, tag }) {
  const name = `${IMAGE_REPOSITORY}:${tag}`;
  const registryName = `${CLOUDFLARE_REGISTRY}/${env.CLOUDFLARE_ACCOUNT_ID}/${name}`;
  return withContext(files, files.dockerfile, (dir) => {
    deps.run('npx', ['--yes', WRANGLER, 'containers', 'build', '-p', '-t', name, dir], {
      cwd: dir,
      label: 'wrangler containers build',
    });
    const reference = deps
      .run('docker', ['image', 'inspect', '--format', '{{join .RepoDigests "\\n"}}', registryName], { label: 'docker image inspect' })
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith(`${CLOUDFLARE_REGISTRY}/`) && DIGEST.test(line.split('@')[1] ?? ''));
    if (reference === undefined) throw new Error('wrangler pushed the image but docker reports no registry digest');
    return reference;
  });
}

/** Per lane: the override variable and how to derive it when it is unset. */
const ARTEFACTS = {
  e2b: (ctx) => [{ variable: 'E2B_PROBE_TEMPLATE', derive: () => deriveE2bTemplate(ctx) }],
  vercel: (ctx) => {
    let project;
    const resolved = () => (project ??= resolveVercelProject(ctx));
    return [
      { variable: 'VERCEL_PROJECT_ID', derive: async () => (await resolved()).id },
      { variable: 'VERCEL_PROBE_IMAGE', derive: async () => deriveVercelImage(ctx, await resolved()) },
    ];
  },
  cloudflare: (ctx) => [{ variable: 'CLOUDFLARE_PROBE_IMAGE', derive: () => deriveCloudflareImage(ctx) }],
};

/**
 * @param {string} lane  e2b | vercel | cloudflare
 * @param {Record<string, string | undefined>} env  the step environment (credentials and overrides)
 * @param {string[]} secrets  values to redact from a failure
 * @returns {Promise<{ env: Record<string, string> } | { failure: string }>}  the values to merge into `env`
 */
export async function prepare(lane, env, secrets, deps = defaultDeps) {
  const prepared = {};
  try {
    const files = await deps.readFiles();
    const ctx = { env: { ...env }, deps, files, tag: `p-${probeKey(files)}` };
    for (const { variable, derive } of ARTEFACTS[lane](ctx)) {
      const override = env[variable] ?? '';
      prepared[variable] = override === '' ? await derive() : override;
      ctx.env[variable] = prepared[variable];
    }
    return { env: prepared };
  } catch (error) {
    return { failure: redact(error instanceof Error ? error.message : String(error), secrets) };
  }
}
