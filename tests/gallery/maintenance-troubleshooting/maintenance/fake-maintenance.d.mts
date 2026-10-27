// Types for the fake maintenance system the tests start; see fake-maintenance.mjs.
export const BASE_PATH: string;

export interface FakeMaintenance {
  /** The API's base URL on loopback, ending in `/api/v1`. */
  readonly url: string;
  /** Every request the system received, in order: method and path, and a write's parsed body. */
  readonly requests: readonly {
    readonly method: string;
    readonly path: string;
    readonly body?: unknown;
  }[];
  readonly close: () => Promise<void>;
}

export function startFakeMaintenance(options: {
  readonly token: string;
  /** What verifies the caller's `x-aw-identity` header; `key` may be a list while the secret rotates. */
  readonly identity: {
    readonly key: string | readonly string[];
    readonly audience: string;
    readonly workspace: string;
  };
  /** Persist the logged cases as a JSON array here, until an expert reviews them. */
  readonly storeFile: string;
  readonly port?: number;
  readonly troubleDir?: string;
  readonly accessFile?: string;
}): Promise<FakeMaintenance>;
