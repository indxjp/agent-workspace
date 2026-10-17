/**
 * Builds the production E2B runtime template from the published runtime image and prints its pin,
 * `<template>:<build_id>` (ADR-0120 LC2), which is what `E2B_RUNTIME_TEMPLATE` must hold.
 *
 * Over REST with `fetch` and `X-API-Key`, as `packages/runtime/src/external/e2b.ts` and
 * `infra/tests/providers/prepare.mjs` do (`e2b` is on `denyByName`). Vendor facts, checked 2026-10-08:
 * `POST /v3/templates {name}` answers 202 `{templateID, buildID}`, `POST
 * /v2/templates/{templateID}/builds/{buildID} {fromImage, force}` starts the build, and `GET
 * /templates/{templateID}/builds/{buildID}/status` reports `building|waiting|ready|error|uploaded`
 * (https://docs.e2b.dev/api-reference/templates/create-template-v3,
 * https://docs.e2b.dev/api-reference/templates/start-build-v2,
 * https://docs.e2b.dev/api-reference/templates/get-build-status).
 *
 * The template has no start command: the E2B provider starts `/srv/apps/runner/dist/index.js` after
 * create, through envd, with the sandbox's bearer in its environment. The tool-host template
 * (`TEMPLATE_KIND=tool-host`) is started the same way, on `/app/packages/tool-host/dist/main.js`. No
 * tool-host image is published before a release, so it is built from the repository's own
 * `tool-host.Dockerfile` context (`tool-host-template.mjs`): `GET /templates/{templateID}/files/{hash}`
 * answers `{present, url, headers}`, the context `tar.gz` is PUT to that presigned URL with exactly
 * those headers plus `Content-Length` (as `packages/js-sdk/src/template/buildApi.ts` does, checked
 * 2026-10-10; no `Content-Type` of ours, no key), and the build starts with `steps` of `COPY`/`RUN` (the E2B SDK's wire format). Naming
 * `RUNTIME_IMAGE` still builds from that registry image instead.
 *
 * Build logs (checked 2026-10-10, `packages/js-sdk/src/template/buildApi.ts` and the same status
 * page): the status answer carries `logEntries` (`{timestamp, message, level, step?}`, from
 * `?logsOffset=<entries already read>`; the deprecated `logs` is ignored) and, on `error`, a `reason`
 * (`{message, step?, logEntries}`). The SDK keeps polling an errored build until `logEntries` is
 * empty, as this does (paced and capped). That text is the provider's, so it is only ever shown through
 * `sanitizeLogLine`.
 *
 * Resources (checked 2026-10-10, https://docs.e2b.dev/api-reference/templates/create-template-v3 and
 * `packages/js-sdk/src/template/index.ts`, whose build sends `{name, tags, cpuCount, memoryMB,
 * minFreeDiskMb}` to this same create call): `cpuCount` and `memoryMB` (MiB) are the template's size,
 * which every sandbox started from it uses. That the build VM uses it too is inferred from the SDK, not
 * documented, and stays unverified until a live build succeeds. E2B documents no maximum, and this
 * could not confirm its default size, so the build asks for one explicitly: the tool-host install was
 * OOM-killed at the default. `E2B_CPU_COUNT` / `E2B_MEMORY_MB` override it within `builderResources`' bounds.
 *
 * The key reaches this script through the environment only; request failures name the operation and
 * the status, never a provider body.
 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { IMAGE_NAMESPACE, readReleaseImages, releasePlan } from '../release/images.mjs';
import { DOCKERFILE, toolHostBuild } from './tool-host-template.mjs';

export const TEMPLATE_NAME = 'aw-runtime';
/** The tool sandbox's template (ADR-0120 LC5): the tool-host image, whose pin `E2B_TOOL_HOST_TEMPLATE` holds. */
export const TOOL_HOST_TEMPLATE_NAME = 'aw-tool-host';
const ENGINE = 'claude-agent-sdk';
const E2B_API = 'https://api.e2b.app';
const BUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TEMPLATE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const FILES_HASH = /^[0-9a-f]{64}$/u;
// `*`, not `+`, on the path: a Docker Hub official image such as `node:24` has no `/`.
const IMAGE_REFERENCE =
  /^[a-z0-9][a-z0-9._-]*(?::[0-9]+)?(?:\/[a-z0-9][a-z0-9._-]*)*(?::[A-Za-z0-9._-]+)?(?:@sha256:[0-9a-f]{64})?$/u;
