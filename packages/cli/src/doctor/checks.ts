/**
 * The profile, store and version-skew checks of `agent-workspace doctor`.
 *
 * Each composes the function the other commands already enforce with — the profile reader
 * (`profile.ts`), the `validate --validate` probes (`validate.ts`) and the contracts-version probe
 * (`contracts-skew.ts`) — and turns its answer into results instead of a refusal, so one run can
 * report every problem rather than the first.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { CONTRACTS_VERSION } from '@indx-workspace/contracts';

import { describeSkew, probeServerContracts, type ContractsProbe } from '../contracts-skew.ts';
import { ProfileDocumentError } from '../profile-document.ts';
import {
  COMPOSE_PROJECT_CREATE_COMMAND,
  PROJECT_KIND_ADVICE,
  ProfileError,
  ProjectKindRefusedError,
  parseProfileDocument,
  type DeploymentProfile,
} from '../profile.ts';
import {
  ProbeRefusedError,
  runProfileProbes,
  type ProbeResult,
  type ProbeStore,
  type ProfileProbes,
} from '../validate.ts';

export type DoctorCheckName = 'profile' | 'stores' | 'prerequisites' | 'version-skew';

type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  readonly check: DoctorCheckName;
  /** What was checked: the file, the store, the tool or the server. */
  readonly subject: string;
  readonly status: DoctorStatus;
  readonly detail: string;
  /** One line telling the operator what to do; `null` on a pass. */
  readonly advice: string | null;
}

/** Where the profile check ended: the profile when it validated, and the text it was read from. */
export interface ProfileCheckOutcome {
  readonly checks: readonly DoctorCheck[];
  readonly profile: DeploymentProfile | null;
  readonly text: string | null;
}

const PROFILE_FILE = 'agent-workspace.yaml';

function profileFailure(detail: string, advice: string): ProfileCheckOutcome {
  return {
    checks: [{ check: 'profile', subject: PROFILE_FILE, status: 'fail', detail, advice }],
    profile: null,
    text: null,
  };
}

/** A reader warning is several lines; its first states the problem, the rest what to write. */
function warningCheck(message: string): DoctorCheck {
  const [problem = message, ...lines] = message.split('\n');
  const remedy = lines.map((line) => line.trim()).filter((line) => line !== '');
  return {
    check: 'profile',
    subject: PROFILE_FILE,
    status: 'warn',
    detail: problem,
    advice:
      remedy.length === 0
        ? `Edit ${PROFILE_FILE} as the warning says.`
        : `Add to the top of ${PROFILE_FILE}: ${remedy.join(' and ')}`,
  };
}

/** Read and validate the profile with the reader every other command uses. */
export async function checkProfile(directory: string): Promise<ProfileCheckOutcome> {
  let text: string;
  try {
    text = await readFile(path.join(directory, PROFILE_FILE), 'utf8');
  } catch {
    return profileFailure(
      `${PROFILE_FILE} could not be read in ${directory}`,
      `Run doctor in the Compose project \`${COMPOSE_PROJECT_CREATE_COMMAND}\` generates, ` +
        'or pass its directory.',
    );
  }
  const warnings: string[] = [];
  let profile: DeploymentProfile;
  try {
    profile = parseProfileDocument(text, { onWarning: (message) => warnings.push(message) });
  } catch (error) {
    if (!(error instanceof ProfileError || error instanceof ProfileDocumentError)) throw error;
    // A kind: Project file is not a broken profile: `aw dev` runs it, not this CLI (#496).
    if (error instanceof ProjectKindRefusedError) {
      return { ...profileFailure(error.message, PROJECT_KIND_ADVICE), text };
    }
    return {
      ...profileFailure(
        error.message,
        `Correct ${PROFILE_FILE} at the line named; packages/cli/README.md describes every field.`,
      ),
      text,
    };
  }
  const pass: DoctorCheck = {
    check: 'profile',
    subject: PROFILE_FILE,
    status: 'pass',
    detail: `valid for cloud ${profile.cloud}`,
    advice: null,
  };
  // ADR-0131: setup completes on this driver, but it declares no network policy, so every run is
  // refused until one is declared. Mirrors `runtimeNetworkPolicyRefusal` in apps/web.
  const refusal: readonly DoctorCheck[] =
    profile.runtime.default === 'cloudflare-sandbox'
      ? [
          {
            check: 'profile',
            subject: 'runtime.default',
            status: 'warn',
            detail:
              'cloudflare-sandbox refuses every network policy (ADR-0131): runs are refused with network_policy_unsupported until a policy is declared',
            advice: 'Set runtime.default: external (E2B) to run sessions on Cloudflare.',
          },
        ]
      : [];
  return { checks: [pass, ...refusal, ...warnings.map(warningCheck)], profile, text };
}

