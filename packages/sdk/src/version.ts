import {
  CONTRACTS_MINIMUM_VERSION_HEADER,
  CONTRACTS_VERSION,
  CONTRACTS_VERSION_HEADER,
  judgeContractsVersion,
  parseContractsVersion,
} from '@indx-workspace/contracts';

import type { ContractsVersionSkew } from './errors.js';

/**
 * Read the served contracts range a control plane stamps on every `/api/**` response and judge a
 * client version against it (issue #244, S-7). `null` means there is nothing to refuse: the range
 * is served, or the response carries no readable range (a server older than the negotiation, or
 * something in between that is not the control plane).
 *
 * The SDK calls this for every `426`; a command line that talks to the control plane with its own
 * `fetch` calls it on any response to refuse a server it cannot serve, with both versions in hand:
 *
 * ```ts
 * const skew = readContractsVersionSkew(response.headers);
 * if (skew !== null) fail(`built against ${skew.clientVersion}, server serves ${skew.serverVersion}`);
 * ```
 */
export function readContractsVersionSkew(
  headers: Headers,
  clientVersion: string = CONTRACTS_VERSION,
): ContractsVersionSkew | null {
  const serverText = headers.get(CONTRACTS_VERSION_HEADER);
  const minimumText = headers.get(CONTRACTS_MINIMUM_VERSION_HEADER);
  if (serverText === null || minimumText === null) return null;
  const current = parseContractsVersion(serverText);
  const minimum = parseContractsVersion(minimumText);
  const client = parseContractsVersion(clientVersion);
  if (current === null || minimum === null || client === null) return null;
  const verdict = judgeContractsVersion(client, { minimum, current });
  if (verdict.kind === 'served') return null;
  return {
    clientVersion,
    serverVersion: serverText,
    servedMinimum: minimumText,
    upgrade: verdict.upgrade,
  };
}
