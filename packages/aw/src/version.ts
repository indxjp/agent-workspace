import { CONTRACTS_VERSION, parseContractsVersion } from '@indx-workspace/contracts';
import type { ContractsVersionUnsupportedError } from '@indx-workspace/sdk';

/** This binary's version; equal to `packages/aw/package.json`'s, pinned by `version.test.ts`. */
export const AW_VERSION = '0.6.12';

/**
 * The npm name `aw` is published under, and the only place the install command takes it from. The
 * Owner decided on 2026-09-29, recorded on #246, that the `@agent-workspace` scope on npm belongs to
 * a third party, so the fix line must never name it. `packages/aw/package.json` carries the same
 * name, pinned by `version.test.ts` (#246, ADR-0082).
 */
export const AW_PUBLISHED_PACKAGE = '@indx-workspace/aw';

/** The Node major the project `npm create` writes requires (`engines.node: >=24`). */
const REQUIRED_NODE_MAJOR = 24;

/**
 * The stderr lines for a Node older than the project's `engines`, or `null`. A warning, not a
 * refusal: most commands still run, but `aw dev` and its runtime are supported on Node 24 only
 * (BH061-068).
 */
export function nodeVersionWarning(version: string): string | null {
  const major = String(REQUIRED_NODE_MAJOR);
  return Number(version.split('.')[0]) >= REQUIRED_NODE_MAJOR
    ? null
    : `warning: Agent Workspace needs Node ${major} or newer; you have v${version}\n` +
        `fix: nvm install ${major} && nvm use ${major} (or install it from https://nodejs.org)\n`;
}

/** What `aw --version` prints: the binary and the contracts version it negotiates with. */
export function versionText(): string {
  return `aw ${AW_VERSION} (contracts ${CONTRACTS_VERSION})\n`;
}

/** `MAJOR.MINOR` of a version the server named, so the fix installs that minor's newest patch. */
function installableRange(serverVersion: string): string {
  const parsed = parseContractsVersion(serverVersion);
  return parsed === null ? serverVersion : `${String(parsed.major)}.${String(parsed.minor)}`;
}

/**
 * The stderr text for a server that does not serve this binary's contracts version (issue #244,
 * S-7): both versions, then the command that fixes it. `aw` is released in lock-step with the
 * contracts, so the `aw` of the server's minor is always a client that server serves.
 */
export function contractsVersionRefusalText(error: ContractsVersionUnsupportedError): string {
  const skew = error.skew;
  if (skew === null) return `error: ${error.code}: ${error.message}\n`;
  const install = `npm install --global ${AW_PUBLISHED_PACKAGE}@${installableRange(skew.serverVersion)}`;
  const fix =
    skew.upgrade === 'client'
      ? `fix: ${install}`
      : `fix: upgrade the control plane to a release that serves contracts ${skew.clientVersion}, or run: ${install}`;
  return (
    `error: ${error.code}: aw ${AW_VERSION} was built against contracts ${skew.clientVersion}; ` +
    `the server serves contracts ${skew.servedMinimum} to ${skew.serverVersion}\n${fix}\n`
  );
}
