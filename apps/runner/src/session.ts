/**
 * `apps/runner/src/session.ts` — where the durable session store is, as the *container* knows it.
 *
 * ## What it is, and what it stopped being
 *
 * Until ENG-06 (#305) this file was the runner's transcript mirror: an HTTP implementation of the
 * Agent SDK's `SessionStore`, speaking `/api/sessions/:id/transcript` and `/subkeys`. The client
 * moved to `./session-state.ts`, which speaks the engine-neutral `/state-*` family instead, and
 * what stayed here is the half that was never about an engine — **where** the control plane is and
 * **how long** a call to it may take.
 *
 * That split is the point of the move rather than tidying after it. §14.3's `POST /run` body
 * carries every *per-run* value, which is what lets one runtime container serve any tenant; the
 * store's endpoint and timeout are not per-run, they are properties of the deployment the container
 * was started by, exactly like `PORT`. So they are read from the container environment by
 * {@link readMirrorConfig}, and the per-run half — the session, the engine and the signed token —
 * arrives on the request.
 *
 * ## Why the credential is per-run and not per-container
 *
 * The bearer is the run's own signed claim, registered in `run_tokens` and bound to a workspace, a
 * run and a session. A deployment-wide mirror bearer would let a runner that can write one
 * workspace's session state write another's if it named one; `apps/runner/src/index.ts` refuses to
 * install a store without the per-run token, and the control plane checks the claim against the
 * session the path names rather than trusting the sandbox.
 */

/** The base URL of the control plane, e.g. `https://workspace.example.com`. */
export const MIRROR_URL_ENV = 'AW_SESSION_MIRROR_URL';
/**
 * The per-run bearer the runner presents to the session-state routes.
 *
 * Carried on the `RunRequest`'s own `env`, never read from the container: a container-level
 * credential is a credential every tenant's run shares.
 */
export const MIRROR_TOKEN_ENV = 'AW_SESSION_MIRROR_TOKEN';
/** How long one store request may take, in milliseconds. Optional; see {@link DEFAULT_TIMEOUT_MS}. */
export const MIRROR_TIMEOUT_ENV = 'AW_SESSION_MIRROR_TIMEOUT_MS';

/**
 * The default per-request timeout.
 *
 * Every request this store makes is a small JSON round trip or one size-capped blob — there is no
 * event stream here, so the trap W1-CP-04 hit (an `AbortSignal.timeout` attached to `fetch` staying
 * live for the whole response body and killing a ten-minute stream) does not apply. It is bounded
 * anyway, because an `append()` that never settles is a batch that never retries.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** A configured store, or the reason there is not one. Three arms, and no fourth. */
export type MirrorConfig =
  | {
      readonly kind: 'configured';
      readonly baseUrl: string;
      readonly timeoutMs: number;
    }
  /** Neither variable is set. This deployment asked for no store; the run is not durable. */
  | { readonly kind: 'absent'; readonly reason: string }
  /** Something was set and cannot be used. A refusal, never a fallback to `absent`. */
  | { readonly kind: 'invalid'; readonly reason: string };

function readable(env: Readonly<Record<string, string | undefined>>, name: string): string | null {
  const value = env[name];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Read the store's configuration off the container environment.
 *
 * The three arms are the whole of ADR-0015 applied to a configuration read. A **partly**
 * configured store — a URL with no credential, a credential with no URL, an unparseable URL, a
 * timeout that is not a positive integer — is `invalid`, not `absent`: an operator who set one of
 * the two variables was trying to turn this on, and silently running without a store would give
 * them a deployment whose sessions cannot be resumed and no sentence anywhere saying so.
 */
export function readMirrorConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MirrorConfig {
  const url = readable(env, MIRROR_URL_ENV);
  const timeout = readable(env, MIRROR_TIMEOUT_ENV);

  if (url === null && timeout === null) {
    return {
      kind: 'absent',
      reason:
        `${MIRROR_URL_ENV} is unset, so this runtime mirrors no ` +
        `session state. Every session it runs lives only inside the sandbox and cannot be ` +
        `resumed after it is destroyed (spec §14.9).`,
    };
  }
  if (url === null) {
    return {
      kind: 'invalid',
      reason: `${MIRROR_TIMEOUT_ENV} is set but ${MIRROR_URL_ENV} is not, so there is nowhere to mirror to.`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'invalid', reason: `${MIRROR_URL_ENV}=${JSON.stringify(url)} is not a URL.` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      kind: 'invalid',
      reason: `${MIRROR_URL_ENV}=${JSON.stringify(url)} has scheme ${parsed.protocol}; only http: and https: are mirrored to.`,
    };
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (timeout !== null) {
    // Parsed, then compared. `Number('12ms')` is NaN and `NaN > 0` is false, so a check written
    // the other way round would read a malformed timeout as "not positive" and fall through to a
    // default the operator did not ask for (ADR-0015 — the exact shape found seven times here).
    const value = Number(timeout);
    if (!Number.isInteger(value) || value <= 0) {
      return {
        kind: 'invalid',
        reason: `${MIRROR_TIMEOUT_ENV}=${JSON.stringify(timeout)} is not a positive integer number of milliseconds.`,
      };
    }
    timeoutMs = value;
  }

  // A trailing slash on the base would produce `//api/...`, which some proxies treat as a
  // different path. Normalised once, here, rather than at four call sites.
  return {
    kind: 'configured',
    baseUrl: parsed.href.replace(/\/+$/, ''),
    timeoutMs,
  };
}
