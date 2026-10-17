import { z } from 'zod';

import { API_KEY_PATTERN } from './api-keys.js';
import { IsoDateTimeSchema, UuidSchema } from './identifiers.js';
import { ProjectPolicySchema } from './policy-ceiling.js';
import {
  BootstrapAdminSchema,
  IMPLEMENTED_RUNTIME_DRIVERS,
  PROJECT_RESOURCE_MAP_MAX_ENTRIES,
} from './project-file.js';
import { SecretNameSchema } from './secret-reference.js';
import { parseContractsVersion } from './version.js';
import { WORKSPACE_SLUG_MAX_LENGTH } from './workspaces.js';

/**
 * Issue #439 (S1-01), ADR-0109: the messages `aw dev` and the local runtime it forks exchange over
 * the child process's IPC channel. Nothing here is served over HTTP.
 *
 * `start` travels parent → child (`aw` → runtime); `ready`, `credential` and `failed` travel child
 * → parent. Each side parses with its own direction's union, so a message travelling the wrong way
 * is refused rather than acted on.
 */
export const LOCAL_RUNTIME_MESSAGE_TYPES = ['start', 'ready', 'credential', 'failed'] as const;

export type LocalRuntimeMessageType = (typeof LOCAL_RUNTIME_MESSAGE_TYPES)[number];

/** The upper bound on a project directory path and on a failure message. */
const LOCAL_RUNTIME_TEXT_MAX_LENGTH = 4096;

/**
 * A workspace slug: lower-case letters, digits and hyphens, 1–63 characters, no hyphen at either
 * end — the grammar the `workspaces_slug_format` database check stores.
 */
const WORKSPACE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/**
 * Text safe to print to a terminal: no C0 or C1 control character (so no ANSI CSI or OSC escape
 * sequence), except a line feed and a tab.
 */
const TERMINAL_SAFE_TEXT_PATTERN = /^(?:[^\p{Cc}]|[\t\n])*$/u;

/** The hostnames a local runtime may announce; WHATWG URL keeps IPv6 brackets in `hostname`. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * True when `text` is an `http:` or `https:` URL whose host is loopback, with no userinfo, query or
 * fragment, written in its canonical WHATWG form (a bare origin may omit the final `/`). The
 * canonical-form rule refuses spellings another URL parser could read differently — a backslash,
 * an upper-case host, `127.1` or `0x7f000001` — so the string `aw` prints is the URL it checked.
 * Isomorphic, never throws.
 */
function isLoopbackHttpUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return false;
  if (url.username !== '' || url.password !== '') return false;
  if (text.includes('?') || text.includes('#')) return false;
  return url.href === text || (url.pathname === '/' && url.href === `${text}/`);
}

/**
 * The most names a `start` message's `environment.withheld` may hold (issue #564): generous next
 * to two project maps of at most 64 entries plus TypeScript `secret()` calls, and a bound on IPC
 * input.
 */
export const LOCAL_RUNTIME_WITHHELD_MAX_ENTRIES = 256;

/** The most names `environment.modelSecrets` may hold: a project file's `models` map's bound. */
export const LOCAL_RUNTIME_MODEL_SECRETS_MAX_ENTRIES = PROJECT_RESOURCE_MAP_MAX_ENTRIES;

/** An optional list of secret names, each once, at most `max`. */
function uniqueSecretNames(max: number) {
  return z
    .array(SecretNameSchema)
    .max(max)
    .refine((names) => new Set(names).size === names.length, 'must not repeat a name')
    .readonly()
    .optional();
}

/** The environment `aw dev` resolved from the project file, passed whole so the runtime reads no file of its own for it. */
export const LocalRuntimeEnvironmentSchema = z
  .object({
    port: z.number().int().min(1).max(65535),
    /** Absent means the runtime picks its own default driver. */
    runtimeDriver: z.enum(IMPLEMENTED_RUNTIME_DRIVERS).optional(),
    bootstrapAdmin: BootstrapAdminSchema,
    /**
     * The project file's policy ceiling (C13, ADR-0102 SD6, issue #524). `aw` sends it only when
     * the file has a `policy`, so a `start` message from a file without one is unchanged; a
     * runtime older than this key refuses it as an unknown key rather than running unbounded.
     */
    policy: ProjectPolicySchema.optional(),
    /**
     * The names, never the values, of the secrets the project references (C10, SD17; ADR-0109
     * slice-2 amendment, issue #564): each a {@link SecretNameSchema}, so a reserved name such as
     * `PATH` is refused here too, unique, at most {@link LOCAL_RUNTIME_WITHHELD_MAX_ENTRIES}. A
     * `start` message without it starts as before; a runtime older than this key refuses it as an
     * unknown key. The runtime refuses to start when, after `loadDotEnv`, its environment holds a
     * withheld name in any case (S2-04a).
     */
    withheld: uniqueSecretNames(LOCAL_RUNTIME_WITHHELD_MAX_ENTRIES),
    /**
     * The names, never the values, of the secrets the model connections the project runs on are
     * made from (issue #661): each connection's `credential.secret`, or `ANTHROPIC_API_KEY` for the
     * `default` connection of a project with no `models`. The try page names them in the fix for a
     * missing or rejected key. Unique, at most {@link LOCAL_RUNTIME_MODEL_SECRETS_MAX_ENTRIES}; a
     * runtime older than this key refuses it as an unknown key.
     */
    modelSecrets: uniqueSecretNames(LOCAL_RUNTIME_MODEL_SECRETS_MAX_ENTRIES),
  })
  .strict()
  .readonly();

