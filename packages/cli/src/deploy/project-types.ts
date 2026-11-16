import type {
  ProductionEnvironment,
  ProjectDocument,
} from '@indx-workspace/contracts/project-file';

import { type DeploymentImages } from '../deployment.ts';
import { ProfileError } from '../profile.ts';
import { type ToolRunner } from './runner.ts';
import type { DeployOutcome } from './steps.ts';

/** The environments `aw deploy` takes to a deployment; `local` is `aw dev`'s. */
export type DeployableEnvironment = 'production';

/** `environments.<environment>`, refused at its path when the project does not define it. */
export function deployedEnvironment(
  project: ProjectDocument,
  environment: DeployableEnvironment,
): ProductionEnvironment {
  const deployed = project.environments[environment];
  if (deployed === undefined) {
    throw new ProfileError(`environments.${environment}`, 'is not defined; add target and url');
  }
  return deployed;
}

export interface DeployProjectEnvironmentOptions {
  readonly project: ProjectDocument;
  readonly environment: DeployableEnvironment;
  /** `--yes`: apply the plan. Without it nothing is deployed. */
  readonly apply: boolean;
  /**
   * The internal v1 deployment this environment drives,
   * `~/.config/agent-workspace/deployments/<project>/<env>`. Created on the first run with
   * freshly generated secrets, which are never regenerated after.
   */
  readonly stateDirectory: string;
  /**
   * `--infra`: the `infra/` directory of a claude-agent-workspace checkout, whose gcp-cloudrun
   * Terraform module is applied instead of the one this CLI ships. Optional for that target and
   * for kubernetes (whose chart is `infra/helm/agent-workspace`, shipped too), refused by single-vm.
   */
  readonly infraDirectory?: string;
  /**
   * The project directory, whose `web/` frontend the vercel target deploys as its own project. The
   * first one to deploy is recorded beside the state, and another is refused (BH061-028).
   */
  readonly projectDirectory?: string;
  /** Runs `docker` and `terraform`; the suite injects a stub. */
  readonly runner?: ToolRunner;
  /** The tools' environment, and where `AW_<NAME>_IMAGE` overrides are read. */
  readonly env?: NodeJS.ProcessEnv;
  /** The images a first run pins; resolved from the release otherwise. The suite injects them. */
  readonly images?: DeploymentImages;
  /** Resolves the url host; `dns.lookup` unless the suite injects one. */
  readonly resolveHost?: (hostname: string) => Promise<unknown>;
  /** `process.versions.node` unless the suite says otherwise. */
  readonly nodeVersion?: string;
  /** Makes the Google Cloud preflight's HTTP request (the global `fetch` when unset); the suite injects a stub. */
  readonly fetch?: typeof fetch;
  /**
   * Asks for a value without echoing it; given only when the terminal is interactive. The
   * sign-in client secret (`gcp.oidc`) is asked for this way, once; otherwise it is read from
   * `AW_OIDC_CLIENT_SECRET`.
   */
  readonly readSecret?: (question: string) => Promise<string>;
  /** Waits between the first deploy's model-connection tries; the suite injects a stub. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface ProjectDeployOutcome extends DeployOutcome {
  /** What the Owner does next, in order; `aw deploy` prints each line. */
  readonly nextSteps: readonly string[];
  /** Whether this run created the state directory and its secrets. */
  readonly created: boolean;
  readonly adminEmail: string;
  /**
   * The state's `.env`; single-vm's holds `BOOTSTRAP_ADMIN_PASSWORD`. Only its path is printed.
   * For kubernetes, which keeps no `.env` (the operator creates its Secrets in the cluster), the
   * chart values overlay.
   */
  readonly envFile: string;
  /** The gcp-cloudrun Terraform module this run drives; `null` for the other targets. */
  readonly moduleDirectory: string | null;
}

/** What each deploy path computes; `deployProjectEnvironment` adds the recipe's `nextSteps`. */
export type DeployedState = Omit<ProjectDeployOutcome, 'nextSteps'>;

export interface CloudRunModule {
  /** The `infra/` directory `agent-workspace deploy --infra` takes. */
  readonly infra: string;
  readonly moduleDirectory: string;
}
