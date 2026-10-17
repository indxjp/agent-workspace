/**
 * What each v2 deploy target means, as one table entry apiece (issue #948): the v1 profile it
 * starts from, the refusals of the project file and of `--infra` it adds, the `.env` hardening it
 * applies, and the steps the Owner reads after a deploy. The prerequisite checks and the executors
 * stay in `project.ts`, which dispatches on the target for them.
 */
import type { ProjectDeployTarget, ProjectDocument } from '@indx-workspace/contracts/project-file';

import { defaultProfile } from '../profile-defaults.ts';
import { ProfileError, type DeploymentProfile } from '../profile.ts';
import { composeProjectName } from '../render/env.ts';

/** What `aw deploy` prints after a successful run is built from these. */
interface RecipeFacts {
  readonly projectName: string;
  /** `environments.production.url`. */
  readonly url: string;
  readonly adminEmail: string;
  readonly envFile: string;
  /** The gcp-cloudrun Terraform module the run drove; `null` for the other targets. */
  readonly moduleDirectory: string | null;
  /** Whether the project has a `web/` frontend the vercel target deployed as its own project. */
  readonly frontend: boolean;
}

export interface DeployRecipe {
  /** The v1 profile the recipe starts from, before the project's own identity is applied. */
  readonly profile: (projectName: string) => DeploymentProfile;
  /** Refusals of the project file this recipe adds, as a `ProfileError` at the path the user edits. */
  readonly checkProject: (project: ProjectDocument) => void;
  /** The refusal of `--infra` for a target that takes none; `null` when it accepts or needs one. */
  readonly infraRefusal: string | null;
  /** The idempotent `.env` hardening applied on every run. */
  readonly hardenEnv: (env: string) => string;
  /** The lines `aw deploy` prints after "deployed production from <state>". */
  readonly nextSteps: (facts: RecipeFacts) => readonly string[];
}

const TLS_PROXY_MARKER = '# aw deploy: web is reached only through the TLS proxy on this VM.';

/**
 * Web is published on loopback only, and the one proxy in front of it — Caddy, terminating TLS
 * for the environment's `url` (docs/deploy/single-vm.md) — is trusted for `X-Forwarded-For`.
 */
function behindTlsProxy(env: string): string {
  const kept = env
    .split('\n')
    .filter((line) => !/^(?:PORT|AW_TRUSTED_PROXY_HOPS)=/u.test(line))
    .join('\n')
    .trimEnd();
  return [kept, TLS_PROXY_MARKER, 'PORT=127.0.0.1:3000', 'AW_TRUSTED_PROXY_HOPS=1', ''].join('\n');
}

function unchanged(env: string): string {
  return env;
}

function accepted(): void {
  // No refusal beyond the project file's own schema.
}

export const DEPLOY_RECIPES: Readonly<Record<ProjectDeployTarget, DeployRecipe>> = {
  'single-vm': {
    profile: (projectName) =>
      defaultProfile({ cloud: 'local', projectName, localObjectStore: 'seaweedfs' }),
    checkProject: accepted,
    infraRefusal:
      '--infra is for the gcp-cloudrun target; single-vm deploys the Compose project. ' +
      'Nothing was created.',
    // Applied until the marker is present, so a first run interrupted after the workspace was
    // created is still hardened, and an Owner's later edit is kept.
    hardenEnv: (env) => (env.includes(TLS_PROXY_MARKER) ? env : behindTlsProxy(env)),
    nextSteps: ({ url, adminEmail, envFile }) => [
      `next: caddy reverse-proxy --from ${new URL(url).host} --to 127.0.0.1:3000`,
      `next: aw login --url ${url}`,
      `the Owner is ${adminEmail}; the password is BOOTSTRAP_ADMIN_PASSWORD in ${envFile}`,
    ],
  },
  'gcp-cloudrun': {
    profile: (projectName) => defaultProfile({ cloud: 'gcp', projectName }),
    // The recipe's bucket is `<name>-files` and S3 caps it at 63; refuse at the path the user edits.
    checkProject: (project) => {
      if (project.name.length > 57) {
        throw new ProfileError(
          'name',
          'must be at most 57 characters for the gcp-cloudrun target (its bucket is <name>-files)',
        );
      }
    },
    infraRefusal: null,
    hardenEnv: unchanged,
    // Cloud Run's module generates the Owner's password itself; only the command reading it is named.
    nextSteps: ({ url, adminEmail, moduleDirectory }) => {
      const cloudRunModule = moduleDirectory ?? '';
      return [
        `next: map ${new URL(url).host} to the web service: terraform -chdir=${cloudRunModule} output web_url`,
        `next: aw login --url ${url}`,
        `the Owner is ${adminEmail}; the password is: terraform -chdir=${cloudRunModule} output -raw bootstrap_admin_password`,
      ];
    },
  },
  kubernetes: {
    // The chart is installed from its own values, not from a rendered v1 deployment.
    profile: () => {
      throw new ProfileError(
        'environments.production.target',
        'kubernetes has no v1 deployment profile; it installs the Helm chart',
      );
    },
    checkProject: accepted,
    infraRefusal: null,
    hardenEnv: unchanged,
    nextSteps: ({ url }) => [
      'the chart reads three Secrets you create in the agent-workspace namespace: agent-workspace-database, agent-workspace-object-store, agent-workspace-secrets',
      `next: point ${new URL(url).host} at the ingress controller: kubectl -n agent-workspace get ingress`,
      `next: aw login --url ${url}`,
      'the Owner and password are BOOTSTRAP_ADMIN and BOOTSTRAP_ADMIN_PASSWORD in agent-workspace-secrets',
    ],
  },
  vercel: {
    profile: (projectName) => defaultProfile({ cloud: 'vercel', projectName }),
    checkProject: accepted,
    infraRefusal:
      '--infra is for the gcp-cloudrun and kubernetes targets; vercel deploys the checkout in ' +
      'AGENT_WORKSPACE_SOURCE. Nothing was created.',
    hardenEnv: unchanged,
    nextSteps: ({ projectName, url, adminEmail, envFile, frontend }) => [
      // The browser calls the control plane from the frontend's own domain; CORS lists only allowedOrigins.
      ...(frontend
        ? [
            `next: aw push and aw promote the agent; unless deploy said otherwise above, the control plane allows https://${composeProjectName(projectName)}-web.vercel.app; list a custom domain in allowedOrigins of the surface web/ calls`,
          ]
        : []),
      `next: attach ${new URL(url).host} to the control-plane Vercel project (Settings, Domains) if it is not a *.vercel.app address`,
      `next: aw login --url ${url}`,
      `the Owner is ${adminEmail}; the password is BOOTSTRAP_ADMIN_PASSWORD in ${envFile}`,
    ],
  },
};