export type LocalRuntimeEnvironment = z.infer<typeof LocalRuntimeEnvironmentSchema>;

/** `aw` → runtime: start serving the project in `projectDir` with this environment. */
export const LocalRuntimeStartMessageSchema = z
  .object({
    type: z.literal('start'),
    projectDir: z
      .string()
      .min(1)
      .max(LOCAL_RUNTIME_TEXT_MAX_LENGTH)
      .refine((value) => !value.includes('\0'), 'must not contain a NUL character'),
    environment: LocalRuntimeEnvironmentSchema,
  })
  .strict()
  .readonly();

export type LocalRuntimeStartMessage = z.infer<typeof LocalRuntimeStartMessageSchema>;

/**
 * Runtime → `aw`: the runtime is serving. `url` must be a loopback `http(s)` URL — stricter than
 * ADR-0109's text, so a local runtime can never point `aw` at another host. `contractsVersion` is
 * the runtime's own contracts version, for `aw` to judge skew.
 */
export const LocalRuntimeReadyMessageSchema = z
  .object({
    type: z.literal('ready'),
    url: z
      .string()
      .min(1)
      .max(2048)
      .refine(
        isLoopbackHttpUrl,
        'must be a canonical http(s) URL on 127.0.0.1, localhost or [::1], with no credentials, query or fragment',
      ),
    contractsVersion: z
      .string()
      .min(1)
      .max(32)
      .refine((value) => parseContractsVersion(value) !== null, 'must be MAJOR.MINOR.PATCH'),
  })
  .strict()
  .readonly();

export type LocalRuntimeReadyMessage = z.infer<typeof LocalRuntimeReadyMessageSchema>;

/**
 * Runtime → `aw`: the local runtime's one credential for `aw` (ADR-0109 as amended by S1-21,
 * issue #500). `token` is a whole workspace API key (`ak_live_…`) for the local workspace, minted
 * in process for the bootstrap admin at a role no higher than theirs, expiring 12 hours after it
 * was minted and revoked when the runtime stops. It is a bearer token: an API key is admitted on
 * every control-plane route with default security, which the person-facing CLI token is not.
 *
 * The key travels only over the IPC channel. Neither side ever prints or logs it; `aw` keeps it
 * only in its own `0600` credentials file, keyed by the runtime's URL. This is the only
 * local-runtime message that carries a credential.
 */
export const LocalRuntimeCredentialMessageSchema = z
  .object({
    type: z.literal('credential'),
    token: z.string().regex(API_KEY_PATTERN),
    expiresAt: IsoDateTimeSchema,
    workspaceId: UuidSchema,
    workspaceSlug: z
      .string()
      .max(WORKSPACE_SLUG_MAX_LENGTH, { abort: true })
      .regex(WORKSPACE_SLUG_PATTERN, 'must be a workspace slug'),
  })
  .strict()
  .readonly();

export type LocalRuntimeCredentialMessage = z.infer<typeof LocalRuntimeCredentialMessageSchema>;

/**
 * Runtime → `aw`: the runtime could not start. `message` is safe to show the person: it carries no
 * control character but a line feed or a tab, so printing it cannot inject a terminal escape.
 */
export const LocalRuntimeFailedMessageSchema = z
  .object({
    type: z.literal('failed'),
    message: z
      .string()
      .min(1)
      .max(LOCAL_RUNTIME_TEXT_MAX_LENGTH)
      .regex(TERMINAL_SAFE_TEXT_PATTERN, 'must not contain a control character'),
  })
  .strict()
  .readonly();

export type LocalRuntimeFailedMessage = z.infer<typeof LocalRuntimeFailedMessageSchema>;

/** Every local-runtime message, in either direction. */
export const LocalRuntimeMessageSchema = z.discriminatedUnion('type', [
  LocalRuntimeStartMessageSchema,
  LocalRuntimeReadyMessageSchema,
  LocalRuntimeCredentialMessageSchema,
  LocalRuntimeFailedMessageSchema,
]);

export type LocalRuntimeMessage = z.infer<typeof LocalRuntimeMessageSchema>;

/** What the runtime accepts from `aw`: `start` only. */
export const LocalRuntimeParentMessageSchema = z.discriminatedUnion('type', [
  LocalRuntimeStartMessageSchema,
]);

export type LocalRuntimeParentMessage = z.infer<typeof LocalRuntimeParentMessageSchema>;

/** What `aw` accepts from the runtime: `ready`, `credential` or `failed`. */
export const LocalRuntimeChildMessageSchema = z.discriminatedUnion('type', [
  LocalRuntimeReadyMessageSchema,
  LocalRuntimeCredentialMessageSchema,
  LocalRuntimeFailedMessageSchema,
]);

export type LocalRuntimeChildMessage = z.infer<typeof LocalRuntimeChildMessageSchema>;
