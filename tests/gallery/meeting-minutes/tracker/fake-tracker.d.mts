// Types for the fake tracker the tests start; see fake-tracker.mjs.
export const BASE_PATH: string;

export interface FakeTracker {
  /** The API's base URL on loopback, ending in `/api/v1`. */
  readonly url: string;
  /** Every request the tracker received, in order: method and path, and a write's parsed body. */
  readonly requests: readonly {
    readonly method: string;
    readonly path: string;
    readonly body?: unknown;
  }[];
  readonly close: () => Promise<void>;
}

export function startFakeTracker(options: {
  readonly token: string;
  /** What verifies the caller's `x-aw-identity` header; `key` may be a list while the secret rotates. */
  readonly identity: {
    readonly key: string | readonly string[];
    readonly audience: string;
    readonly workspace: string;
  };
  /** Persist the tasks as a JSON array here, for `mcp/tasks.mjs` to list. */
  readonly tasksFile?: string;
  readonly port?: number;
  readonly membersFile?: string;
  readonly accessFile?: string;
}): Promise<FakeTracker>;