const STORES: readonly ProbeStore[] = ['relational', 'objects', 'identity'];

function storeCheck({ store, outcome, detail }: ProbeResult): DoctorCheck {
  const base = { check: 'stores', subject: store, detail } as const;
  if (outcome === 'passed') return { ...base, status: 'pass', advice: null };
  if (outcome === 'missing') {
    return {
      ...base,
      status: 'warn',
      advice: 'If the bucket should already exist, check its name in storage.objects.',
    };
  }
  return {
    ...base,
    status: 'warn',
    advice: 'Not probed from this host: supply its credential in .env, or check it as stated.',
  };
}

/**
 * The stores, probed exactly as `validate --validate` probes them.
 *
 * `runProfileProbes` stops at the first store that does not answer and keeps none of the answers
 * before it, so that store is the failure and every other one is reported unchecked.
 */
export async function checkStores(
  profile: DeploymentProfile,
  environment: Readonly<Record<string, string | undefined>>,
  options: {
    readonly probes?: ProfileProbes;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  },
): Promise<readonly DoctorCheck[]> {
  try {
    return (await runProfileProbes(profile, { ...options, environment })).map(storeCheck);
  } catch (error) {
    if (!(error instanceof ProbeRefusedError)) throw error;
    return STORES.map((store) =>
      store === error.store
        ? {
            check: 'stores',
            subject: store,
            status: 'fail',
            detail: error.message,
            advice:
              'Check that the store is running, reachable from here, and that its credential is current.',
          }
        : {
            check: 'stores',
            subject: store,
            status: 'warn',
            detail: `not reported: the probes stop at the first store that does not answer (${error.store})`,
            advice: `Fix the ${error.store} store and run doctor again.`,
          },
    );
  }
}

/** A check that could not run because an earlier one failed. */
export function notChecked(check: DoctorCheckName, subject: string, reason: string): DoctorCheck {
  return {
    check,
    subject,
    status: 'warn',
    detail: `not checked: ${reason}`,
    advice: 'Fix the failure above and run doctor again.',
  };
}

function skewCheck(probe: ContractsProbe, serverUrl: string): DoctorCheck {
  const base = { check: 'version-skew', subject: 'server' } as const;
  switch (probe.kind) {
    case 'served':
      return {
        ...base,
        status: 'pass',
        detail: `${serverUrl} serves contracts ${CONTRACTS_VERSION}, which this CLI was built against`,
        advice: null,
      };
    case 'skew':
      return {
        ...base,
        status: 'fail',
        detail: describeSkew(probe.skew, serverUrl),
        advice:
          probe.skew.upgrade === 'client'
            ? 'Upgrade the CLI with the command above.'
            : 'Upgrade the server, or downgrade the CLI with the command above.',
      };
    case 'no-headers':
      return {
        ...base,
        status: 'warn',
        detail: `${serverUrl} states no contracts version, so it may be older than contracts ${CONTRACTS_VERSION}`,
        advice: 'Upgrade the server to a release that states its contracts version (ADR-0078).',
      };
    case 'unreachable':
      return {
        ...base,
        status: 'warn',
        detail: `${serverUrl} could not be reached (${probe.reason})`,
        advice: 'Check AGENT_WORKSPACE_URL and that the server is running.',
      };
  }
}

/**
 * The server's contracts version against this CLI's, with the #361 probe. Without
 * `AGENT_WORKSPACE_URL` there is no server to ask, which is a warning rather than a failure.
 */
export async function checkVersionSkew(
  environment: Readonly<Record<string, string | undefined>>,
  options: {
    readonly fetch?: typeof fetch;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  },
): Promise<DoctorCheck> {
  const serverUrl = environment['AGENT_WORKSPACE_URL']?.trim();
  if (serverUrl === undefined || serverUrl === '') {
    return {
      check: 'version-skew',
      subject: 'server',
      status: 'warn',
      detail: 'AGENT_WORKSPACE_URL is not set, so there is no server to compare against',
      advice: "Set AGENT_WORKSPACE_URL to the deployment's URL to check its contracts version.",
    };
  }
  return skewCheck(await probeServerContracts(serverUrl, options), serverUrl);
}
