import type { SetupProvider } from '@indx-workspace/contracts/setup';

import type { SessionCookie } from '../auth/session';

export interface SetupInput {
  provider: SetupProvider;
  providerApiKey: string;
  /** Where the provider answers instead of its public API; first-run setup only. */
  providerBaseUrl?: string;
  runtime: string;
  /**
   * The provider key and endpoint of the runtime's default driver (`external`, `vercel-sandbox`,
   * `cloudflare-sandbox`), stored as setup's encrypted runtime connection. Both or neither.
   */
  runtimeCredential?: string;
  runtimeEndpoint?: string;
  adminEmail: string;
  adminPassword: string;
  agentName: string;
  agentInstructions: string;
}

export type SetupResult =
  | {
      ok: true;
      agentId: string;
      modelConnectionId: string;
      runtimeProfileId: string;
      /** The runtime connection setup stored, or `null` when the driver takes no provider key. */
      runtimeConnectionId: string | null;
      /**
       * Set when the runtime test was refused with `network_policy_unsupported` (ADR-0131): setup
       * completed, and runs stay refused with that code until the driver declares a policy.
       */
      runtimeRefusal?: Readonly<{ code: 'network_policy_unsupported'; message: string }>;
      token: string;
      cookie: SessionCookie;
    }
  | { ok: false; status: number; code: string; message: string };

export interface SetupRuntime {
  complete(input: SetupInput): Promise<SetupResult>;
}

/**
 * First-run setup as the application context holds it. It stores the model key encrypted, so it is
 * `unavailable` whenever encrypted model storage did not start; `POST /api/setup` then answers its
 * `503 setup_unavailable`, as it does with no context installed.
 */
export type Setup =
  { readonly kind: 'serving'; readonly runtime: SetupRuntime } | { readonly kind: 'unavailable' };
