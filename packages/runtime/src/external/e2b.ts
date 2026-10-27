/**
 * The E2B provider of the `external` driver (ADR-0120 LC1-LC4, LC6), over REST with `fetch`: the
 * `e2b` package is on `denyByName`, and no E2B type leaves this file.
 *
 * Vendor facts below carry their source and the date they were last checked.
 */
import { EngineImageConfigurationError } from '../engine-images.js';
import type { EngineImageMap } from '../engine-images.js';
import type { RuntimeCapabilities } from '../driver.js';
import { RUN_FILES_MAX_BYTES } from '../transfer.js';
import type {
  ExternalFileTarget,
  ExternalProvider,
  ExternalSandbox,
  ExternalSandboxRequest,
  FoundExternalSandbox,
} from './driver.js';

export type E2bPlanTier = 'hobby' | 'pro';

/**
 * ADR-0120's `external` + `e2b` table. `maxSessionSeconds` is 1 h on Hobby and 24 h on Pro
 * (https://docs.e2b.dev/sandbox, checked 2026-10-07). `networkPolicies` omits `allowlist` (LC4):
 * E2B lets an allowed rule beat a denied one (https://docs.e2b.dev/sandbox/internet-access,
 * re-checked 2026-10-08), so the always-denied list is unproven against an allowed domain until
 * E7's live lane shows otherwise. `none` denies IPv4 egress (`0.0.0.0/0`) and the always-denied
 * ranges; it does not send `::/0`, which the E2B API rejects, and no E2B source says IPv6 is
 * blocked or unrouted in a sandbox, so IPv6 egress denial under `none` is NOT claimed (see
 * `networkBody`). `RuntimeCapabilities` has no IPv6 field.
 */
export function e2bRuntimeCapabilities(tier: E2bPlanTier = 'hobby'): RuntimeCapabilities {
  return {
    isolation: 'microvm',
    customImage: true,
    persistentFilesystem: false,
    sessionAffinity: true,
    maxSessionSeconds: tier === 'pro' ? 86_400 : 3_600,
    networkPolicies: ['none', 'open'],
    execCommands: true,
    gpu: false,
    managedByProvider: true,
    typicalStartMs: null,
    fileTransfer: 'push-archive',
  };
}

/** ADR-0120 LC4 "always denied": metadata and link-local, RFC 1918, CGNAT, unique-local, loopback. */
export const ALWAYS_DENIED_RANGES = [
  '169.254.0.0/16',
  'fe80::/10',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  'fc00::/7',
  '127.0.0.0/8',
  '::1/128',
] as const;

const RESTRICTED_REFUSAL =
  'external runtime: provider e2b refuses the restricted network policy until the E7 live lane proves the always-denied ranges hold; E2B lets an allowed domain beat a denied range (ADR-0120 LC4).';

const BEARER_ENV = 'RUNTIME_SANDBOX_BEARER';
const RUNNER_PORT = 8080;
/** The metadata key a stateless driver (ADR-0126) records its lookup key under. */
const LOOKUP_METADATA_KEY = 'awKey';
const REQUEST_TIMEOUT_MS = 30_000;
// ponytail: one page; a session never holds this many sandboxes, follow `x-next-token` if one does.
const LIST_LIMIT = 100;
const SANDBOX_ID = /^[A-Za-z0-9_-]{1,128}$/u;
/** The domain a nullable create/connect `domain` falls back to, as the official SDK does. */
const DEFAULT_DOMAIN = 'e2b.app';
const ENVD_PORT = 49983;
/** `runtime.Dockerfile`'s `CMD`: E2B starts the runner through envd, not through a template start command. */
const RUNNER_ENTRY = '/srv/apps/runner/dist/index.js';
const RUNNER_CWD = '/workspace';
/** The image's own user (`runtime.Dockerfile`, `USER node`). */
const RUNNER_USER = 'node';
/** `tool-host.Dockerfile`: the tool host's entry, its working directory and user (also `node`). */
const TOOL_HOST_ENTRY = '/app/packages/tool-host/dist/main.js';
const TOOL_HOST_CWD = '/app';
/** The image's root file system is writable in a microVM; the host's workspace is a private directory. */
const TOOL_HOST_DIR = '/tmp/tool-host';
const MAX_REASON_LENGTH = 160;
const MAX_START_FRAMES = 8;
const MAX_FRAME_BYTES = 1_048_576;
const SANDBOX_DOMAIN = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u;
/** An E2B build id is a UUID (https://docs.e2b.dev/template/tags, checked 2026-10-07). */
const BUILD_ID_PIN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * LC2: E2B documents no OCI digest, so production pins a template by `<template>:<build_id>`
 * where a digest pin is required elsewhere. Names keys only, never values.
 */
