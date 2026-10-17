/**
 * Contracts version negotiation at the edge (SDK unit 12, issue #244, S-7; ADR-0078).
 *
 * The served range is declared here and nowhere else. `apps/web/proxy.ts` runs
 * {@link negotiateContractsVersion} first on every `/api/**` request — before any exemption,
 * authentication, authorisation or body parsing — and stamps {@link servedContractsHeaders} on
 * every `/api/**` answer it lets through or refuses.
 *
 * The served range follows one rule (ADR-0078 D7, `concepts/public-surface.mdx`): the server serves
 * its current minor and the previous minor of the same major; at `X.0` it serves the last minor of
 * the previous major instead, for that one minor. Removals and renames land only in a major release,
 * and the release that deprecates an item already stops depending on it, so a client one minor
 * behind — even across a major — never needs what the server removed.
 */
import {
  CONTRACTS_MINIMUM_VERSION_HEADER,
  CONTRACTS_VERSION,
  CONTRACTS_VERSION_HEADER,
  CONTRACTS_VERSION_PROBLEM_CODES,
  judgeContractsVersion,
  parseContractsVersion,
  type ContractsVersion,
  type ServedContractsRange,
} from '@indx-workspace/contracts';

function requireVersion(text: string): ContractsVersion {
  const parsed = parseContractsVersion(text);
  if (parsed === null) throw new Error(`not a contracts version: ${text}`);
  return parsed;
}

/** The first contracts version ever released; nothing older is served, whatever the rule says. */
export const FIRST_CONTRACTS_VERSION = '0.1.0';

/**
 * The last minor of the previous major (`X.Y.0`), or `null` while no major has been released after
 * `0.x`. Set in the release that moves `CONTRACTS_VERSION` to a new major; it matters only while
 * that major is at `.0`.
 */
export const PREVIOUS_MAJOR_LAST_MINOR: string | null = null;

function isOlder(left: ContractsVersion, right: ContractsVersion): boolean {
  return left.major === right.major ? left.minor < right.minor : left.major < right.major;
}

/**
 * The served-range rule: the previous minor of the same major; at `X.0`, the given last minor of
 * the previous major; never older than the first released version. Pure, so its boundaries are
 * tested directly.
 */
export function minimumServedContractsVersion(
  current: ContractsVersion,
  previousMajorLastMinor: ContractsVersion | null,
  first: ContractsVersion,
): ContractsVersion {
  let minimum: ContractsVersion;
  if (current.minor > 0) {
    minimum = { major: current.major, minor: current.minor - 1, patch: 0 };
  } else if (previousMajorLastMinor !== null) {
    if (previousMajorLastMinor.major !== current.major - 1) {
      throw new Error(
        'the last minor of the previous major must belong to the major before the current',
      );
    }
    minimum = {
      major: previousMajorLastMinor.major,
      minor: previousMajorLastMinor.minor,
      patch: 0,
    };
  } else {
    minimum = { major: current.major, minor: 0, patch: 0 };
  }
  return isOlder(minimum, first) ? { ...first, patch: 0 } : minimum;
}

/** The one declaration of what this control plane serves. */
export const SERVED_CONTRACTS_RANGE: ServedContractsRange = {
  minimum: minimumServedContractsVersion(
    requireVersion(CONTRACTS_VERSION),
    PREVIOUS_MAJOR_LAST_MINOR === null ? null : requireVersion(PREVIOUS_MAJOR_LAST_MINOR),
    requireVersion(FIRST_CONTRACTS_VERSION),
  ),
  current: requireVersion(CONTRACTS_VERSION),
};

/** The oldest contracts version this control plane serves, as the minimum header states it. */
export const MINIMUM_SERVED_CONTRACTS_VERSION = `${String(SERVED_CONTRACTS_RANGE.minimum.major)}.${String(SERVED_CONTRACTS_RANGE.minimum.minor)}.0`;

/**
 * The `Upgrade` token a `426` names, as RFC 9110 §15.5.22 requires: the contracts version this
 * server speaks. It is informational — no connection upgrade follows — and hop-by-hop, so an
 * intermediary may drop it; the envelope and the range headers are the contract (ADR-0078 D2).
 */
export const CONTRACTS_UPGRADE_TOKEN = `agent-workspace-contracts/${String(SERVED_CONTRACTS_RANGE.current.major)}.${String(SERVED_CONTRACTS_RANGE.current.minor)}`;

/** The response headers that tell any caller which range this control plane serves. */
export function servedContractsHeaders(): Readonly<Record<string, string>> {
  return {
    [CONTRACTS_VERSION_HEADER]: CONTRACTS_VERSION,
    [CONTRACTS_MINIMUM_VERSION_HEADER]: MINIMUM_SERVED_CONTRACTS_VERSION,
  };
}

/** What the edge does with a request's contracts version. */
export type ContractsNegotiation =
  | { readonly kind: 'absent' }
  | { readonly kind: 'served' }
  | {
      readonly kind: 'refused';
      readonly status: number;
      readonly body: unknown;
      /** Headers the refusal needs beyond the served range: `Upgrade` on a `426`. */
      readonly headers: Readonly<Record<string, string>>;
    };

/** The standard envelope, with `detail` duplicating `message` as every problem does this release. */
function refusal(
  code: keyof typeof CONTRACTS_VERSION_PROBLEM_CODES,
  message: string,
): ContractsNegotiation {
  return {
    kind: 'refused',
    status: CONTRACTS_VERSION_PROBLEM_CODES[code],
    body: { error: { code, message, detail: message } },
    headers: code === 'contracts_version_unsupported' ? { upgrade: CONTRACTS_UPGRADE_TOKEN } : {},
  };
}

/**
 * Judge the `X-Agent-Workspace-Contracts` request header. `null` is a request without it, which is
 * always accepted and served at the current version: HTML forms, the IdP's `form_post` callback and
 * `<a href>` downloads cannot send a custom header, so negotiation applies only to a client that
 * declares its version (the SDK and `aw` always do). A present header that is not a version, or names one outside the served range, is
 * refused. Both refusal messages name the client's and the server's versions.
 */
export function negotiateContractsVersion(header: string | null): ContractsNegotiation {
  if (header === null) return { kind: 'absent' };
  const served = `${MINIMUM_SERVED_CONTRACTS_VERSION} to ${CONTRACTS_VERSION}`;
  const client = parseContractsVersion(header.trim());
  if (client === null) {
    return refusal(
      'contracts_version_malformed',
      `The ${CONTRACTS_VERSION_HEADER} header is not a MAJOR.MINOR.PATCH version; this server serves contracts ${served}.`,
    );
  }
  const verdict = judgeContractsVersion(client, SERVED_CONTRACTS_RANGE);
  if (verdict.kind === 'served') return verdict;
  const clientVersion = header.trim();
  const side =
    verdict.upgrade === 'client'
      ? 'Upgrade the client to a release built against a served version.'
      : 'Upgrade the server, or use a client built against a served version.';
  return refusal(
    'contracts_version_unsupported',
    `This client was built against contracts ${clientVersion}; this server serves contracts ${served}. ${side}`,
  );
}
