/**
 * The project CLI's refusal of a server whose contracts version it cannot operate (issue #361,
 * ADR-0078). Every `/api/**` answer, a 401 included, carries the served range; this reads it once
 * with the SDK's own comparison and turns a mismatch into one message that names both versions,
 * the side to upgrade and the command that fixes it.
 */
import {
  CONTRACTS_MINIMUM_VERSION_HEADER,
  CONTRACTS_VERSION,
  CONTRACTS_VERSION_HEADER,
  parseContractsVersion,
} from '@indx-workspace/contracts';
import { readContractsVersionSkew, type ContractsVersionSkew } from '@indx-workspace/sdk';

/**
 * The npm name this CLI is published under, and the only place an install command takes it from.
 * The Owner decided on 2026-09-29, recorded on #246, that the `@agent-workspace` scope on npm
 * belongs to a third party, so a fix line must never name it. `packages/cli/package.json` is
 * published under this name (#364); `contracts-skew.test.ts` pins the two equal.
 */
export const CLI_PUBLISHED_PACKAGE = '@indx-workspace/cli';

/** What one probe of a server found. */
export type ContractsProbe =
  | { readonly kind: 'served' }
  | { readonly kind: 'skew'; readonly skew: ContractsVersionSkew }
  /** The server answered, but without a readable served range (ADR-0078: accepted). */
  | { readonly kind: 'no-headers' }
  | { readonly kind: 'unreachable'; readonly reason: string };

export interface ProbeOptions {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * An unauthenticated `GET {baseUrl}/api/me`. The status is irrelevant (a 401 is the expected
 * answer); only the served-range headers matter. Never throws.
 */
export async function probeServerContracts(
  baseUrl: string,
  options: ProbeOptions = {},
): Promise<ContractsProbe> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  try {
    const url = new URL('api/me', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    const response = await (options.fetch ?? fetch)(url, {
      method: 'GET',
      signal,
      redirect: 'manual',
    });
    const skew = readContractsVersionSkew(response.headers);
    if (skew !== null) return { kind: 'skew', skew };
    return hasServedRange(response.headers) ? { kind: 'served' } : { kind: 'no-headers' };
  } catch (error) {
    return { kind: 'unreachable', reason: error instanceof Error ? error.name : 'error' };
  }
}

function hasServedRange(headers: Headers): boolean {
  const served = headers.get(CONTRACTS_VERSION_HEADER);
  const minimum = headers.get(CONTRACTS_MINIMUM_VERSION_HEADER);
  return (
    served !== null &&
    minimum !== null &&
    parseContractsVersion(served) !== null &&
    parseContractsVersion(minimum) !== null
  );
}

/** `MAJOR.MINOR` of the server's version, so the fix installs that minor's newest patch. */
function installableRange(serverVersion: string): string {
  const parsed = parseContractsVersion(serverVersion);
  return parsed === null ? serverVersion : `${String(parsed.major)}.${String(parsed.minor)}`;
}

/** The refusal text for a server outside the CLI's supported range: both versions, then the fix. */
export function describeSkew(skew: ContractsVersionSkew, baseUrl: string): string {
  const install = `npm install --global ${CLI_PUBLISHED_PACKAGE}@${installableRange(skew.serverVersion)}`;
  const fix =
    skew.upgrade === 'client'
      ? `Upgrade the CLI: ${install}`
      : `Upgrade the server to a release that serves contracts ${skew.clientVersion} ` +
        '(for a Compose project, `agent-workspace render --upgrade` then `agent-workspace start`), ' +
        `or downgrade the CLI: ${install}`;
  return (
    `agent-workspace was built against contracts ${skew.clientVersion}; the server at ${baseUrl} ` +
    `serves contracts ${skew.servedMinimum} to ${skew.serverVersion}. ${fix}`
  );
}

/** The warning for a server whose version could not be checked, and what the CLI does about it. */
function describeUnchecked(
  probe: Extract<ContractsProbe, { kind: 'unreachable' | 'no-headers' }>,
  baseUrl: string,
): string {
  return probe.kind === 'unreachable'
    ? `warning: could not check the contracts version of ${baseUrl} (${probe.reason}); continuing without the check`
    : `warning: ${baseUrl} states no contracts version, so it may be older than contracts ${CONTRACTS_VERSION}; ` +
        'ADR-0078 accepts a missing header, continuing';
}

/**
 * Enforce one probe's finding: throws the refusal on skew, writes a warning to stderr when the
 * version could not be checked, and returns silently when the server serves this CLI.
 */
export function enforceContractsProbe(
  probe: ContractsProbe,
  baseUrl: string,
  warn: (text: string) => void = (text) => void process.stderr.write(`${text}\n`),
): void {
  if (probe.kind === 'skew') throw new Error(describeSkew(probe.skew, baseUrl));
  if (probe.kind === 'no-headers' || probe.kind === 'unreachable') {
    warn(describeUnchecked(probe, baseUrl));
  }
}

/** Probe and enforce, as {@link enforceContractsProbe} describes. */
export async function assertServerServesContracts(
  baseUrl: string,
  options: ProbeOptions & { readonly warn?: (text: string) => void } = {},
): Promise<void> {
  enforceContractsProbe(await probeServerContracts(baseUrl, options), baseUrl, options.warn);
}