export function assertBuildIdPinnedTemplates(images: EngineImageMap): void {
  const unpinned = [...images]
    .filter(([, image]) => !BUILD_ID_PIN.test(image))
    .map(([engineId]) => engineId)
    .sort();
  if (unpinned.length > 0) {
    throw new EngineImageConfigurationError(
      `e2b runtime: production templates must be pinned as <template>:<build_id>; ${unpinned.map((key) => JSON.stringify(key)).join(', ')} are not.`,
      unpinned,
    );
  }
}

/**
 * LC4 mapping, per https://docs.e2b.dev/sandbox/internet-access (checked 2026-10-08): domain rules
 * need every other address denied, and allow beats deny. `none` is the gateway host only, with every
 * IPv4 address and the always-denied ranges denied; `open` is everything except the always-denied
 * ranges.
 *
 * `::/0` is not sent: the E2B API answers `400 invalid denied CIDR ::/0` (providers-live run
 * 37752204337, 2026-10-08) and only `0.0.0.0/0` is accepted as "all traffic". The docs describe
 * `allow_internet_access: false` as `denyOut: ['0.0.0.0/0']` and say nothing about IPv6
 * (https://docs.e2b.dev/sandbox/internet-access, checked 2026-10-08), so IPv6 egress denial under
 * `none` relies on E2B's own default and is not claimed. The IPv6 entries of `ALWAYS_DENIED_RANGES`
 * are accepted (the same run created an `open` sandbox with them).
 */
function networkBody(request: ExternalSandboxRequest): Record<string, unknown> {
  const rules =
    request.networkPolicy === 'none'
      ? {
          // A tool host's code has no business at the gateway (ADR-0118 TS5): no egress at all.
          ...(request.workload === 'tool-host' ? {} : { allowOut: [request.gatewayHost] }),
          denyOut: ['0.0.0.0/0', ...ALWAYS_DENIED_RANGES],
        }
      : { denyOut: [...ALWAYS_DENIED_RANGES] };
  // Only the traffic-token holder (the manager) may reach the port (LC3,
  // https://docs.e2b.dev/network/restrict-public-access, checked 2026-10-07).
  return {
    allow_internet_access: request.networkPolicy === 'open',
    network: { allowPublicTraffic: false, ...rules },
  };
}

/**
 * Messages carry the operation, the status and, when the provider sent one, a short sanitized reason
 * (see `reasonOf`). A transport error or an unparsed body is never put in an error: it may echo the
 * key (LC6).
 */
function failure(operation: string, status?: number, reason?: string): Error {
  return new Error(
    `external runtime: provider e2b ${operation} failed${status === undefined ? '' : ` with status ${String(status)}`}${reason === undefined ? '' : `: ${reason}`}.`,
  );
}

function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

/**
 * The `message` of an E2B (`{code, message}`, https://github.com/e2b-dev/infra/blob/main/spec/openapi.yml,
 * checked 2026-10-08) or Connect (`{code, message}`, https://connectrpc.com/docs/protocol/#error-end-stream)
 * error body, with every secret of the call and any `e2b_` key masked, control characters removed and
 * the length capped. Anything that is not such a JSON body adds no reason.
 */
