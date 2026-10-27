/**
 * `/api/runtime-connections` — not a §34 route (mandated by §14.9 instead, see
 * `tests/route-declarations/W3-CP-06.ts`) and not backed by a new table.
 *
 * §14.9 states a runtime connection's whole contract in one line: *"A runtime connection exists —
 * endpoint + credentials, stored as a secret."* This task's `Owns` cell grants
 * `apps/web/app/api/runtime-connections/**` but no `runtime_connections` table, and it does not
 * need one: `secrets` (§23) already stores an encrypted blob under a workspace-scoped id, which is
 * exactly what "endpoint + credentials" is. See
 * `docs/adr/W3-CP-06-runtime-connections-are-secrets.md` for the decision and its alternatives.
 *
 * ## What is, and is not, visible without decrypting
 *
 * A secret's `name` is a plain column (§23's write-only rule is about the *value*, never the
 * name), so this module encodes the two non-secret facts a connection list needs — which driver,
 * and a human label — into that name. Only the DRIVER half decodes back, in {@link decodeDriver};
 * the label half does not (`encodeSegment` is not injective — see its own doc), so `create()` and
 * `list()` both return the *stored, encoded* name, never the caller's original display string
 * (W3-CP-06-B2: an earlier version of this module returned the caller's `name` from `create()` and
 * the encoded name from `list()`, so the same connection read two ways showed two different names,
 * and `list()`'s `createdAt` was a fabricated `new Date(0)` rather than the secret's own metadata —
 * both measured false against a real PostgreSQL 17.11 and both fixed by this file returning the one
 * value the store actually holds, from both methods, always). `endpoint` and the credential itself
 * are sealed together as the secret's *value* and are never returned by `list()` — only a
 * connection's existence, name and driver are, which is all §14.9's selectability rule needs: *"A
 * runtime connection exists"* is a question about presence, not about display.
 *
 * ## The prefix partitions by naming convention, not by construction (W3-CP-06-B3)
 *
 * A secret created through this module is filtered into this list by a name PREFIX
 * (`RUNTIME_CONNECTION__`). That filter is real — an unrelated secret whose name does not carry
 * the prefix never appears here — but the reverse claim this file used to make, "by construction
 * rather than by convention", is false and was measured false (round-2 verifier, real PostgreSQL
 * 17.11): `/api/secrets`'s own `parseSecretName` (`apps/web/server/secrets/contract.ts`) accepts
 * `^[A-Z][A-Z0-9_]{0,127}$` verbatim, which the reserved prefix satisfies, so **a caller with
 * secrets-create permission can `POST /api/secrets` a body named
 * `RUNTIME_CONNECTION__DOCKER__FORGED` and it is admitted here as a connection**, sealed value and
 * all — nothing checks that the value is `{endpoint, credential}` JSON. Symmetrically,
 * `listSecrets` filters nothing, so a genuine runtime connection appears, name undecoded, in
 * `GET /api/secrets`'s own list. Closing either direction means changing `parseSecretName` and
 * `listSecrets` in `apps/web/server/secrets/**`, which is outside this task's `Owns` glob (the wave
 * protocol's prohibition 6 — never change a file outside a declared `Owns` glob) — declared as a
 * carried gap on this task's PR rather than reached for. `connections.test.ts`'s counter-example
 * drives exactly the forged name above, not a name that could never collide under any prefix
 * scheme, so the limit stated here is the one actually measured (ADR-0031).
 */
import { runtimeDriverIds } from '@agent-workspace/run-protocol';
import {
  UnknownWorkspaceError,
  type WorkspaceScope,
  type WorkspaceScopeResolver,
} from '@agent-workspace/core/db';

import { problem, type ApiResult } from '../http/result';

// ── The port ─────────────────────────────────────────────────────────────────────────────

/** What a caller may see about a runtime connection without decrypting anything. */
export interface RuntimeConnectionRecord {
  readonly id: string;
  readonly name: string;
  readonly driver: string;
  readonly createdAt: Date;
}

export interface CreateRuntimeConnectionInput {
  readonly name: string;
  readonly driver: string;
  readonly endpoint: string;
  readonly credential: string;
}

export type CreateRuntimeConnectionOutcome =
  | { readonly kind: 'created'; readonly connection: RuntimeConnectionRecord }
  | { readonly kind: 'name-conflict'; readonly name: string };

export interface WorkspaceRuntimeConnectionStore {
  list(): Promise<readonly RuntimeConnectionRecord[]>;
  create(input: CreateRuntimeConnectionInput): Promise<CreateRuntimeConnectionOutcome>;
}

export interface RuntimeConnectionStoreProvider {
  forWorkspace(workspaceId: string): WorkspaceRuntimeConnectionStore;
}

// ── The secret-name encoding ─────────────────────────────────────────────────────────────

