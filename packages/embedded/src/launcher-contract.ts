import type { LocalRuntimeStartMessage } from '@indx-workspace/contracts/local-runtime';
import type { MembershipRoleName } from '@indx-workspace/contracts/team';

import type { LoopbackPortState } from './embedded-db.js';
import { type LauncherSignal } from './launcher-signals.js';
import type { LocalRuntimeProfileDriver } from './local-runtime-profile.js';
import { type RuntimeLock } from './runtime-lock.js';
import { type LocalRuntimeChannel } from './runtime-messages.js';
import type { WorkspaceOptions } from './workspace.js';

/** What the launcher needs from a started workspace (`startWorkspace`). */
interface LauncherWorkspace {
  readonly url: string;
  readonly seed: { readonly workspaceId: string; readonly adminUserId: string };
  close(): Promise<void>;
}

/** The bootstrap admin's membership, as `resolveMembership` answers it. */
interface LauncherMembership {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: MembershipRoleName;
}

/** What the launcher needs from the database root (`openDatabaseRoot`). */
export interface LauncherDatabaseRoot<Directory> {
  readonly directory: Directory;
  resolveMembership(email: string, workspaceSlug: string): Promise<LauncherMembership | null>;
  close(): Promise<void>;
}

/**
 * What preparing the `local` runtime profile answered (core's `ensureWorkspaceDefault`): `kept`,
 * `adopted` and `created` let the start continue as they are; `name-conflict` and `unenforceable`
 * are warned about, and the start continues with no default. Under the docker sandbox anything but
 * a default on the docker driver refuses the start (#786).
 */
export type LauncherRuntimeProfileOutcome =
  | { readonly kind: 'kept' | 'adopted' | 'created'; readonly profile: { readonly driver: string } }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | {
      readonly kind: 'unenforceable';
      readonly name: string;
      readonly settings: readonly string[];
    };

/** Whom the credential is issued for; the issuer reads the member's role itself. */
interface LauncherCredentialSubject {
  readonly workspaceId: string;
  readonly userId: string;
}

/** What the launcher needs from an issued credential (`issueLocalApiKey`). */
interface LauncherCredential {
  readonly token: string;
  readonly expiresAt: Date;
  /** `revoked`, `already-revoked`, or `missing` (the row no longer exists). */
  revoke(): Promise<'revoked' | 'already-revoked' | 'missing'>;
}

export interface LocalLauncherDeps<
  Directory,
  Root extends LauncherDatabaseRoot<Directory> = LauncherDatabaseRoot<Directory>,
> {
  readonly channel: LocalRuntimeChannel;
  /** The environment the services read; `process.env` in production. */
  readonly env: Record<string, string | undefined>;
  readonly stdout: (chunk: string) => void;
  readonly stderr: (chunk: string) => void;
  readonly chdir: (directory: string) => void;
  /** Loads a `.env` file into the environment when it exists (`loadDotEnv`). */
  readonly loadDotEnv: (file: string) => void;
  /**
   * Whether `127.0.0.1:port` can be bound (`loopbackPortState`). Every port the services will bind
   * is checked before any starts, so all the busy ones are reported together (issue #660).
   */
  readonly portState: (port: number) => Promise<LoopbackPortState>;
  readonly startWorkspace: (options: WorkspaceOptions) => Promise<LauncherWorkspace>;
  readonly assertServerServesContracts: (url: string) => Promise<void>;
  readonly openDatabaseRoot: (env: Readonly<Record<string, string | undefined>>) => Promise<Root>;
  /**
   * Ensure the workspace's `local` runtime profile and make it the default when none is chosen
   * (`prepareLocalRuntimeProfile`, S1-22). Runs after the membership check, before the key.
   */
  readonly prepareLocalRuntimeProfile: (
    workspaceId: string,
    root: Root,
    driver: LocalRuntimeProfileDriver,
  ) => Promise<LauncherRuntimeProfileOutcome>;
  /**
   * ADR-0161 amendment DI8 (issue #2075): link the development issuer's `(issuer, subject)` to the
   * bootstrap Owner, idempotently (`directory.linkIdentity`). Runs only when `start` carries
   * `devIssuer`, in the local posture, after the membership check.
   */
  readonly linkIdentity: (
    root: Root,
    identity: { readonly issuer: string; readonly subject: string; readonly userId: string },
  ) => Promise<void>;
  /** Mints the local workspace API key (`issueLocalApiKey`); the key's `revoke` withdraws it. */
  readonly issueLocalCredential: (
    input: LauncherCredentialSubject,
    deps: { readonly directory: Directory },
  ) => Promise<LauncherCredential>;
  readonly onSignal: (signal: LauncherSignal, listener: () => void) => void;
  /**
   * Leave the listeners `onSignal` registered as the only listeners for every {@link LauncherSignal}.
   * Called once the workspace has started: starting it loads `embedded-postgres`, whose `async-exit-hook`
   * stops the database on those signals at the same moment the launcher begins to revoke the
   * credential, so the revocation raced a database already shutting down and could be lost, leaving
   * the token valid on the next start. The launcher's own stop closes the database after revoking.
   */
  readonly claimSignals: () => void;
  readonly exit: (code: number) => void;
  /** The production Next build (`dist/web`). */
  readonly webDir: string;
  /** The shipped migrations (`dist/migrations`). */
  readonly migrationsDir: string;
  readonly startTimeoutMs?: number;
  /** The deadline for the whole start after `start` arrived (default five minutes). */
  readonly startupTimeoutMs?: number;
  /** How long a stop during the start waits for the step in progress (default ten seconds). */
  readonly stopGraceMs?: number;
  /** The project's runtime pid file (issue #560); `createRuntimeLock()` by default. */
  readonly runtimeLock?: RuntimeLock;
}

export type LauncherStep = <T>(work: Promise<T>) => Promise<T>;

export interface LauncherResources<Directory, Root extends LauncherDatabaseRoot<Directory>> {
  running: LauncherWorkspace | undefined;
  root: Root | undefined;
  credential: LauncherCredential | undefined;
  lockedProjectDir: string | undefined;
}

interface LauncherLifecycle<Directory, Root extends LauncherDatabaseRoot<Directory>> {
  readonly state: LauncherResources<Directory, Root>;
  readonly lock: RuntimeLock;
  release(): Promise<void>;
  stop(): Promise<void>;
}

export interface LauncherStartupContext<Directory, Root extends LauncherDatabaseRoot<Directory>> {
  readonly deps: LocalLauncherDeps<Directory, Root>;
  readonly lifecycle: LauncherLifecycle<Directory, Root>;
  readonly interrupt: AbortController;
  pending: Promise<unknown>;
  deadline: ReturnType<typeof setTimeout> | undefined;
  foreignHolder: number | undefined;
  started: boolean;
  readonly step: LauncherStep;
  readonly requestStop: () => void;
}

export interface LauncherProject {
  readonly start: LocalRuntimeStartMessage;
  readonly signInSecrets: { readonly path: string; readonly passwordFromFile: boolean };
}

export interface LauncherServices<Directory, Root extends LauncherDatabaseRoot<Directory>> {
  readonly workspace: LauncherWorkspace;
  readonly database: Root;
  readonly sandbox: LocalRuntimeProfileDriver;
}