function sanitizedReason(body: unknown, secrets: readonly string[]): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const message = (body as Record<string, unknown>)['message'];
  if (typeof message !== 'string') return undefined;
  let text = message;
  for (const secret of secrets) if (secret.length > 0) text = text.split(secret).join('[redacted]');
  text = text.replace(/e2b_[A-Za-z0-9_]+/gu, '[redacted]');
  text = Array.from(text, (char) => (isControl(char) ? ' ' : char))
    .join('')
    .trim();
  if (text.length > MAX_REASON_LENGTH) text = `${text.slice(0, MAX_REASON_LENGTH)}...`;
  return text.length === 0 ? undefined : text;
}

/** Reads and discards a non-OK response, returning its sanitized reason. */
async function reasonOf(
  response: Response,
  secrets: readonly string[],
): Promise<string | undefined> {
  try {
    return sanitizedReason(JSON.parse(await response.text()) as unknown, secrets);
  } catch {
    return undefined;
  }
}

type Reachable = Readonly<{
  sandbox: ExternalSandbox;
  domain: string;
  trafficToken: string;
}>;

export function createE2bProvider(
  options: Readonly<{
    tier?: E2bPlanTier;
    apiBase?: string;
    fetch?: typeof globalThis.fetch;
  }> = {},
): ExternalProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  const apiBase = (options.apiBase ?? 'https://api.e2b.app').replace(/\/+$/u, '');

  async function call(
    operation: string,
    path: string,
    apiKey: string,
    init: RequestInit,
  ): Promise<Response> {
    try {
      return await doFetch(`${apiBase}${path}`, {
        ...init,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw failure(operation);
    }
  }

  async function destroy(sandboxId: string, apiKey: string): Promise<void> {
    // A kill is DELETE /sandboxes/{id}; the issue's plan names it, the API reference page for it was
    // not reachable on 2026-10-08, so the live lane (E7) is where it is proven.
    const response = await call('destroy', `/sandboxes/${encodeURIComponent(sandboxId)}`, apiKey, {
      method: 'DELETE',
    });
    if (response.ok || response.status === 404) {
      await response.body?.cancel();
      return;
    }
    throw await rejected('destroy', response, [apiKey]);
  }

  async function rejected(
    operation: string,
    response: Response,
    secrets: readonly string[],
  ): Promise<Error> {
    const reason = await reasonOf(response, secrets);
    // A create answered 429 is the account's concurrent-sandbox cap: say so, so an operator reads a
    // full account and not a bad request. It is never retried here; waiting cannot free a leak.
    return failure(
      operation,
      response.status,
      operation === 'create' && response.status === 429
        ? `the provider's concurrency limit was reached${reason === undefined ? '' : ` (${reason.replace(/\.$/u, '')})`}`
        : reason,
    );
  }

  async function json(operation: string, response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw failure(operation);
    }
  }

  function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  /** A sandbox response read as the address and access headers the runner is reached with. */
  async function reachable(operation: string, body: unknown, apiKey: string): Promise<Reachable> {
    const record = asRecord(body);
    const sandboxId = record['sandboxID'];
    // `domain` is nullable and E2B cloud returns null; the official SDK then uses its default
    // domain (https://github.com/e2b-dev/E2B/blob/main/packages/js-sdk/src/connectionConfig.ts,
    // checked 2026-10-08).
    const domain = record['domain'] ?? DEFAULT_DOMAIN;
    const trafficToken = record['trafficAccessToken'];
    if (typeof sandboxId !== 'string' || !SANDBOX_ID.test(sandboxId)) throw failure(operation);
    if (
      typeof domain !== 'string' ||
      !SANDBOX_DOMAIN.test(domain) ||
      typeof trafficToken !== 'string' ||
      trafficToken.length === 0
    ) {
      // A sandbox just created that cannot be reached safely is not left running.
      if (operation === 'create') await destroy(sandboxId, apiKey).catch(() => undefined);
      throw failure(operation);
    }
    return {
      sandbox: {
        sandboxId,
        origin: `https://${String(RUNNER_PORT)}-${sandboxId}.${domain}`,
        accessHeaders: { 'e2b-traffic-access-token': trafficToken },
      },
      domain,
      trafficToken,
    };
  }

  /**
   * GET /v2/sandboxes?metadata=<k>=<v>&...&state=running lists a team's running sandboxes with all
   * of that metadata (`sandboxID`, `endAt`; https://github.com/e2b-dev/infra/blob/main/spec/openapi.yml,
   * checked 2026-10-08).
   */
  async function listed(
    operation: string,
    tags: Readonly<Record<string, string>>,
    limit: number,
    apiKey: string,
  ): Promise<readonly unknown[]> {
    const query = new URLSearchParams({
      metadata: new URLSearchParams(tags).toString(),
      state: 'running',
      limit: String(limit),
    });
    const response = await call(operation, `/v2/sandboxes?${query.toString()}`, apiKey, {
      method: 'GET',
    });
    if (!response.ok) throw await rejected(operation, response, [apiKey]);
    const items = await json(operation, response);
    return Array.isArray(items) ? (items as unknown[]) : [];
  }

  /** POST /sandboxes/{id}/connect: the sandbox's addresses and tokens, for `seconds` more. */
  async function connect(
    operation: string,
    sandboxId: string,
    seconds: number,
    apiKey: string,
  ): Promise<unknown> {
    const connected = await call(
      operation,
      `/sandboxes/${encodeURIComponent(sandboxId)}/connect`,
      apiKey,
      { method: 'POST', body: JSON.stringify({ timeout: seconds }) },
    );
    if (!connected.ok) throw await rejected(operation, connected, [apiKey]);
    return await json(operation, connected);
  }

  /**
   * Starts the runner through envd's process API: `POST /process.Process/Start` is a Connect
   * server-streaming call, so the body is one envelope frame (flag byte 0, 4-byte big-endian length,
   * JSON) and the answer is a frame stream whose first event is `start` with the pid
   * (https://github.com/e2b-dev/infra/blob/main/packages/envd/spec/process/process.proto and
   * https://connectrpc.com/docs/protocol/#streaming-request, checked 2026-10-08). `/v2/sandboxes`
   * creates secure sandboxes, so envd needs the `envdAccessToken` as `X-Access-Token`; the user is
   * a Basic `<user>:` as the SDK sends it
   * (https://github.com/e2b-dev/E2B/blob/main/packages/js-sdk/src/envd/rpc.ts, checked 2026-10-08).
   * A background command keeps running after the client disconnects
   * (https://docs.e2b.dev/commands/background, checked 2026-10-08), so the stream is cancelled
   * once the process started. The provider key is never sent here and the bearer is only in the
   * process's environment.
   */
  async function startRunner(
    reached: Reachable,
    envdAccessToken: string,
    bearer: string,
    apiKey: string,
    workload: ExternalSandboxRequest['workload'],
  ): Promise<void> {
    const operation = workload === 'tool-host' ? 'start the tool host' : 'start the runner';
    const secrets = [apiKey, envdAccessToken, reached.trafficToken, bearer];
    const environment = { NODE_ENV: 'production', HOST: '0.0.0.0', PORT: String(RUNNER_PORT) };
    // The tool host admits a call by the per-run token in its workspace, never by the sandbox bearer.
    const command =
      workload === 'tool-host'
        ? {
            cmd: 'node',
            args: [TOOL_HOST_ENTRY],
            cwd: TOOL_HOST_CWD,
            envs: { ...environment, TOOL_HOST_DIR },
          }
        : {
            cmd: 'node',
            args: [RUNNER_ENTRY],
            cwd: RUNNER_CWD,
            envs: { ...environment, [BEARER_ENV]: bearer },
          };
    const payload = new TextEncoder().encode(JSON.stringify({ process: command, stdin: false }));
    const frame = new Uint8Array(5 + payload.length);
    new DataView(frame.buffer).setUint32(1, payload.length);
    frame.set(payload, 5);
    let response: Response;
    try {
      response = await doFetch(
        `https://${String(ENVD_PORT)}-${reached.sandbox.sandboxId}.${reached.domain}/process.Process/Start`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/connect+json',
            'connect-protocol-version': '1',
            'x-access-token': envdAccessToken,
            authorization: `Basic ${Buffer.from(`${RUNNER_USER}:`).toString('base64')}`,
            ...reached.sandbox.accessHeaders,
          },
          body: frame,
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch {
      throw failure(operation);
    }
    if (!response.ok) throw await rejected(operation, response, secrets);
    const reader = response.body?.getReader();
    if (reader === undefined) throw failure(operation);
    try {
      let buffered = new Uint8Array(0);
      const frameLength = (): number =>
        new DataView(buffered.buffer, buffered.byteOffset).getUint32(1);
      for (let frames = 0; frames < MAX_START_FRAMES; frames += 1) {
        while (buffered.length < 5 || buffered.length < 5 + frameLength()) {
          const chunk = await reader.read().catch(() => undefined);
          if (chunk === undefined || chunk.done) throw failure(operation);
          const bytes: unknown = chunk.value;
          if (!(bytes instanceof Uint8Array)) throw failure(operation);
          const joined = new Uint8Array(buffered.length + bytes.length);
          joined.set(buffered);
          joined.set(bytes, buffered.length);
          buffered = joined;
          if (buffered.length >= 5 && frameLength() > MAX_FRAME_BYTES) throw failure(operation);
        }
        const flags = buffered[0] ?? 0;
        let message: Record<string, unknown>;
        try {
          message = asRecord(
            JSON.parse(new TextDecoder().decode(buffered.subarray(5, 5 + frameLength()))),
          );
        } catch {
          throw failure(operation);
        }
        buffered = buffered.slice(5 + frameLength());
        // Bit 1 marks the end-of-stream frame; its `error` is `{code, message}`.
        if ((flags & 2) !== 0) {
          throw failure(operation, undefined, sanitizedReason(message['error'], secrets));
        }
        const event = asRecord(message['event']);
        if (typeof event['start'] === 'object' && event['start'] !== null) return;
        if ('end' in event) throw failure(operation);
      }
      throw failure(operation);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  return {
    id: 'e2b',
    capabilities: e2bRuntimeCapabilities(options.tier),
    restrictedRefusal: RESTRICTED_REFUSAL,

    async create(request, apiKey): Promise<ExternalSandbox> {
      // POST /v2/sandboxes with X-API-Key (https://docs.e2b.dev/api-reference/sandboxes/create-sandbox-v2,
      // checked 2026-10-08). The key is the header only, and the bearer is not sent here: it goes
      // only to the runner's environment (`startRunner`), so the sandbox record never holds it.
      const response = await call('create', '/v2/sandboxes', apiKey, {
        method: 'POST',
        body: JSON.stringify({
          templateID: request.image,
          timeout: request.timeoutSeconds,
          metadata: {
            ...request.tags,
            sessionKey: request.sessionKey,
            ...(request.lookupKey === undefined
              ? {}
              : { [LOOKUP_METADATA_KEY]: request.lookupKey }),
          },
          ...networkBody(request),
        }),
      });
      if (!response.ok) throw await rejected('create', response, [apiKey, request.bearer]);
      const body = await json('create', response);
      const reached = await reachable('create', body, apiKey);
      const envdAccessToken = asRecord(body)['envdAccessToken'];
      try {
        // `/v2` always creates secure sandboxes, so a response without the token is unusable.
        if (typeof envdAccessToken !== 'string' || envdAccessToken.length === 0) {
          throw failure('create');
        }
        await startRunner(reached, envdAccessToken, request.bearer, apiKey, request.workload);
      } catch (error) {
        await destroy(reached.sandbox.sandboxId, apiKey).catch(() => undefined);
        throw error;
      }
      return reached.sandbox;
    },

    async find(lookupKey, apiKey, renewSeconds): Promise<FoundExternalSandbox | undefined> {
      // The traffic token is returned by create and by POST /sandboxes/{sandboxID}/connect, not by
      // the list, so connect fetches it; its `timeout` sets the deadline that many seconds from now,
      // so the time left keeps it where it was and `renewSeconds` moves it.
      const items = await listed('find', { [LOOKUP_METADATA_KEY]: lookupKey }, 2, apiKey);
      const first = asRecord(items[0]);
      const sandboxId = first['sandboxID'];
      const endAt = typeof first['endAt'] === 'string' ? Date.parse(first['endAt']) : Number.NaN;
      if (typeof sandboxId !== 'string' || !SANDBOX_ID.test(sandboxId) || Number.isNaN(endAt)) {
        return undefined;
      }
      const seconds = Math.floor((endAt - Date.now()) / 1_000);
      if (seconds < 1) return undefined;
      const timeout = renewSeconds ?? seconds;
      const connected = await connect('find', sandboxId, timeout, apiKey);
      return {
        ...(await reachable('find', connected, apiKey)).sandbox,
        expiresAt: renewSeconds === undefined ? endAt : Date.now() + timeout * 1_000,
      };
    },

    async list(tags, apiKey): Promise<readonly string[]> {
      const items = await listed('list', tags, LIST_LIMIT, apiKey);
      return items
        .map((item) => asRecord(item)['sandboxID'])
        .filter((id): id is string => typeof id === 'string' && SANDBOX_ID.test(id));
    },

    async writeFile(target: ExternalFileTarget, name, content, apiKey): Promise<void> {
      // POST /files?path=&username= with an octet-stream body writes one file, creates its parent
      // directories and overwrites (https://raw.githubusercontent.com/e2b-dev/infra/main/packages/envd/spec/envd.yaml,
      // checked 2026-10-10). envd needs the sandbox's envd token, which only create and POST
      // /sandboxes/{id}/connect return (https://raw.githubusercontent.com/e2b-dev/infra/main/spec/openapi.yml,
      // checked 2026-10-10), so connect fetches it; its `timeout` is the time left, which keeps
      // the deadline where it was.
      const operation = 'write a file';
      const seconds = Math.floor((target.expiresAt - Date.now()) / 1_000);
      if (seconds < 1) throw failure(operation);
      const body = await connect(operation, target.sandboxId, seconds, apiKey);
      const reached = await reachable(operation, body, apiKey);
      const envdAccessToken = asRecord(body)['envdAccessToken'];
      if (typeof envdAccessToken !== 'string' || envdAccessToken.length === 0) {
        throw failure(operation);
      }
      const bytes = new TextEncoder().encode(content);
      if (bytes.length > RUN_FILES_MAX_BYTES) throw failure(operation);
      const query = new URLSearchParams({
        path: `${TOOL_HOST_DIR}/${name}`,
        username: RUNNER_USER,
      });
      let response: Response;
      try {
        response = await doFetch(
          `https://${String(ENVD_PORT)}-${target.sandboxId}.${reached.domain}/files?${query.toString()}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/octet-stream',
              'x-access-token': envdAccessToken,
              ...reached.sandbox.accessHeaders,
            },
            body: bytes,
            redirect: 'error',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          },
        );
      } catch {
        throw failure(operation);
      }
      if (!response.ok) {
        throw await rejected(operation, response, [apiKey, envdAccessToken, reached.trafficToken]);
      }
      await response.body?.cancel();
    },

    destroy,
  };
}