const NAME_PREFIX = 'RUNTIME_CONNECTION__';
/** A label segment: upper-case letters, digits and underscores, matching `secrets.name`'s CHECK. */
const SECRET_NAME_LABEL = /^[A-Z][A-Z0-9_]*$/u;

/**
 * `docker` -> `DOCKER`; `cloud-run-sandbox` -> `CLOUD_RUN_SANDBOX`; `Primary Docker host` ->
 * `PRIMARY_DOCKER_HOST`. Every character outside `secrets.name`'s alphabet becomes `_`, so this is
 * total — it never throws — but it is not injective: two different labels can encode to the same
 * name. `encodeSecretName`'s caller does not need injectivity, only that its OWN two arguments
 * (driver, label) survive the round trip {@link decodeDriver} needs, which is the driver half
 * alone; the label is never decoded back; see this file's header.
 */
function encodeSegment(value: string): string {
  return value.toUpperCase().replaceAll(/[^A-Z0-9]/gu, '_');
}

/**
 * Build the secret name for a connection, or say why the label cannot round-trip.
 *
 * The label is derived from the caller's `name`, not taken verbatim: §23's `secrets.name` CHECK
 * (`^[A-Z][A-Z0-9_]{0,127}$`) is narrower than an arbitrary display name, and silently truncating
 * or stripping characters would make two different names collide. Refusing is the ADR-0015 shape.
 */
function encodeSecretName(
  driver: string,
  label: string,
): { ok: true; name: string } | { ok: false } {
  const encodedLabel = encodeSegment(label);
  if (!SECRET_NAME_LABEL.test(encodedLabel)) return { ok: false };
  const name = `${NAME_PREFIX}${encodeSegment(driver)}__${encodedLabel}`;
  return name.length <= 128 ? { ok: true, name } : { ok: false };
}

/** The secret name a connection labelled `label` of `driver` is stored under, or `null`. */
export function runtimeConnectionSecretName(driver: string, label: string): string | null {
  const encoded = encodeSecretName(driver, label);
  return encoded.ok ? encoded.name : null;
}

/** The inverse of {@link encodeSecretName}'s driver half, or `null` if `name` is not one of ours. */
function decodeDriver(name: string): string | null {
  if (!name.startsWith(NAME_PREFIX)) return null;
  const rest = name.slice(NAME_PREFIX.length);
  const at = rest.indexOf('__');
  if (at === -1) return null;
  return rest.slice(0, at).toLowerCase().replaceAll('_', '-');
}

// ── In-memory implementation, for routes.test.ts ────────────────────────────────────────

export function createInMemoryRuntimeConnectionStoreProvider(): RuntimeConnectionStoreProvider {
  const byWorkspace = new Map<string, Map<string, RuntimeConnectionRecord>>();
  let nextId = 1;

  return {
    forWorkspace(workspaceId: string): WorkspaceRuntimeConnectionStore {
      const rows = (): Map<string, RuntimeConnectionRecord> => {
        let existing = byWorkspace.get(workspaceId);
        if (existing === undefined) {
          existing = new Map();
          byWorkspace.set(workspaceId, existing);
        }
        return existing;
      };

      return {
        list(): Promise<readonly RuntimeConnectionRecord[]> {
          return Promise.resolve(
            [...rows().values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
          );
        },
        create(input: CreateRuntimeConnectionInput): Promise<CreateRuntimeConnectionOutcome> {
          // Names are stored (and returned by both list() and create()) in their ENCODED form —
          // see this file's header and W3-CP-06-B2: the encoding is not reversible in general, so
          // "the caller's display name" is not a value either store can honestly hand back on a
          // later GET, and the in-memory store below exists specifically to mirror the
          // secrets-backed store's real contract, not to keep a nicer one only it can honour.
          const encoded = encodeSecretName(input.driver, input.name);
          if (!encoded.ok) return Promise.resolve({ kind: 'name-conflict', name: input.name });
          for (const row of rows().values()) {
            if (row.name === encoded.name) {
              return Promise.resolve({ kind: 'name-conflict', name: input.name });
            }
          }
          const connection: RuntimeConnectionRecord = {
            id: `00000000-0000-4000-9000-${String(nextId).padStart(12, '0')}`,
            name: encoded.name,
            driver: input.driver,
            createdAt: new Date(),
          };
          nextId += 1;
          rows().set(connection.id, connection);
          return Promise.resolve({ kind: 'created', connection });
        },
      };
    },
  };
}

// ── The secrets-backed implementation ───────────────────────────────────────────────────

/** One secret's id, stored name and creation time — the slice of `SecretMetadata` this needs. */
interface RuntimeConnectionSecretSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
}