const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,32}$/u;
const LOG_LINE_MAX = 300;
const SUMMARY_TAIL_LINES = 100;
const SUMMARY_TAIL_BYTES = 16 * 1024;
const READY_POLL_MS = 10_000;
const BUILD_TIMEOUT_MS = 900_000;
const ERROR_DRAIN_POLL_MS = 1_000;
const ERROR_DRAIN_MAX = 10;
export const DEFAULT_CPU_COUNT = 2;
export const DEFAULT_MEMORY_MB = 4096;

/** The template size from `E2B_CPU_COUNT` / `E2B_MEMORY_MB` (empty: the default); the message never echoes the value. */
export function builderResources(env) {
  const read = (name, fallback, min, max, even) => {
    const raw = env[name] ?? '';
    if (raw === '') return fallback;
    const value = /^\d{1,5}$/u.test(raw) ? Number(raw) : Number.NaN;
    if (!(value >= min && value <= max) || (even && value % 2 !== 0)) {
      throw new Error(`${name} is not ${even ? 'an even' : 'a'} whole number from ${min} to ${max}`);
    }
    return value;
  };
  return {
    cpuCount: read('E2B_CPU_COUNT', DEFAULT_CPU_COUNT, 1, 8, false),
    memoryMB: read('E2B_MEMORY_MB', DEFAULT_MEMORY_MB, 512, 8192, true),
  };
}

export const describeResources = ({ cpuCount, memoryMB }) => `${cpuCount} vCPU / ${memoryMB} MiB`;

/** The released runtime image of the engine the journey deploys, e.g. `ghcr.io/…/runtime-claude-agent-sdk:0.6.0`. */
export function defaultRuntimeImage(root) {
  const { registry, version } = readReleaseImages(root);
  const image = releasePlan(root).find((entry) => entry.engine === ENGINE);
  if (image === undefined) throw new Error(`the release plan has no ${ENGINE} runtime image`);
  return `${registry}/${IMAGE_NAMESPACE}/${image.name}:${version}`;
}

/** The pin the production E2B manager accepts; a value that is not a build id is refused. */
export function templatePin(name, buildId) {
  if (typeof buildId !== 'string' || !BUILD_ID.test(buildId)) {
    throw new Error('e2b reported no build id');
  }
  return `${name}:${buildId}`;
}

/**
 * One line of provider text that is safe to print: no ANSI or other control characters (so no
 * workflow command can be injected), no key, no URL (a presigned one carries its signature), capped.
 */
export function sanitizeLogLine(text, apiKey) {
  let line = String(text)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
    .replace(/\p{Cc}/gu, ' ');
  if (apiKey !== '') line = line.split(apiKey).join('***');
  line = line.replace(/https?:\/\/\S*/giu, '<url>').trim();
  // The runner trims leading whitespace before it looks for `::`, so the guard is not whitespace.
  if (line.startsWith('::')) line = `> ${line}`;
  return line.length > LOG_LINE_MAX ? `${line.slice(0, LOG_LINE_MAX - 1)}…` : line;
}

const token = (value) => (typeof value === 'string' && SAFE_TOKEN.test(value) ? value : undefined);

/** `[level] step: message` for a `BuildLogEntry`, or undefined for anything that is not one. */
export function formatLogEntry(entry, apiKey) {
  if (typeof entry !== 'object' || entry === null || typeof entry.message !== 'string') {
    return undefined;
  }
  const level = token(entry.level);
  const step = token(entry.step);
  const prefix = `${level === undefined ? '' : `[${level}] `}${step === undefined ? '' : `${step}: `}`;
  return sanitizeLogLine(`${prefix}${entry.message}`, apiKey);
}

