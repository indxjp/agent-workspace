// Types for the fake ERP the tests start; see fake-erp.mjs.
export const BASE_PATH: string;

export interface FakeErp {
  /** The API's base URL on loopback, ending in `/api/v1`. */
  readonly url: string;
  /** Every request the ERP received, in order: method and path with its query, and a write's parsed body. */
  readonly requests: readonly {
    readonly method: string;
    readonly path: string;
    readonly body?: unknown;
    /** Who the write was made for, from the verified identity assertion. */
    readonly by?: string;
  }[];
  readonly close: () => Promise<void>;
}

export function startFakeErp(options: {
  readonly token: string;
  /** What verifies the caller's `x-aw-identity` header; `key` may be a list while the secret rotates. */
  readonly identity: {
    readonly key: string | readonly string[];
    readonly audience: string;
    readonly workspace: string;
  };
  readonly port?: number;
  readonly dataDir?: string;
}): Promise<FakeErp>;