/**
 * The `SecretsService` methods this adapter needs — see `@agent-workspace/core/secrets`.
 * `scope` is `WorkspaceScope`, not `unknown` (W3-CP-06-B1): a real `SecretsService` value already
 * has exactly this shape (`SecretMetadata` is a superset of {@link RuntimeConnectionSecretSummary}),
 * so it satisfies this port with no adapter of its own — see this file's header for the one call
 * that wires it — and a caller that wires anything else is a compile error instead of a run-time
 * `ForgedWorkspaceScopeError`.
 */
export interface RuntimeConnectionSecretsPort {
  list(scope: WorkspaceScope): Promise<readonly RuntimeConnectionSecretSummary[]>;
  create(
    scope: WorkspaceScope,
    input: { readonly name: string; readonly value: Buffer },
  ): Promise<
    | { readonly kind: 'created'; readonly secret: RuntimeConnectionSecretSummary }
    | { readonly kind: 'name-conflict'; readonly name: string }
  >;
}

export interface SecretsRuntimeConnectionStoreDependencies {
  readonly secrets: RuntimeConnectionSecretsPort;
  /** Turns a workspace id into a scope, or answers `null`. Resolved lazily — see below. */
  readonly scopes: WorkspaceScopeResolver;
}

/**
 * The `secrets`-backed {@link RuntimeConnectionStoreProvider}. See this file's header for the
 * encoding this relies on, and `docs/adr/W3-CP-06-runtime-connections-are-secrets.md` for why.
 *
 * The scope lookup is lazy and memoised per `forWorkspace` call — exactly
 * `runtimes/store.ts`'s `createRepositoryRuntimeProfileStoreProvider` and
 * `secrets/store.ts`'s `createRepositorySecretsStoreProvider`, and for the same reason
 * (W3-CP-06-B1): `dependencies.scopeFor` used to be called eagerly and synchronously, but the only
 * source of a real `WorkspaceScope` is a `WorkspaceScopeResolver`, which is async by construction
 * (it does a lookup). Calling it eagerly cannot be written against the real resolver at all — it
 * type-checked only because the port's `scope` parameter was `unknown`.
 */
export function createSecretsRuntimeConnectionStoreProvider(
  dependencies: SecretsRuntimeConnectionStoreDependencies,
): RuntimeConnectionStoreProvider {
  return {
    forWorkspace(workspaceId: string): WorkspaceRuntimeConnectionStore {
      let pending: Promise<WorkspaceScope> | null = null;
      const scope = (): Promise<WorkspaceScope> => {
        pending ??= (async (): Promise<WorkspaceScope> => {
          const resolved = await dependencies.scopes.forWorkspaceId(workspaceId);
          if (resolved === null) throw new UnknownWorkspaceError(workspaceId);
          return resolved;
        })();
        return pending;
      };

      return {
        async list(): Promise<readonly RuntimeConnectionRecord[]> {
          const secrets = await dependencies.secrets.list(await scope());
          const connections: RuntimeConnectionRecord[] = [];
          for (const secret of secrets) {
            const driver = decodeDriver(secret.name);
            if (driver === null) continue;
            connections.push({
              id: secret.id,
              name: secret.name,
              driver,
              createdAt: secret.createdAt,
            });
          }
          return connections;
        },
        async create(input: CreateRuntimeConnectionInput): Promise<CreateRuntimeConnectionOutcome> {
          const encoded = encodeSecretName(input.driver, input.name);
          if (!encoded.ok) return { kind: 'name-conflict', name: input.name };
          const value = Buffer.from(
            JSON.stringify({ endpoint: input.endpoint, credential: input.credential }),
            'utf8',
          );
          const outcome = await dependencies.secrets.create(await scope(), {
            name: encoded.name,
            value,
          });
          if (outcome.kind === 'name-conflict') return { kind: 'name-conflict', name: input.name };
          return {
            kind: 'created',
            connection: {
              id: outcome.secret.id,
              name: outcome.secret.name,
              driver: input.driver,
              createdAt: outcome.secret.createdAt,
            },
          };
        },
      };
    },
  };
}

// ── Server-side credential resolution ───────────────────────────────────────────────────

/** The `SecretsService` methods credential resolution needs; a real service satisfies it. */
export interface RuntimeConnectionCredentialSecrets {
  list(scope: WorkspaceScope): Promise<readonly RuntimeConnectionSecretSummary[]>;
  resolveByName(scope: WorkspaceScope, name: string): Promise<{ readonly value: Buffer } | null>;
}

export type RuntimeConnectionCredentialOutcome =
  | { readonly kind: 'resolved'; readonly credential: string }
  /** No such connection in this workspace, or it belongs to another driver. */
  | { readonly kind: 'missing' }
  /** The connection exists but its stored value cannot yield a credential. */
  | { readonly kind: 'unusable'; readonly name: string };

