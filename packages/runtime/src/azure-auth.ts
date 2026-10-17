/** Authentication helpers for Azure Container Apps dynamic sessions. */
import { DefaultAzureCredential } from '@azure/identity';

/** The only OAuth scope accepted by the dynamic sessions data plane. */
export const ACA_SESSIONS_TOKEN_SCOPE = 'https://dynamicsessions.io/.default';

/** Structural subset of Azure's TokenCredential, kept small so callers can inject a fake. */
export interface AzureTokenCredential {
  getToken(scopes: string | readonly string[]): Promise<Readonly<{ token: string }> | null>;
}

export type AcaSessionsAccessTokenProvider = () => Promise<string>;

/**
 * Bind a credential to the dynamic sessions audience.
 *
 * The scope is deliberately not configurable: accepting an ARM token here would fail at Azure,
 * and accepting arbitrary scopes makes it easier to forward a powerful token to the session pool
 * by mistake.
 */
export function createAcaSessionsAccessTokenProvider(
  credential: AzureTokenCredential,
): AcaSessionsAccessTokenProvider {
  return async () => {
    const result = await credential.getToken(ACA_SESSIONS_TOKEN_SCOPE);
    if (result === null || typeof result.token !== 'string' || result.token.length === 0) {
      throw new Error('aca-sessions runtime: Azure credential returned no access token.');
    }
    return result.token;
  };
}

let sharedProvider: AcaSessionsAccessTokenProvider | undefined;

/**
 * Use Azure's standard credential chain (managed identity in Container Apps; developer identity
 * locally) to obtain a data-plane token. The credential caches tokens internally.
 */
export async function fetchAcaSessionsAccessToken(): Promise<string> {
  sharedProvider ??= createAcaSessionsAccessTokenProvider(new DefaultAzureCredential());
  return await sharedProvider();
}
