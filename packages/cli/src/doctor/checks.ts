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
import {
  STORAGE_URL_ENV,
  configuredPath,
  ignoredStorageVariables,
  resolveStorageSettings,
  storageUrlReplacing,
} from '@indx-workspace/contracts/storage-settings';
import { formatStorageUrl, type StorageLocation } from '@indx-workspace/contracts/storage-url';

import { describeSkew, probeServerContracts, type ContractsProbe } from '../contracts-skew.ts';
import { ProfileDocumentError } from '../profile-document.ts';
import { composeWebOrigins } from '../render/env.ts';
import {
  COMPOSE_PROJECT_CREATE_COMMAND,
  PROJECT_KIND_ADVICE,
  ProfileError,
  ProjectKindRefusedError,
  parseProfileDocument,
  type DeploymentProfile,
} from '../profile.ts';
import {
  BucketAbsentError,
  ProbeRefusedError,
  runProfileProbes,
  type ProbeResult,
  type ProbeStore,
  type ProfileProbes,
} from '../validate.ts';

export type DoctorCheckName =
  'profile' | 'storage' | 'stores' | 'storage-layout' | 'prerequisites' | 'version-skew';

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

/**
 * The `AW_STORAGE_URL` that would name the location the old variables used to, or `null` when no
 * URL can (mixed local roots, an Azure service URL with no account, an endpoint with userinfo).
 * As the old settings did, an s3 bucket is in `AWS_REGION`, else `us-east-1`, and a gcs bucket in
 * `GCP_PROJECT`. `createsBucket` is the old implicit S3-compatible endpoint (the bundled
 * SeaweedFS), whose bucket the server used to create. Advice only: the server never reads the old
 * variables. The URL parses, so it carries no credential.
 */
function oldLocationUrl(
  environment: Readonly<Record<string, string | undefined>>,
): { readonly url: string; readonly createsBucket: boolean } | null {
  const read = (name: string) => configuredPath(name, environment);
  const bucket = read('OBJECT_STORAGE_BUCKET');
  const backend = read('OBJECT_STORAGE_BACKEND');
  let location: StorageLocation | null = null;
  if (bucket !== null && backend === 'gcs') {
    const projectId = read('GCP_PROJECT');
    location = { kind: 'gcs', bucket, prefix: '', ...(projectId === null ? {} : { projectId }) };
  } else if (bucket !== null && (backend === null || backend === 's3')) {
    const endpoint = read('OBJECT_STORAGE_ENDPOINT');
    const publicEndpoint = read('OBJECT_STORAGE_PUBLIC_ENDPOINT');
    location = {
      kind: 's3',
      bucket,
      prefix: '',
      ...(endpoint === null ? {} : { endpoint }),
      ...(publicEndpoint === null ? {} : { publicEndpoint }),
      // A set AWS_REGION still reaches the server, which fills a URL with no region from it.
      ...(read('AWS_REGION') === null ? { region: 'us-east-1' } : {}),
      forcePathStyle: read('OBJECT_STORAGE_FORCE_PATH_STYLE') === 'true',
    };
  } else if (bucket === null) {
    const files = read('AW_FILE_STORAGE_ROOT');
    const root = files?.endsWith('/files') === true ? files.slice(0, -'/files'.length) : null;
    if (
      root !== null &&
      read('AW_SKILL_STORAGE_ROOT') === `${root}/skills` &&
      read('AW_SESSION_TRANSCRIPT_ROOT') === `${root}/sessions`
    ) {
      location = { kind: 'file', root };
    }
  }
  if (location === null) return null;
  const url = storageUrlReplacing(location, environment);
  if (url === null) return null;
  return {
    url,
    createsBucket: location.kind === 's3' && location.endpoint !== undefined && backend === null,
  };
}

/**
 * Why `oldLocationUrl` gives no line for old variables that once named a place, or `null` when it
 * does or no explanation helps (an endpoint with userinfo is left out so nothing hints at it).
 * Names variables and placeholders, never a value.
 */
function noOldLocationUrlReason(
  environment: Readonly<Record<string, string | undefined>>,
): string | null {
  const read = (name: string) => configuredPath(name, environment);
  if (read('OBJECT_STORAGE_BUCKET') !== null) {
    return read('OBJECT_STORAGE_BACKEND') === 'azure-blob'
      ? ` The old Azure setting names no storage account, so no line can point at it: set ${STORAGE_URL_ENV}=azblob://<account>/<container>, adding ?endpoint=<service URL> for an emulator.`
      : null;
  }
  const roots = ['AW_FILE_STORAGE_ROOT', 'AW_SKILL_STORAGE_ROOT', 'AW_SESSION_TRANSCRIPT_ROOT'];
  return roots.some((name) => read(name) !== null)
    ? ` The old files, skills and sessions roots do not share one folder, so no one URL names them: move them to files/, skills/ and sessions/ under one folder, then set ${STORAGE_URL_ENV}=file://<that folder>.`
    : null;
}