/** The failure section of the job summary: the error and the log tail, fenced so the tail cannot escape. */
export function failureSummary(kind, message, lines, resources) {
  const tail = lines.join('\n').replaceAll('~', '-').slice(-SUMMARY_TAIL_BYTES);
  const size = resources === undefined ? '' : `Builder resources: ${describeResources(resources)}\n\n`;
  return `## E2B ${kind} template failed\n\n${message}\n\n${size}Build log tail:\n\n~~~~\n${tail}\n~~~~\n`;
}

const statusError = (operation, status) =>
  new Error(`${operation} failed with status ${String(status)}`);

async function call(fetchImpl, operation, url, { method = 'GET', apiKey, body }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        'x-api-key': apiKey,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(`${operation} failed`);
  }
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

/**
 * Uploads a `COPY` step's context to the presigned URL E2B hands out for its hash. That URL is not
 * E2B's API: the key is not sent to it.
 */
async function uploadContext(fetchImpl, apiKey, templateId, { hash, archive }) {
  if (!FILES_HASH.test(hash)) throw new Error('e2b context hash is not a sha256');
  const link = await call(
    fetchImpl,
    'e2b context link',
    `${E2B_API}/templates/${templateId}/files/${hash}`,
    { apiKey },
  );
  if (link.status !== 200 && link.status !== 201)
    throw statusError('e2b context link', link.status);
  if (link.body?.present === true) return;
  const url = link.body?.url;
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new Error('e2b reported no upload url');
  }
  // Exactly what E2B signed, as the SDK's `putFileStream` sends it: its headers (any content type
  // stays as given, never ours) and an explicit length for the fixed-size body.
  const headers = new Headers();
  for (const [name, value] of Object.entries(link.body?.headers ?? {})) {
    if (typeof value === 'string') {
      // `Headers` echoes an invalid value in its error; the value may be a signed token.
      try {
        headers.set(name, value);
      } catch {
        throw new Error('e2b reported an invalid upload header');
      }
    }
  }
  headers.set('content-length', String(archive.byteLength));
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'PUT',
      headers,
      body: archive,
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new Error('e2b context upload failed');
  }
  if (!response.ok) {
    // Storage answers an XML `<Error>`; only its letters-only `<Code>` is reported, never the
    // message, the string to sign, the URL or anything else the body carries.
    const text = await response.text().catch(() => '');
    const code = /<Code>([A-Za-z]{1,64})<\/Code>/u.exec(text.slice(0, 4096))?.[1];
    const error = statusError('e2b context upload', response.status);
    throw code === undefined ? error : new Error(`${error.message} (${code})`);
  }
}

/**
 * @param {{ apiKey: string, image: string, name?: string, steps?: readonly object[],
 *   uploads?: readonly { hash: string, archive: Uint8Array }[], cpuCount?: number, memoryMB?: number,
 *   fetch?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number,
 *   onLog?: (line: string) => void }} options
 * @returns {Promise<string>} the `<template>:<build_id>` pin
 */
