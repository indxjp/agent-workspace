/**
 * Reading a Node/undici errno out of a thrown `fetch` failure's `cause` chain — R-06 §4.2's
 * `rootCause`, ported. Node's `fetch` (undici) throws `TypeError: fetch failed` and puts the real
 * errno one or more levels down in `.cause`.
 */

import type { ProbeSignal } from '../classify';

const MAX_CAUSE_DEPTH = 8;

/** Node socket-level error codes — "we never spoke to a server at all". */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function isTlsCode(code: string): boolean {
  return (
    code.startsWith('ERR_SSL_') ||
    code.startsWith('ERR_TLS_') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID'
  );
}

/** Walk `error`'s `cause` chain for the first string `.code`, or `null`. */
export function rootCauseCode(error: unknown): string | null {
  let cursor: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof cursor !== 'object' || cursor === null) return null;
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * A thrown `fetch` error, turned into a {@link ProbeSignal} — `network-error`, `tls-error`, or
 * `unknown` if the cause chain names no errno this probe recognises (ADR-0015's explicit else).
 */
export function classifyFetchThrow(error: unknown): ProbeSignal {
  const code = rootCauseCode(error);
  if (code !== null && isTlsCode(code)) return { kind: 'tls-error', code };
  if (code !== null && NETWORK_CODES.has(code)) return { kind: 'network-error', code };
  return { kind: 'unknown', detail: error instanceof Error ? error.message : String(error) };
}
