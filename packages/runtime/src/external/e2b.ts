import { createE2bClient, SANDBOX_ID } from './e2b-client.js';
import { REQUEST_TIMEOUT_MS, RUNNER_PORT } from './e2b-process-config.js';
import { createE2bProcessStarter, type Reachable } from './e2b-process.js';
import { asRecord, failure, rejected, json } from './e2b-errors.js';
import { ENVD_PORT, TOOL_HOST_DIR, RUNNER_USER } from './e2b-process-config.js';
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

/** The metadata key a stateless driver (ADR-0126) records its lookup key under. */
const LOOKUP_METADATA_KEY = 'awKey';

// ponytail: one page; a session never holds this many sandboxes, follow `x-next-token` if one does.
const LIST_LIMIT = 100;
const DEFAULT_DOMAIN = 'e2b.app';
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

/**
 * The `message` of an E2B (`{code, message}`, https://github.com/e2b-dev/infra/blob/main/spec/openapi.yml,
 * checked 2026-10-08) or Connect (`{code, message}`, https://connectrpc.com/docs/protocol/#error-end-stream)
 * error body, with every secret of the call and any `e2b_` key masked, control characters removed and
 * the length capped. Anything that is not such a JSON body adds no reason.
 */

/** Reads and discards a non-OK response, returning its sanitized reason. */

type E2bProviderOptions = Readonly<{
  tier?: E2bPlanTier;
  apiBase?: string;
  fetch?: typeof globalThis.fetch;
}>;

class E2bSandboxLifecycle {
  private readonly doFetch: typeof globalThis.fetch;
  private readonly startRunner: ReturnType<typeof createE2bProcessStarter>;
  private readonly call: ReturnType<typeof createE2bClient>['call'];
  readonly destroy: ReturnType<typeof createE2bClient>['destroy'];
  private readonly listed: ReturnType<typeof createE2bClient>['listed'];
  private readonly connect: ReturnType<typeof createE2bClient>['connect'];

  constructor(options: E2bProviderOptions) {
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.startRunner = createE2bProcessStarter(this.doFetch);
    const apiBase = (options.apiBase ?? 'https://api.e2b.app').replace(/\/+$/u, '');
    const { call, destroy, listed, connect } = createE2bClient({ fetch: this.doFetch, apiBase });
    this.call = call;
    this.destroy = destroy;
    this.listed = listed;
    this.connect = connect;
  }

  /** A sandbox response read as the address and access headers the runner is reached with. */
  private async reachable(operation: string, body: unknown, apiKey: string): Promise<Reachable> {
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
      if (operation === 'create') await this.destroy(sandboxId, apiKey).catch(() => undefined);
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

  async create(request: ExternalSandboxRequest, apiKey: string): Promise<ExternalSandbox> {
    // POST /v2/sandboxes with X-API-Key (https://docs.e2b.dev/api-reference/sandboxes/create-sandbox-v2,
    // checked 2026-10-08). The key is the header only, and the bearer is not sent here: it goes
    // only to the runner's environment (`startRunner`), so the sandbox record never holds it.
    const response = await this.call('create', '/v2/sandboxes', apiKey, {
      method: 'POST',
      body: JSON.stringify({
        templateID: request.image,
        timeout: request.timeoutSeconds,
        metadata: {
          ...request.tags,
          sessionKey: request.sessionKey,
          ...(request.lookupKey === undefined ? {} : { [LOOKUP_METADATA_KEY]: request.lookupKey }),
        },
        ...networkBody(request),
      }),
    });
    if (!response.ok) throw await rejected('create', response, [apiKey, request.bearer]);
    const body = await json('create', response);
    const reached = await this.reachable('create', body, apiKey);
    const envdAccessToken = asRecord(body)['envdAccessToken'];
    try {
      // `/v2` always creates secure sandboxes, so a response without the token is unusable.
      if (typeof envdAccessToken !== 'string' || envdAccessToken.length === 0) {
        throw failure('create');
      }
      await this.startRunner({
        reached,
        envdAccessToken,
        bearer: request.bearer,
        apiKey,
        workload: request.workload,
      });
    } catch (error) {
      await this.destroy(reached.sandbox.sandboxId, apiKey).catch(() => undefined);
      throw error;
    }
    return reached.sandbox;
  }

  async find(
    lookupKey: string,
    apiKey: string,
    renewSeconds?: number,
  ): Promise<FoundExternalSandbox | undefined> {
    // The traffic token is returned by create and by POST /sandboxes/{sandboxID}/connect, not by
    // the list, so connect fetches it; its `timeout` sets the deadline that many seconds from now,
    // so the time left keeps it where it was and `renewSeconds` moves it.
    const items = await this.listed('find', { [LOOKUP_METADATA_KEY]: lookupKey }, 2, apiKey);
    const first = asRecord(items[0]);
    const sandboxId = first['sandboxID'];
    const endAt = typeof first['endAt'] === 'string' ? Date.parse(first['endAt']) : Number.NaN;
    if (typeof sandboxId !== 'string' || !SANDBOX_ID.test(sandboxId) || Number.isNaN(endAt)) {
      return undefined;
    }
    const seconds = Math.floor((endAt - Date.now()) / 1_000);
    if (seconds < 1) return undefined;
    const timeout = renewSeconds ?? seconds;
    const connected = await this.connect('find', sandboxId, timeout, apiKey);
    return {
      ...(await this.reachable('find', connected, apiKey)).sandbox,
      expiresAt: renewSeconds === undefined ? endAt : Date.now() + timeout * 1_000,
    };
  }

  async list(tags: Readonly<Record<string, string>>, apiKey: string): Promise<readonly string[]> {
    const items = await this.listed('list', tags, LIST_LIMIT, apiKey);
    return items
      .map((item) => asRecord(item)['sandboxID'])
      .filter((id): id is string => typeof id === 'string' && SANDBOX_ID.test(id));
  }

  async writeFile(
    target: ExternalFileTarget,
    name: string,
    content: string,
    apiKey: string,
  ): Promise<void> {
    // POST /files?path=&username= with an octet-stream body writes one file, creates its parent
    // directories and overwrites (https://raw.githubusercontent.com/e2b-dev/infra/main/packages/envd/spec/envd.yaml,
    // checked 2026-10-10). envd needs the sandbox's envd token, which only create and POST
    // /sandboxes/{id}/connect return (https://raw.githubusercontent.com/e2b-dev/infra/main/spec/openapi.yml,
    // checked 2026-10-10), so connect fetches it; its `timeout` is the time left, which keeps
    // the deadline where it was.
    const operation = 'write a file';
    const seconds = Math.floor((target.expiresAt - Date.now()) / 1_000);
    if (seconds < 1) throw failure(operation);
    const body = await this.connect(operation, target.sandboxId, seconds, apiKey);
    const reached = await this.reachable(operation, body, apiKey);
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
      response = await this.doFetch(
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
  }
}

export function createE2bProvider(options: E2bProviderOptions = {}): ExternalProvider {
  const lifecycle = new E2bSandboxLifecycle(options);
  return {
    id: 'e2b',
    capabilities: e2bRuntimeCapabilities(options.tier),
    restrictedRefusal: RESTRICTED_REFUSAL,
    create: (request, apiKey) => lifecycle.create(request, apiKey),
    find: (lookupKey, apiKey, renewSeconds) => lifecycle.find(lookupKey, apiKey, renewSeconds),
    list: (tags, apiKey) => lifecycle.list(tags, apiKey),
    writeFile: (target, name, content, apiKey) =>
      lifecycle.writeFile(target, name, content, apiKey),
    destroy: lifecycle.destroy,
  };
}
