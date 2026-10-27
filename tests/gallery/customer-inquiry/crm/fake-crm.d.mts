// Types for the fake CRM the tests start; see fake-crm.mjs.
export const BASE_PATH: string;

export interface FakeCrm {
  /** The API's base URL on loopback, ending in `/api/v1`. */
  readonly url: string;
  /** Every request the CRM received, in order: method and path with its query. */
  readonly requests: readonly { readonly method: string; readonly path: string }[];
  readonly close: () => Promise<void>;
}

export function startFakeCrm(options: {
  /** The connector's credential, expected as `Authorization: Bearer`. */
  readonly token: string;
  /** The key the identity assertions are signed with (the connector's `identity` secret). */
  readonly key: string;
  /** The id of the connector the assertions are signed for. */
  readonly connectorId: string;
  readonly workspace: string;
  readonly port?: number;
  readonly dataDir?: string;
}): Promise<FakeCrm>;
