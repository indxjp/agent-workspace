// Types for the fake ERP the tests start; see fake-erp.mjs.
export const BASE_PATH: string;

export interface FakeErp {
  /** The API's base URL on loopback, ending in `/api/v1`. */
  readonly url: string;
  /** Every request the ERP received, in order: method and path with its query. */
  readonly requests: readonly { readonly method: string; readonly path: string }[];
  readonly close: () => Promise<void>;
}

export function startFakeErp(options: {
  readonly token: string;
  readonly port?: number;
  readonly dataDir?: string;
}): Promise<FakeErp>;
