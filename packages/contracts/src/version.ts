/**
 * The contracts version a client was built against, and the rule the control plane uses to decide
 * whether it still serves that version (SDK unit 12, issue #244, S-7).
 *
 * A client sends {@link CONTRACTS_VERSION_HEADER} on every request. The control plane answers every
 * `/api/**` request with the range it serves — {@link CONTRACTS_VERSION_HEADER} is its current
 * version and {@link CONTRACTS_MINIMUM_VERSION_HEADER} the oldest it still serves — and refuses a
 * client outside that range with `426 contracts_version_unsupported` before any authorisation or
 * body parsing. The comparison is on `major.minor` only: a patch release never changes the wire.
 *
 * Everything here is pure so the server, the SDK and a command line judge a version the same way.
 */

/** The version of `@indx-workspace/contracts` this build is; equal to its `package.json` version. */
export const CONTRACTS_VERSION = '0.6.12';

/** Request: the contracts version the client was built against. Response: the server's current one. */
export const CONTRACTS_VERSION_HEADER = 'x-agent-workspace-contracts';

/** Response only: the oldest contracts version the server still serves. */
export const CONTRACTS_MINIMUM_VERSION_HEADER = 'x-agent-workspace-contracts-minimum';

/** The problem codes version negotiation answers with, and the status each travels under. */
export const CONTRACTS_VERSION_PROBLEM_CODES = {
  contracts_version_unsupported: 426,
  contracts_version_malformed: 400,
} as const;

export type ContractsVersionProblemCode = keyof typeof CONTRACTS_VERSION_PROBLEM_CODES;

/** A parsed `MAJOR.MINOR.PATCH`. */
export interface ContractsVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * Plain `MAJOR.MINOR.PATCH` with no leading zeros, no pre-release and no build suffix. The bound on
 * each component keeps a hostile header from reaching an unsafe integer.
 */
const VERSION_PATTERN = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u;

/** Parse a contracts version, or `null` when the text is not one. */
export function parseContractsVersion(text: string): ContractsVersion | null {
  const match = VERSION_PATTERN.exec(text);
  if (match === null) return null;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

/** The range a server serves, inclusive at both ends, compared on `major.minor`. */
export interface ServedContractsRange {
  readonly minimum: ContractsVersion;
  readonly current: ContractsVersion;
}

/**
 * Whether a client version is served. `upgrade` names the side that must move: `client` when the
 * client is older than the oldest served version, `server` when it is newer than the server.
 */
export type ContractsVersionVerdict =
  | { readonly kind: 'served' }
  | { readonly kind: 'unsupported'; readonly upgrade: 'client' | 'server' };

function compareMajorMinor(left: ContractsVersion, right: ContractsVersion): number {
  return left.major === right.major ? left.minor - right.minor : left.major - right.major;
}

/** Judge one client version against a served range. */
export function judgeContractsVersion(
  client: ContractsVersion,
  range: ServedContractsRange,
): ContractsVersionVerdict {
  if (compareMajorMinor(client, range.minimum) < 0) {
    return { kind: 'unsupported', upgrade: 'client' };
  }
  if (compareMajorMinor(client, range.current) > 0) {
    return { kind: 'unsupported', upgrade: 'server' };
  }
  return { kind: 'served' };
}