export async function buildTemplate({
  apiKey,
  image,
  name = TEMPLATE_NAME,
  steps = [],
  uploads = [],
  cpuCount,
  memoryMB,
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  onLog = (line) => process.stderr.write(`${line}\n`),
}) {
  if (apiKey === '') throw new Error('E2B_API_KEY is empty');
  if (!IMAGE_REFERENCE.test(image)) throw new Error('RUNTIME_IMAGE is not an image reference');
  // An existing template of this team answers 202 with its own id and a new build.
  const created = await call(fetchImpl, 'e2b template create', `${E2B_API}/v3/templates`, {
    method: 'POST',
    apiKey,
    body: {
      name,
      ...(cpuCount === undefined ? {} : { cpuCount }),
      ...(memoryMB === undefined ? {} : { memoryMB }),
    },
  });
  if (created.status !== 202) throw statusError('e2b template create', created.status);
  const templateId = created.body?.templateID;
  const buildId = created.body?.buildID;
  if (typeof templateId !== 'string' || !TEMPLATE_ID.test(templateId)) {
    throw new Error('e2b reported no template id');
  }
  const pin = templatePin(name, buildId);

  for (const upload of uploads) await uploadContext(fetchImpl, apiKey, templateId, upload);

  const buildPath = `${E2B_API}/templates/${templateId}/builds/${buildId}`;
  const started = await call(
    fetchImpl,
    'e2b template build',
    `${E2B_API}/v2/templates/${templateId}/builds/${buildId}`,
    {
      method: 'POST',
      apiKey,
      body: { fromImage: image, force: true, ...(steps.length === 0 ? {} : { steps }) },
    },
  );
  if (started.status !== 202) throw statusError('e2b template build', started.status);

  const deadline = now() + BUILD_TIMEOUT_MS;
  const show = (entry) => {
    const line = formatLogEntry(entry, apiKey);
    if (line !== undefined) onLog(line);
  };
  let offset = 0;
  let drains = 0;
  for (;;) {
    const { status, body } = await call(
      fetchImpl,
      'e2b build status',
      `${buildPath}/status?logsOffset=${offset}`,
      { apiKey },
    );
    if (status !== 200) throw statusError('e2b build status', status);
    const entries = Array.isArray(body?.logEntries) ? body.logEntries : [];
    for (const entry of entries) show(entry);
    offset += entries.length;
    if (body?.status === 'ready') return pin;
    if (body?.status === 'error') {
      // Like the SDK: read on until E2B has no more entries, then report the reason. Paced and
      // capped, in case E2B ignores `logsOffset` and repeats the same entries.
      if (entries.length > 0 && drains < ERROR_DRAIN_MAX && now() < deadline) {
        drains += 1;
        await sleep(ERROR_DRAIN_POLL_MS);
        continue;
      }
      const reason = body.reason;
      if (Array.isArray(reason?.logEntries)) for (const entry of reason.logEntries) show(entry);
      const step = token(reason?.step);
      const text =
        typeof reason?.message === 'string' ? sanitizeLogLine(reason.message, apiKey) : '';
      throw new Error(
        `e2b template build failed${step === undefined ? '' : ` at step ${step}`}${text === '' ? '' : `: ${text}`}`,
      );
    }
    if (now() >= deadline) throw new Error('e2b template build timed out');
    await sleep(READY_POLL_MS);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const kind = process.env['TEMPLATE_KIND'] || 'runtime';
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  const apiKey = process.env['E2B_API_KEY'] ?? '';
  const tail = [];
  let resources;
  try {
    if (kind !== 'runtime' && kind !== 'tool-host') throw new Error('TEMPLATE_KIND is not known');
    resources = builderResources(process.env);
    const toolHost = kind === 'tool-host';
    const name = toolHost ? TOOL_HOST_TEMPLATE_NAME : TEMPLATE_NAME;
    const variable = toolHost ? 'E2B_TOOL_HOST_TEMPLATE' : 'E2B_RUNTIME_TEMPLATE';
    // The tool host is not a published image yet: unless one is named, it is built from the
    // repository's own `tool-host.Dockerfile` context (issue #827).
    const named = process.env['RUNTIME_IMAGE'];
    const fromSource = toolHost && !named;
    const { image, steps, uploads } = fromSource
      ? toolHostBuild()
      : { image: named || defaultRuntimeImage(), steps: [], uploads: [] };
    const source = fromSource ? `${DOCKERFILE} build context on ${image}` : image;
    process.stderr.write(`building ${name} from ${source} with ${describeResources(resources)}\n`);
    const pin = await buildTemplate({
      apiKey,
      image,
      name,
      steps,
      uploads,
      ...resources,
      onLog: (line) => {
        process.stderr.write(`${line}\n`);
        tail.push(line);
        if (tail.length > SUMMARY_TAIL_LINES) tail.shift();
      },
    });
    process.stdout.write(`${pin}\n`);
    if (summary) {
      appendFileSync(
        summary,
        `## E2B ${kind} template\n\nBuilt from: \`${source}\`\n\nBuilder resources: ${describeResources(resources)}\n\nTemplate pin \`<template>:<build_id>\`: \`${pin}\`\n\nSet the repository variable \`${variable}\` to:\n\n\`\`\`\n${pin}\n\`\`\`\n`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (summary) appendFileSync(summary, failureSummary(kind, message, tail, resources));
    process.exitCode = 1;
  }
}