/**
 * The provider credential of one runtime connection, for a run of `driver` in `workspaceId`.
 *
 * Only this workspace's secrets are listed, so another tenant's connection id is `missing`, and a
 * connection registered for a different driver is never handed to this one. The credential is
 * returned to the caller and appears in no outcome other than `resolved`.
 */
export async function resolveRuntimeConnectionCredential(
  dependencies: Readonly<{
    secrets: RuntimeConnectionCredentialSecrets;
    scopes: WorkspaceScopeResolver;
  }>,
  workspaceId: string,
  connectionId: string,
  driver: string,
): Promise<RuntimeConnectionCredentialOutcome> {
  const scope = await dependencies.scopes.forWorkspaceId(workspaceId);
  if (scope === null) return { kind: 'missing' };
  const secret = (await dependencies.secrets.list(scope)).find(
    (candidate) => candidate.id === connectionId,
  );
  if (secret === undefined || decodeDriver(secret.name) !== driver) return { kind: 'missing' };
  try {
    const resolved = await dependencies.secrets.resolveByName(scope, secret.name);
    const stored: unknown = resolved === null ? null : JSON.parse(resolved.value.toString('utf8'));
    const credential =
      typeof stored === 'object' && stored !== null && !Array.isArray(stored)
        ? (stored as Record<string, unknown>)['credential']
        : undefined;
    // Only visible ASCII can be a header value; anything else would make `fetch` throw an
    // error quoting the key, which would then reach the server log.
    if (typeof credential === 'string' && /^[\x21-\x7e]+$/u.test(credential)) {
      return { kind: 'resolved', credential };
    }
  } catch {
    // An undecryptable or malformed value is reported as unusable; the cause may quote the value.
  }
  return { kind: 'unusable', name: secret.name };
}

// ── Contract: parsing and resource shaping ──────────────────────────────────────────────

export interface RuntimeConnectionResource {
  readonly id: string;
  readonly name: string;
  readonly driver: string;
  readonly createdAt: string;
}

export function toRuntimeConnectionResource(
  connection: RuntimeConnectionRecord,
): RuntimeConnectionResource {
  return {
    id: connection.id,
    name: connection.name,
    driver: connection.driver,
    createdAt: connection.createdAt.toISOString(),
  };
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

/** `POST /api/runtime-connections`'s body: `name`, `driver`, `endpoint`, `credential`. */
export function parseCreateRuntimeConnectionInput(
  raw: unknown,
): ParseResult<CreateRuntimeConnectionInput> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['(root): a runtime connection body must be a JSON object'] };
  }
  const record = raw as Record<string, unknown>;
  const errors: string[] = [];
  const name = record['name'];
  if (typeof name !== 'string' || name.trim() === '')
    errors.push('name: must be a non-empty string');
  const driver = record['driver'];
  if (typeof driver !== 'string' || !(runtimeDriverIds as readonly string[]).includes(driver)) {
    errors.push(`driver: must be one of ${runtimeDriverIds.join(', ')}`);
  }
  const endpoint = record['endpoint'];
  if (typeof endpoint !== 'string' || endpoint.trim() === '')
    errors.push('endpoint: must be a non-empty string');
  const credential = record['credential'];
  if (typeof credential !== 'string' || credential === '')
    errors.push('credential: must be a non-empty string');
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: name as string,
      driver: driver as string,
      endpoint: endpoint as string,
      credential: credential as string,
    },
  };
}

// ── Handlers ─────────────────────────────────────────────────────────────────────────────

/** `POST /api/runtime-connections` — 201, or 400 / 409. */
export async function createRuntimeConnection(
  store: WorkspaceRuntimeConnectionStore,
  rawBody: unknown,
): Promise<ApiResult> {
  const parsed = parseCreateRuntimeConnectionInput(rawBody);
  if (!parsed.ok) {
    return problem(
      400,
      'invalid_body',
      'The runtime connection could not be created from this body.',
      parsed.errors,
    );
  }
  const outcome = await store.create(parsed.value);
  switch (outcome.kind) {
    case 'created':
      return { status: 201, body: toRuntimeConnectionResource(outcome.connection) };
    case 'name-conflict':
      return problem(
        409,
        'runtime_connection_name_conflict',
        `This workspace already has a runtime connection named ${JSON.stringify(outcome.name)} for that driver, or the name cannot be stored.`,
      );
    default: {
      const unreachable: never = outcome;
      return problem(
        500,
        'unhandled_store_outcome',
        `The store returned an outcome this route does not handle: ${JSON.stringify(unreachable)}.`,
      );
    }
  }
}

/** `GET /api/runtime-connections` — 200 with this workspace's connections. Never a credential. */
export async function listRuntimeConnections(
  store: WorkspaceRuntimeConnectionStore,
): Promise<ApiResult> {
  const connections = await store.list();
  return {
    status: 200,
    body: { runtimeConnections: connections.map(toRuntimeConnectionResource) },
  };
}