/**
 * The storage setting, decided by the function the server starts up with. Every message names
 * variables and prints only `formatStorageUrl` of a parsed URL, never the raw value, because the
 * redactor masks userinfo but not query values.
 */
// @story US-STO-10
export function checkStorage(
  environment: Readonly<Record<string, string | undefined>>,
): DoctorCheck {
  const base = { check: 'storage', subject: STORAGE_URL_ENV } as const;
  const settings = resolveStorageSettings(environment);
  const ignored = ignoredStorageVariables(environment);
  const removeAdvice = ignored.length === 0 ? null : `Remove ${ignored.join(', ')} from .env.`;
  const ignoredDetail = settings.warnings.join(' ');
  switch (settings.kind) {
    case 'refused':
      return {
        ...base,
        status: 'fail',
        detail: [settings.reason, ignoredDetail].filter((part) => part !== '').join(' '),
        advice: `Correct ${STORAGE_URL_ENV} so it names where files, skills and session state are kept.${removeAdvice === null ? '' : ` ${removeAdvice}`}`,
      };
    case 'legacy':
    case 'none': {
      if (removeAdvice !== null) {
        // The old variables once named a location; with no URL nothing is kept at all.
        const replacement = oldLocationUrl(environment);
        return {
          ...base,
          status: 'fail',
          detail: ignoredDetail,
          advice:
            (replacement === null
              ? `Set ${STORAGE_URL_ENV} in .env.${noOldLocationUrlReason(environment) ?? ''}`
              : `Set ${STORAGE_URL_ENV} in .env; this line points at the old location: ${STORAGE_URL_ENV}=${replacement.url}`) +
            (replacement?.createsBucket === true
              ? ` The old settings created this bucket; to keep that, set AW_STORAGE_CREATE_BUCKET=true.`
              : '') +
            ` ${removeAdvice}`,
        };
      }
      return {
        ...base,
        status: 'warn',
        detail: 'no storage setting; files, skills and session state are not installed',
        advice: `Set ${STORAGE_URL_ENV} in .env, for example ${STORAGE_URL_ENV}=file:///var/lib/agent-workspace.`,
      };
    }
    case 'url':
      return {
        ...base,
        status: settings.warnings.length === 0 ? 'pass' : 'warn',
        detail:
          `${STORAGE_URL_ENV} = ${formatStorageUrl(settings.location)}` +
          (ignoredDetail === '' ? '' : `; ${ignoredDetail}`),
        advice: removeAdvice,
      };
  }
}

const ALLOWED_ORIGINS_ENV = 'SEAWEEDFS_ALLOWED_ORIGINS';

/** The host port in `PORT`, which is `port` or `address:port`, or Compose's default of 3000. */
function composeWebPort(environment: Readonly<Record<string, string | undefined>>): number {
  const port = environment['PORT']?.trim().split(':').at(-1) ?? '';
  return /^\d{1,5}$/u.test(port) ? Number(port) : 3000;
}

/**
 * The bundled SeaweedFS's browser origins, on a local (Compose) profile only. The template
 * requires the variable, and Compose interpolates every service whichever profiles run, so a
 * `.env` an older CLI rendered without it fails `docker compose up` before anything starts.
 */
export function checkComposeOrigins(
  profile: DeploymentProfile,
  environment: Readonly<Record<string, string | undefined>>,
): DoctorCheck | null {
  if (profile.cloud !== 'local') return null;
  const base = { check: 'storage', subject: ALLOWED_ORIGINS_ENV } as const;
  const origins = environment[ALLOWED_ORIGINS_ENV]?.trim() ?? '';
  if (origins !== '') {
    return { ...base, status: 'pass', detail: `${ALLOWED_ORIGINS_ENV} = ${origins}`, advice: null };
  }
  return {
    ...base,
    status: 'fail',
    detail: `${ALLOWED_ORIGINS_ENV} is not set, so docker compose refuses the project before any service starts`,
    advice: `Add to .env: ${ALLOWED_ORIGINS_ENV}=${composeWebOrigins(composeWebPort(environment))}`,
  };
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
 * An S3-compatible endpoint (the bundled SeaweedFS) with no bucket is the case where the server
 * can make it: `AW_STORAGE_CREATE_BUCKET=true`, which the old implicit endpoint used to imply.
 */
function storeRefusalAdvice(
  error: ProbeRefusedError,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (error instanceof BucketAbsentError) {
    const settings = resolveStorageSettings(environment);
    const s3Compatible =
      settings.kind === 'url' &&
      settings.location.kind === 's3' &&
      settings.location.endpoint !== undefined;
    return s3Compatible
      ? 'Create the bucket, or set AW_STORAGE_CREATE_BUCKET=true so the server creates it at start-up.'
      : `Create the bucket, or correct its name in ${STORAGE_URL_ENV}.`;
  }
  return 'Check that the store is running, reachable from here, and that its credential is current.';
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
            advice: storeRefusalAdvice(error, environment),
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
