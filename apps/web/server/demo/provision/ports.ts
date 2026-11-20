/**
 * The demo provisioner's port (internal spec, "How Try it works"). The provisioner is the
 * `GuestWorkspaceBinder` the email-link sign-in calls: it binds the guest through the RBAC
 * directory, which marks the new workspace with its end (`workspaces.demo_expires_at`), then copies
 * the chosen entry's demo template into it and records the lead (`../ports.ts`, `LeadStore`).
 */
import type { DemoEntrySlug } from '@indx-workspace/contracts/demo';

import type { RuntimeProfileStoreProvider } from '../../execution';

/** A runtime driver id a profile can be made on. */
export type DemoRuntimeDriver = Parameters<
  ReturnType<RuntimeProfileStoreProvider['forWorkspace']>['create']
>[0]['driver'];

/**
 * What a visitor's demo runs on, from the deployment (internal spec, "How Try it works"): the
 * runtime driver the deployment launches runs with, which the demo's runtime profile is made on,
 * and the Anthropic API key the demo's `default` model connection holds. Either is `null` where the
 * deployment has none, and a copy then has no profile or no connection, so a run start is refused
 * (`missingRuntimeProfile`, or the model's missing `default` connection): it fails closed.
 */
export interface DemoSandbox {
  readonly runtimeDriver: DemoRuntimeDriver | null;
  readonly anthropicApiKey: string | null;
  /**
   * Whether `driver` can enforce the network policy `none`. A driver that cannot gets no demo
   * profile, so the copy is refused with `agent_runtime_profile_missing` rather than run with the
   * host's network.
   */
  readonly enforcesNoNetwork: (driver: DemoRuntimeDriver) => Promise<boolean>;
  /**
   * Give the workspace a current Test Runtime pass of `driver`, which a run there needs and its
   * guest cannot make: the runtimes domain carries this deployment's current pass, or runs Test
   * Runtime for the workspace now. It resolves either way; without a pass, a run there is refused
   * with `runtime_not_verified`.
   */
  readonly verifyRuntime: (workspaceId: string, driver: DemoRuntimeDriver) => Promise<void>;
}

/**
 * The per-run caps set on the visitor's copy of the demo agent, from the deployment's settings
 * (`AW_DEMO_MAX_TURNS_PER_RUN`, `AW_DEMO_MAX_COST_PER_RUN_USD`). `null` while the setting is unset:
 * the copy keeps the template agent's own limit, and the run caps refuse every demo run start
 * (`demo_caps_unconfigured`) until it is set.
 */
export interface DemoRunLimits {
  readonly maxTurns: number | null;
  readonly maxBudgetUsd: number | null;
}

/**
 * The demo templates: one workspace per catalog entry (`demoTemplateWorkspaceSlug(entry)`), which
 * the deployment fills with the entry's demo agent and its `demo.seed` sample data. Production
 * reads and writes through the agents and files domains, never around them; tests use memory.
 */
export interface DemoTemplates {
  /** Whether `entry` has a template to copy. Checked before a link is sent or consumed. */
  exists(entry: DemoEntrySlug): Promise<boolean>;
  /**
   * Copy `entry`'s template into the demo workspace `workspaceId`: the demo agent, with its turns
   * and budget no wider than `limits` (nor than the template agent's own), and the sample files the
   * agent reads; then grant `guestUserId` the right to run that agent. A tool of the agent that
   * would send or write outside answers `DEMO_SEND_RESULT` and does nothing. Copying an entry the
   * workspace already holds adds nothing.
   */
  copyInto(input: {
    readonly entry: DemoEntrySlug;
    readonly workspaceId: string;
    readonly guestUserId: string;
    readonly limits: DemoRunLimits;
    readonly now: Date;
  }): Promise<void>;
  /**
   * Copy `entry`'s template into the ordinary workspace `workspaceId`, made exactly as
   * {@link copyInto} makes a visitor's copy (the stand-ins, the no-internet sandbox profile, the
   * `default` connection with the demo key, the caps), with its Owner `ownerUserId` in the guest's
   * place: the real-model verification workspace (R1) and the daily test's (`verification.ts`).
   */
  copyIntoVerification(input: {
    readonly entry: DemoEntrySlug;
    readonly workspaceId: string;
    readonly ownerUserId: string;
    readonly limits: DemoRunLimits;
    readonly now: Date;
  }): Promise<void>;
}

/**
 * The binder the email-link sign-in calls (`GuestWorkspaceBinder`, `../../email-link/ports.ts`),
 * stated here by its shape: a context other than identity may not import from the sign-in's
 * folders (`pnpm architecture:check`), and the composition root, which may, hands the provisioner
 * to the sign-in, where the compiler checks the two shapes agree.
 */
export interface DemoGuestBinder {
  bind(input: {
    readonly email: string;
    readonly now: Date;
    readonly entry?: DemoEntrySlug;
  }): Promise<{
    readonly userId: string;
    readonly workspaceId: string;
    readonly workspaceSlug: string;
    readonly created: boolean;
  } | null>;
  /** Whether `entry` has a demo template to provision. */
  hasEntry(entry: DemoEntrySlug): Promise<boolean>;
}
